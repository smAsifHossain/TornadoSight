/**
 * Image screening, entirely in the browser.
 *
 * A ConvNeXt-Tiny backbone produces a feature vector and a small linear head
 * trained on top of it returns the probability that a photograph shows a
 * tornado. Both run on the responder's own device through ONNX Runtime Web,
 * which has three consequences that matter:
 *
 *  - The photograph never leaves the device. There is no upload endpoint,
 *    because there is no server. A citizen's picture of their own street stays
 *    on the machine it was dropped onto.
 *  - Inference costs nothing to operate, at any volume.
 *  - It keeps working when the network does not, which is exactly when severe
 *    weather response needs it.
 *
 * The 29 MB backbone is fetched lazily, only once a photograph is actually
 * submitted, so the dashboard itself stays light on a phone.
 */

import * as ort from 'onnxruntime-web';

const BASE = import.meta.env.BASE_URL ?? '/';
const MODEL_URL = `${BASE}models/convnext-tiny-224-int8.onnx`;
const HEAD_URL = `${BASE}models/head.json`;
const SIZE = 224;

/** ImageNet statistics, matching how the backbone was trained. */
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export interface ModelHead {
  weights: number[];
  bias: number;
  /**
   * Probabilities between these bounds are reported as uncertain rather than
   * forced into a call. An abstention band is more useful to a triage operator
   * than a confident coin flip.
   */
  uncertainLow: number;
  uncertainHigh: number;
  metrics: {
    accuracy: number;
    precision: number;
    recall: number;
    f1: number;
    rocAuc: number;
    brier: number;
    trainSize: number;
    testSize: number;
  };
  trainedAt: string;
}

export interface ScreeningResult {
  probability: number;
  uncertain: boolean;
  label: 'Likely tornado visual evidence' | 'Uncertain, needs review' | 'Unlikely tornado visual evidence';
  elapsedMs: number;
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;
let headPromise: Promise<ModelHead> | null = null;

export function modelIsWarm(): boolean {
  return sessionPromise !== null;
}

function loadSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  }
  return sessionPromise;
}

function loadHead(): Promise<ModelHead> {
  if (!headPromise) {
    headPromise = fetch(HEAD_URL).then((r) => {
      if (!r.ok) throw new Error('The trained screening head could not be loaded.');
      return r.json() as Promise<ModelHead>;
    });
  }
  return headPromise;
}

/** Fetch the backbone ahead of time, for instance when the intake form opens. */
export function warmUp(): void {
  void loadSession().catch(() => undefined);
  void loadHead().catch(() => undefined);
}

/**
 * Resize so the short side is 224, centre crop, then normalise into the
 * channel first layout the backbone expects. Centre cropping rather than
 * squashing matters here: stretching a landscape photograph distorts the
 * funnel's aspect ratio, which is most of what distinguishes it from a shelf
 * cloud.
 */
export async function preprocess(source: Blob): Promise<Float32Array> {
  const bitmap = await createImageBitmap(source);
  const scale = SIZE / Math.min(bitmap.width, bitmap.height);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser did not provide a 2D canvas context.');

  ctx.drawImage(bitmap, Math.round((SIZE - w) / 2), Math.round((SIZE - h) / 2), w, h);
  bitmap.close();

  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
  const out = new Float32Array(3 * SIZE * SIZE);
  const plane = SIZE * SIZE;
  for (let i = 0; i < plane; i++) {
    out[i] = (data[i * 4] / 255 - MEAN[0]) / STD[0];
    out[plane + i] = (data[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
    out[2 * plane + i] = (data[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
  }
  return out;
}

/** L2 normalise, so the head sees vectors of consistent magnitude. */
export function l2normalize(v: Float32Array | number[]): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

export function sigmoid(x: number): number {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

export function labelFor(probability: number, head: ModelHead): ScreeningResult['label'] {
  if (probability >= head.uncertainHigh) return 'Likely tornado visual evidence';
  if (probability <= head.uncertainLow) return 'Unlikely tornado visual evidence';
  return 'Uncertain, needs review';
}

export async function screenImage(photo: Blob): Promise<ScreeningResult> {
  const started = performance.now();
  const [session, head, pixels] = await Promise.all([loadSession(), loadHead(), preprocess(photo)]);

  const input = new ort.Tensor('float32', pixels, [1, 3, SIZE, SIZE]);
  const output = await session.run({ [session.inputNames[0]]: input });
  const logits = output[session.outputNames[0]].data as Float32Array;

  const features = l2normalize(logits);
  let z = head.bias;
  for (let i = 0; i < features.length; i++) z += features[i] * head.weights[i];
  const probability = sigmoid(z);

  return {
    probability,
    uncertain: probability > head.uncertainLow && probability < head.uncertainHigh,
    label: labelFor(probability, head),
    elapsedMs: performance.now() - started,
  };
}

export async function headMetrics(): Promise<ModelHead['metrics'] | null> {
  try {
    return (await loadHead()).metrics;
  } catch {
    return null;
  }
}
