/**
 * Assemble the image screening dataset from Wikimedia Commons.
 *
 * Two deliberate choices.
 *
 * First, licensing. The Phase 2 concept listed CNN, AccuWeather, Fox News and a
 * storm chasing video site among its sources. Those are not openly licensed,
 * and "responsible data handling" is one of the five scored criteria, so none
 * of them are used. Every image here carries a recorded licence and author in
 * data/dataset/manifest.json, and anything without a free licence is dropped.
 *
 * Second, the negatives are hard negatives. A classifier trained to separate
 * tornadoes from random photographs learns "is this a dramatic sky", which is
 * useless to a responder: every shelf cloud and rain shaft would come back as a
 * tornado. The negative classes here are exactly the things the concept says
 * get mistaken for tornadoes, wall clouds, shelf clouds, mammatus, rain shafts,
 * dust plumes, so the model has to learn the funnel itself.
 *
 *   node scripts/build-dataset.mjs --limit 700
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const API = 'https://commons.wikimedia.org/w/api.php';
const UA =
  'TornadoSight/0.1 (https://github.com/smAsifHossain/TornadoSight; IEEE Response Quest research prototype)';
const THUMB_PX = 384;

const POSITIVE = [
  { cat: 'Tornadoes', depth: 3 },
  { cat: 'Funnel_clouds', depth: 2 },
  { cat: 'Landspouts', depth: 1 },
  { cat: 'Waterspouts', depth: 2 },
];

/**
 * Shallow on purpose. Depth 3 on a category like Cumulonimbus or Rain walks
 * tens of thousands of files and takes longer than it is worth, while the
 * negatives that actually teach the model something are the specific cloud
 * forms a spotter confuses with a funnel. Quality of confusion beats volume.
 */
const NEGATIVE = [
  { cat: 'Shelf_clouds', depth: 1 },
  { cat: 'Wall_clouds', depth: 1 },
  { cat: 'Mammatus_clouds', depth: 1 },
  { cat: 'Arcus_clouds', depth: 1 },
  { cat: 'Funnel-shaped_clouds', depth: 1 },
  { cat: 'Cumulonimbus_clouds_by_country', depth: 1 },
  { cat: 'Supercells', depth: 1 },
  { cat: 'Squall_lines', depth: 1 },
  { cat: 'Rain_shafts', depth: 1 },
  { cat: 'Virga', depth: 1 },
  { cat: 'Dust_devils', depth: 1 },
  { cat: 'Haboobs', depth: 1 },
  { cat: 'Smoke_plumes', depth: 1 },
  { cat: 'Storm_clouds', depth: 1 },
  { cat: 'Thunderstorms_by_country', depth: 1 },
  { cat: 'Dark_clouds', depth: 1 },
];

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
    process.stdout.write(`  checking licences of ${files.size} files `);
    // Ask for headroom over the download limit so rejects do not starve the class.
    described = await describe([...files].sort(), Math.ceil(limit * 1.6), cacheFile);
    console.log(`\n  ${described.length} freely licensed`);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify(described));
  }

  // Sorted rather than shuffled, so a rerun selects exactly the same images.
  described.sort((a, b) => (a.title < b.title ? -1 : 1));
  return download(described, path.join(root, name), limit);
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
