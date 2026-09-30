/**
 * Assemble the image screening dataset from Wikimedia Commons.
 *
 * Two deliberate choices.
 *
 * First, licensing. The Phase 2 concept listed CNN, AccuWeather, Fox News and a
 * storm chasing video site among its sources. Those are not openly licensed,
 * and responsible data handling is one of the five scored criteria, so none of
 * them are used. Every image carries a recorded licence and author in
 * data/dataset/manifest.json, and anything without a free licence is dropped.
 *
 * Second, the negatives are hard negatives. A classifier trained to separate
 * tornadoes from random photographs learns "is this a dramatic sky", which is
 * useless to a responder: every shelf cloud and rain shaft would come back as a
 * tornado. The negative classes here are the things a spotter genuinely
 * confuses with a funnel, so the model has to learn the funnel itself.
 *
 *   node scripts/build-dataset.mjs --limit 700
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const API = 'https://commons.wikimedia.org/w/api.php';
const UA =
  'TornadoSight/0.1 (https://github.com/smAsifHossain/TornadoSight; IEEE Response Quest research prototype)';
const THUMB_PX = 384;

/**
 * Positives are photographs of a funnel in the sky. The broad Tornadoes tree
 * was tried first and had to be abandoned: it is mostly damage surveys, path
 * maps, annual count charts and archival scans, none of which is what a spotter
 * points a phone at. Titles are filtered to the phenomenon and away from the
 * aftermath.
 */
const POSITIVE = [
  { cat: 'Funnel_clouds', depth: 1 },
  { cat: 'Waterspouts', depth: 2 },
  { cat: 'Landspouts', depth: 1 },
  { cat: 'Tornadoes_in_the_United_States', depth: 2 },
  { cat: 'Tornadoes_in_Canada', depth: 2 },
  { cat: 'Tornadoes_in_Europe', depth: 2 },
  { cat: 'Tornadoes_in_Australia', depth: 1 },
];

/**
 * Negatives are the cloud forms a spotter actually confuses with a funnel.
 * Shallow and specific: a broad category like Rain or Lightning drags in
 * paintings, rainfall maps and press photographs of unrelated subjects, and a
 * model trained against those learns to tell photographs from engravings.
 */
const NEGATIVE = [
  { cat: 'Shelf_clouds', depth: 2 },
  { cat: 'Wall_clouds', depth: 2 },
  { cat: 'Mammatus_clouds', depth: 2 },
  { cat: 'Arcus_clouds', depth: 2 },
  { cat: 'Cumulonimbus_clouds', depth: 2 },
  { cat: 'Supercells', depth: 2 },
  { cat: 'Squall_lines', depth: 1 },
  { cat: 'Virga', depth: 1 },
  { cat: 'Roll_clouds', depth: 1 },
  { cat: 'Dust_devils', depth: 2 },
  { cat: 'Haboobs', depth: 1 },
  { cat: 'Thunderstorm_clouds', depth: 1 },
];

/** Anything that is not a photograph of the sky. */
const NOT_A_SKY_PHOTO =
  /map|diagram|chart|graph|skew|sounding|radar|satellite|sigmet|damage|destroy|aftermath|debris|wreck|rubble|ruin|collaps|rebuild|recovery|shelter|memorial|monument|plaque|museum|poster|illustrat|drawing|engrav|painting|cartoon|sketch|lithograph|woodcut|etching|postcard|stamp|book|page|cover|logo|seal|portrait|statue|LCCN|DPLA|NARA|FEMA|census|newspaper|document|letter|report|sign|banner|count|track_map|path_of|cleanup|clean-up|after the|restoration|relief|Collection|STS[-_ ]?[0-9]{2}|shuttle|anniversar|survivor|victim|funeral|church|school bus|trailer|mobile home|path|track|reflectivity|dBZ|WSR-88D|velocity|Mars|sol [0-9]|Ingenuity|Eridania|Perseverance|Curiosity|crater|pickup|truck|barrel|light pole|prelim/i;

/**
 * Words that mark an image as showing the phenomenon itself.
 *
 * The Enhanced Fujita rating is included because cloud categories carry files
 * named only for their rating, such as "Portage EF2.jpg". Without it those land
 * in the negative class, which teaches the model that a tornado is not one.
 */
const IS_TORNADIC = /tornad|funnel|waterspout|landspout|twister|trombe|wirbel|\bEF[0-5]\b|\bEF-[0-5]\b/i;

/** Licences we accept. Anything else is discarded rather than guessed at. */
const FREE = /^(cc0|cc-by|cc-by-sa|pd|public domain|no restrictions)/i;

function arg(name, fallback) {
  const joined = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (joined) return joined.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wikimedia asks clients to identify themselves and to go easy on the API. We
 * serialise every call behind a small delay and back off hard on a 429 rather
 * than hammering a volunteer funded service.
 */
let nextSlot = 0;
async function throttle(ms = 1100) {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + ms;
  if (wait) await sleep(wait);
}

async function api(params, { post = false, attempt = 0 } = {}) {
  await throttle();
  const body = new URLSearchParams({ format: 'json', ...params });
  try {
    // Title batches are long enough to overflow a query string, so metadata
    // lookups go out as form posts. MediaWiki accepts reads either way.
    const res = post
      ? await fetch(API, {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        })
      : await fetch(`${API}?${body}`, { headers: { 'User-Agent': UA } });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      throw Object.assign(new Error('rate limited'), { retryAfter });
    }
    // A request too long will be too long every time. Retrying just burns the
    // clock, so fail fast and let the caller shrink the batch.
    if (res.status === 414) throw Object.assign(new Error('HTTP 414'), { fatal: true });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.fatal || attempt >= 6) throw err;
    const wait = err.retryAfter ? err.retryAfter * 1000 : 2000 * 2 ** attempt;
    console.warn(`\n  backing off ${Math.round(wait / 1000)}s after ${err.message}`);
    await sleep(wait);
    return api(params, { post, attempt: attempt + 1 });
  }
}

/** Walk a category and its subcategories, collecting image file titles. */
async function collect(category, depth, seen = new Set(), files = new Set()) {
  if (depth < 0 || seen.has(category)) return files;
  seen.add(category);

  let cont;
  do {
    const data = await api({
      action: 'query',
      list: 'categorymembers',
      cmtitle: `Category:${category}`,
      cmlimit: '500',
      cmtype: 'file|subcat',
      ...(cont ? { cmcontinue: cont } : {}),
    });
    for (const m of data.query?.categorymembers ?? []) {
      if (m.ns === 6 && /\.(jpe?g|png)$/i.test(m.title)) files.add(m.title);
      else if (m.ns === 14 && depth > 0) {
        await collect(m.title.replace(/^Category:/, ''), depth - 1, seen, files);
      }
    }
    cont = data.continue?.cmcontinue;
  } while (cont && files.size < 6000);

  return files;
}

/**
 * Licence, author and a scaled thumbnail URL for a batch of file titles.
 * Stops as soon as `need` freely licensed candidates have been found, because
 * checking every one of several thousand titles takes far longer than the
 * dataset is improved by it.
 */
async function describe(titles, need = Infinity, checkpoint = null) {
  const out = [];
  let lastSave = 0;
  for (let i = 0; i < titles.length && out.length < need; i += 40) {
    const batch = titles.slice(i, i + 40);
    const data = await api(
      {
        action: 'query',
        titles: batch.join('|'),
        prop: 'imageinfo',
        iiprop: 'url|extmetadata|size',
        iiurlwidth: String(THUMB_PX),
      },
      { post: true },
    );
    for (const page of Object.values(data.query?.pages ?? {})) {
      const info = page.imageinfo?.[0];
      if (!info?.thumburl) continue;
      const meta = info.extmetadata ?? {};
      const licence = meta.LicenseShortName?.value ?? meta.License?.value ?? '';
      if (!FREE.test(licence.trim())) continue;
      if ((info.width ?? 0) < 200) continue;
      out.push({
        title: page.title,
        url: info.thumburl,
        page: info.descriptionurl,
        licence: licence.trim(),
        author: String(meta.Artist?.value ?? '')
          .replace(/<[^>]*>/g, '')
          .trim()
          .slice(0, 120),
      });
    }
    process.stdout.write('.');
    if (checkpoint && out.length - lastSave >= 100) {
      lastSave = out.length;
      await fs.writeFile(checkpoint, JSON.stringify(out));
    }
  }
  return out;
}

/**
 * Resumable. Collecting several thousand titles and checking their licences
 * takes long enough that losing the work to one dropped connection is
 * intolerable, so metadata is cached and files already on disk are left alone.
 */
async function download(items, dir, limit) {
  await fs.mkdir(dir, { recursive: true });
  const present = new Set(await fs.readdir(dir).catch(() => []));
  const saved = [];
  let reused = 0;

  for (const item of items) {
    if (saved.length >= limit) break;
    const safe = item.title
      .replace(/^File:/, '')
      .replace(/[^a-z0-9.]+/gi, '_')
      .slice(-80);
    const file = path.join(dir, safe);

    if (present.has(safe)) {
      saved.push({ ...item, file: safe });
      reused++;
      continue;
    }

    try {
      await throttle(120);
      const res = await fetch(item.url, { headers: { 'User-Agent': UA } });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 2000) continue;
      await fs.writeFile(file, buf);
      saved.push({ ...item, file: safe });
      if (saved.length % 25 === 0) process.stdout.write(`\r    saved ${saved.length}`);
    } catch {
      /* one bad file should not end the run */
    }
  }
  process.stdout.write(`\r    ${saved.length} images (${reused} already on disk)   \n`);
  return saved;
}

const limit = Number(arg('limit', '700'));
const root = path.join(process.cwd(), 'data', 'dataset');

async function buildClass(name, groups) {
  console.log(`\n${name}`);
  const cacheFile = path.join(root, `.metadata-${name}.json`);
  let described = null;

  try {
    described = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    console.log(`  reusing cached metadata for ${described.length} files`);
  } catch {
    const files = new Set();
    for (const g of groups) {
      const before = files.size;
      await collect(g.cat, g.depth, new Set(), files);
      console.log(`  ${g.cat.padEnd(24)} +${files.size - before} (total ${files.size})`);
    }
    const wanted = [...files].filter((title) => keep(title, name));
    console.log(`  ${wanted.length} of ${files.size} look like photographs of the phenomenon`);

    process.stdout.write('  checking licences ');
    // Ask for headroom over the download limit so rejects do not starve the class.
    described = await describe(wanted.sort(), Math.ceil(limit * 1.6), cacheFile);
    console.log(`\n  ${described.length} freely licensed`);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify(described));
  }

  /**
   * Filter again here, not only before the licence lookup.
   *
   * The metadata cache is written before these rules existed on an earlier run,
   * and reusing it skipped the filtering entirely: the positives came back full
   * of path maps and radar grabs, and the negative class contained a
   * photograph captioned "EF4 tornado near Barnsdall, Oklahoma". Filtering at
   * the point of selection means the rules apply however the metadata arrived.
   */
  const before = described.length;
  described = described.filter((item) => keep(item.title, name));
  if (described.length !== before) {
    console.log(`  ${described.length} of ${before} pass the content filter`);
  }

  // Sorted rather than shuffled, so a rerun selects exactly the same images.
  described.sort((a, b) => (a.title < b.title ? -1 : 1));
  const saved = await download(described, path.join(root, name), limit);
  await prune(path.join(root, name), saved);
  return saved;
}

/** Whether a Commons title belongs in this class. */
function keep(title, className) {
  if (NOT_A_SKY_PHOTO.test(title)) return false;
  // Positives must name the phenomenon. Negatives must not: a category such as
  // Wall clouds legitimately contains tornado photographs, and leaving those in
  // the negative class teaches the model the opposite of the truth.
  return className === 'tornado' ? IS_TORNADIC.test(title) : !IS_TORNADIC.test(title);
}

/** Delete images left behind by an earlier, less strict selection. */
async function prune(dir, saved) {
  const keepNames = new Set(saved.map((s) => s.file));
  let removed = 0;
  for (const file of await fs.readdir(dir).catch(() => [])) {
    if (keepNames.has(file)) continue;
    await fs.unlink(path.join(dir, file)).catch(() => undefined);
    removed++;
  }
  if (removed) console.log(`  removed ${removed} images that no longer qualify`);
}

const tornado = await buildClass('tornado', POSITIVE);
const nonTornado = await buildClass('non_tornado', NEGATIVE);

await fs.writeFile(
  path.join(root, 'manifest.json'),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      source: 'Wikimedia Commons',
      note:
        'Every image is freely licensed and its licence and author are recorded below. ' +
        'Non-free press and stock sources are deliberately excluded. Negatives are hard ' +
        'negatives: the cloud forms that are commonly mistaken for tornadoes.',
      counts: { tornado: tornado.length, non_tornado: nonTornado.length },
      licences: [...new Set([...tornado, ...nonTornado].map((i) => i.licence))].sort(),
      images: { tornado, non_tornado: nonTornado },
    },
    null,
    2,
  ),
);

console.log(`\nDataset: ${tornado.length} tornado, ${nonTornado.length} non tornado`);
console.log(`Manifest written to ${path.join(root, 'manifest.json')}`);
