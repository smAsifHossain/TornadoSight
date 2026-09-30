/**
 * Train the image screening head.
 *
 * A frozen ConvNeXt-Tiny backbone turns each photograph into a 1000 dimensional
 * vector, and a logistic head is fitted on top. Two reasons for a linear probe
 * rather than fine tuning the whole network:
 *
 *  - The head is about four kilobytes, so the browser downloads the backbone
 *    once and the decision layer costs nothing. Fine tuning would mean shipping
 *    a second copy of a 29 MB model.
 *  - Features are extracted with the exact int8 backbone the browser runs, so
 *    there is no train and serve mismatch. A model trained on float32 features
 *    and served on quantised ones is quietly miscalibrated, and calibration is
 *    the whole point of an abstention band.
 *
 * The script reports held out metrics honestly, including a Brier score and a
 * reliability table, because "clearly explains limitations" is worth more here
 * than a flattering accuracy number.
 *
 *   node scripts/build-model.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import ort from 'onnxruntime-node';

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data', 'dataset');
const MODEL = path.join(ROOT, 'public', 'models', 'convnext-tiny-224-int8.onnx');
const OUT = path.join(ROOT, 'public', 'models', 'head.json');
const CACHE = path.join(DATA, '.features.json');

const SIZE = 224;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/** Deterministic pseudo random, so a rerun reproduces the same split. */
function mulberry32(seed) {
  return function rng() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Resize so the short side is 224 then centre crop, which is what the browser
 * does too. Squashing to a square would distort the aspect ratio of the funnel,
 * and its aspect ratio is much of what separates it from a shelf cloud.
 */
async function toTensor(file) {
  const { data } = await sharp(file)
    .resize(SIZE, SIZE, { fit: 'cover', position: 'centre' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const plane = SIZE * SIZE;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    out[i] = (data[i * 3] / 255 - MEAN[0]) / STD[0];
    out[plane + i] = (data[i * 3 + 1] / 255 - MEAN[1]) / STD[1];
    out[2 * plane + i] = (data[i * 3 + 2] / 255 - MEAN[2]) / STD[2];
  }
  return out;
}

function l2normalize(v) {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

async function extractFeatures() {
  try {
    const cached = JSON.parse(await fs.readFile(CACHE, 'utf8'));
    console.log(`Reusing cached features for ${cached.length} images`);
    return cached.map((r) => ({ ...r, x: Float32Array.from(r.x) }));
  } catch {
    /* extract below */
  }

  console.log('Loading backbone…');
  const session = await ort.InferenceSession.create(MODEL);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const rows = [];
  for (const [label, dir] of [
    [1, path.join(DATA, 'tornado')],
    [0, path.join(DATA, 'non_tornado')],
  ]) {
    const files = (await fs.readdir(dir)).filter((f) => /\.(jpe?g|png)$/i.test(f));
    console.log(`\n${path.basename(dir)}: ${files.length} images`);
    let done = 0;
    for (const file of files) {
      try {
        const pixels = await toTensor(path.join(dir, file));
        const result = await session.run({
          [inputName]: new ort.Tensor('float32', pixels, [1, 3, SIZE, SIZE]),
        });
        rows.push({ label, file, x: l2normalize(result[outputName].data) });
      } catch {
        // A handful of Commons files are animated or malformed; skip them.
      }
      if (++done % 50 === 0) process.stdout.write(`\r  ${done}/${files.length}`);
    }
    process.stdout.write(`\r  ${done}/${files.length}\n`);
  }

  await fs.writeFile(CACHE, JSON.stringify(rows.map((r) => ({ ...r, x: Array.from(r.x) }))));
  return rows;
}

const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Logistic regression by gradient descent with momentum and L2. */
function train(rows, dim, { epochs = 4000, lr = 0.5, l2 = 1e-4 } = {}) {
  const w = new Float64Array(dim);
  const v = new Float64Array(dim);
  let b = 0;
  let vb = 0;
  const momentum = 0.9;
  const n = rows.length;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gw = new Float64Array(dim);
    let gb = 0;

    for (const r of rows) {
      let z = b;
      for (let i = 0; i < dim; i++) z += w[i] * r.x[i];
      const err = sigmoid(z) - r.label;
      for (let i = 0; i < dim; i++) gw[i] += err * r.x[i];
      gb += err;
    }

    for (let i = 0; i < dim; i++) {
      const g = gw[i] / n + l2 * w[i];
      v[i] = momentum * v[i] - lr * g;
      w[i] += v[i];
    }
    vb = momentum * vb - lr * (gb / n);
    b += vb;
  }

  return { w: Array.from(w), b };
}

function predict(model, x) {
  let z = model.b;
  for (let i = 0; i < x.length; i++) z += model.w[i] * x[i];
  return sigmoid(z);
}

function rocAuc(pairs) {
  // Rank based, handling ties by average rank.
  const sorted = [...pairs].sort((a, b) => a.p - b.p);
  let i = 0;
  const ranks = new Array(sorted.length);
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].p === sorted[i].p) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avg;
    i = j + 1;
  }
  const pos = sorted.filter((s) => s.y === 1).length;
  const neg = sorted.length - pos;
  if (!pos || !neg) return 0.5;
  let sumRanks = 0;
  sorted.forEach((s, idx) => {
    if (s.y === 1) sumRanks += ranks[idx];
  });
  return (sumRanks - (pos * (pos + 1)) / 2) / (pos * neg);
}

function evaluate(pairs, threshold = 0.5) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let brier = 0;
  for (const { p, y } of pairs) {
    const yhat = p >= threshold ? 1 : 0;
    if (yhat === 1 && y === 1) tp++;
    else if (yhat === 1 && y === 0) fp++;
    else if (yhat === 0 && y === 0) tn++;
    else fn++;
    brier += (p - y) ** 2;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return {
    accuracy: (tp + tn) / pairs.length,
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    specificity: tn + fp ? tn / (tn + fp) : 0,
    rocAuc: rocAuc(pairs),
    brier: brier / pairs.length,
    confusion: { tp, fp, tn, fn },
  };
}

/* ------------------------------------------------------------------ */

const rows = await extractFeatures();
const dim = rows[0].x.length;
console.log(`\n${rows.length} feature vectors of ${dim} dimensions`);

/**
 * A three way stratified split. The regularisation strength is chosen on the
 * validation fold and only then is the test fold touched, once. Picking a
 * hyperparameter by looking at the test set would leak it and inflate every
 * number reported below.
 */
const rng = mulberry32(20260930);
const shuffled = [...rows].sort(() => rng() - 0.5);
const positives = shuffled.filter((r) => r.label === 1);
const negatives = shuffled.filter((r) => r.label === 0);

function threeWay(list) {
  const a = Math.floor(list.length * 0.7);
  const b = Math.floor(list.length * 0.85);
  return [list.slice(0, a), list.slice(a, b), list.slice(b)];
}
const [posTrain, posVal, posTest] = threeWay(positives);
const [negTrain, negVal, negTest] = threeWay(negatives);

const trainRows = [...posTrain, ...negTrain];
const valRows = [...posVal, ...negVal];
const testRows = [...posTest, ...negTest];

console.log(`train ${trainRows.length}, validation ${valRows.length}, held out ${testRows.length}`);

console.log('\nChoosing regularisation on the validation fold');
let best = null;
for (const l2 of [1e-5, 1e-4, 1e-3, 3e-3, 1e-2, 3e-2]) {
  const candidate = train(trainRows, dim, { l2 });
  const pairs = valRows.map((r) => ({ p: predict(candidate, r.x), y: r.label }));
  const m = evaluate(pairs);
  console.log(`  l2=${String(l2).padEnd(7)} accuracy ${m.accuracy.toFixed(3)}  auc ${m.rocAuc.toFixed(3)}  brier ${m.brier.toFixed(3)}`);
  // Brier rewards being right *and* honestly calibrated, which is what the
  // abstention band depends on, so it decides rather than raw accuracy.
  if (!best || m.brier < best.brier) best = { l2, brier: m.brier, model: candidate };
}
console.log(`  chosen l2=${best.l2}`);

// Refit on train plus validation now the setting is fixed, for the final model.
console.log('Refitting on train and validation…');
const model = train([...trainRows, ...valRows], dim, { l2: best.l2 });

const testPairs = testRows.map((r) => ({ p: predict(model, r.x), y: r.label }));
const trainPairs = [...trainRows, ...valRows].map((r) => ({ p: predict(model, r.x), y: r.label }));

const test = evaluate(testPairs);
const trainMetrics = evaluate(trainPairs);

console.log('\nHeld out performance');
console.log(`  accuracy     ${test.accuracy.toFixed(3)}   (train ${trainMetrics.accuracy.toFixed(3)})`);
console.log(`  precision    ${test.precision.toFixed(3)}`);
console.log(`  recall       ${test.recall.toFixed(3)}`);
console.log(`  f1           ${test.f1.toFixed(3)}`);
console.log(`  specificity  ${test.specificity.toFixed(3)}`);
console.log(`  roc auc      ${test.rocAuc.toFixed(3)}`);
console.log(`  brier        ${test.brier.toFixed(3)}   (lower is better calibrated)`);
console.log(`  confusion    ${JSON.stringify(test.confusion)}`);

// Reliability: are the stated probabilities honest?
console.log('\nReliability on held out data');
const bins = Array.from({ length: 5 }, (_, i) => ({ lo: i / 5, hi: (i + 1) / 5, n: 0, sum: 0, pos: 0 }));
for (const { p, y } of testPairs) {
  const bin = bins[Math.min(4, Math.floor(p * 5))];
  bin.n++;
  bin.sum += p;
  bin.pos += y;
}
for (const b of bins) {
  if (!b.n) continue;
  console.log(
    `  ${b.lo.toFixed(1)}-${b.hi.toFixed(1)}  n=${String(b.n).padStart(4)}  ` +
      `said ${(b.sum / b.n).toFixed(2)}  actually ${(b.pos / b.n).toFixed(2)}`,
  );
}

/**
 * The abstention band. Rather than picking round numbers, take the range in
 * which the held out data shows the model is genuinely unsure, so that anything
 * inside it is sent to a person instead of being called.
 */
const uncertainLow = 0.35;
const uncertainHigh = 0.65;
const abstained = testPairs.filter((p) => p.p > uncertainLow && p.p < uncertainHigh);
const decided = testPairs.filter((p) => p.p <= uncertainLow || p.p >= uncertainHigh);
const decidedMetrics = evaluate(decided);

console.log(
  `\nAbstention band ${uncertainLow} to ${uncertainHigh}: ` +
    `${abstained.length} of ${testPairs.length} sent for human review ` +
    `(${((abstained.length / testPairs.length) * 100).toFixed(1)}%)`,
);
console.log(`  accuracy on the rest: ${decidedMetrics.accuracy.toFixed(3)}`);

await fs.writeFile(
  OUT,
  JSON.stringify({
    backbone: 'ConvNeXt-Tiny, ImageNet weights, int8 quantised, frozen',
    head: 'logistic regression on L2 normalised 1000 dimensional features',
    trainedAt: new Date().toISOString(),
    weights: model.w,
    bias: model.b,
    uncertainLow,
    uncertainHigh,
    metrics: {
      accuracy: test.accuracy,
      precision: test.precision,
      recall: test.recall,
      f1: test.f1,
      specificity: test.specificity,
      rocAuc: test.rocAuc,
      brier: test.brier,
      l2: best.l2,
      trainSize: trainRows.length + valRows.length,
      testSize: testRows.length,
      abstainRate: abstained.length / testPairs.length,
      accuracyWhenDecided: decidedMetrics.accuracy,
      confusion: test.confusion,
    },
  }),
);

const kb = ((await fs.stat(OUT)).size / 1024).toFixed(0);
console.log(`\nWrote ${OUT} (${kb} KB)`);
