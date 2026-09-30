/**
 * Capture a real severe weather event from the National Weather Service archive
 * and commit it as a replay fixture.
 *
 * Why this exists: the live api.weather.gov archive only reaches back about a
 * month, and there is rarely a tornado warning in progress at the moment
 * someone sits down to watch a demonstration. Replay mode therefore plays back
 * genuine archived alerts, minute by minute, rather than inventing data. Every
 * polygon, motion vector and detection flag in the fixture is exactly what the
 * National Weather Service issued at the time.
 *
 *   node scripts/capture-replay.mjs --start 2026-09-25T19:00:00Z \
 *                                   --end   2026-09-26T01:00:00Z \
 *                                   --slug  clovis-friona-2026-09-25
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const UA = 'TornadoSight/0.1 (IEEE Response Quest; emergency response research prototype)';
const EVENTS = [
  'Tornado Warning',
  'Tornado Watch',
  'Severe Thunderstorm Warning',
  'Severe Thunderstorm Watch',
  'Special Weather Statement',
  'Flash Flood Warning',
];

/**
 * Accepts both `--name value` and `--name=value`. The second form matters for
 * a bounding box, whose western longitude starts with a minus sign and would
 * otherwise look like another flag.
 */
function arg(name, fallback) {
  const joined = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (joined) return joined.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function getJson(url, attempt = 0) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/geo+json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (attempt >= 3) throw err;
    const wait = 1500 * (attempt + 1);
    console.warn(`  retrying in ${wait}ms after ${err.message}`);
    await new Promise((r) => setTimeout(r, wait));
    return getJson(url, attempt + 1);
  }
}

const start = arg('start', '2026-09-25T19:00:00Z');
const end = arg('end', '2026-09-26T01:00:00Z');
const slug = arg('slug', `event-${start.slice(0, 10)}`);

console.log(`Capturing ${start} to ${end}`);

/**
 * The archive endpoint will not answer a narrow date range. Asking for the
 * exact window returns an empty collection, while asking for a window of a
 * couple of weeks around it returns the very same alerts. So we query wide,
 * follow the pagination cursor, and narrow the result ourselves.
 */
const windowStart = new Date(start).getTime();
const windowEnd = new Date(end).getTime();
const wideStart = new Date(windowStart - 20 * 864e5).toISOString();
const wideEnd = new Date(Math.min(Date.now(), windowEnd + 10 * 864e5)).toISOString();

async function fetchAllPages(event) {
  const q = new URLSearchParams({ start: wideStart, end: wideEnd, event });
  let url = `https://api.weather.gov/alerts?${q}`;
  const out = [];
  for (let page = 0; page < 20 && url; page++) {
    const data = await getJson(url);
    const got = data.features ?? [];
    out.push(...got);
    const next = data.pagination?.next;
    // The cursor repeats itself once the archive is exhausted, so stop when a
    // page adds nothing rather than trusting the link to disappear.
    url = got.length && next && next !== url ? next : null;
  }
  return out;
}

/**
 * Optional `--bbox west,south,east,north`. Without it a capture pulls in
 * unrelated nationwide products, and one run reached from New Mexico to Guam.
 */
const bboxArg = arg('bbox', null);
const bbox = bboxArg ? bboxArg.split(',').map(Number) : null;

function touchesBbox(feature) {
  if (!bbox) return true;
  if (!feature.geometry) return false;
  const [w, s, e, n] = bbox;
  const polys =
    feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  for (const rings of polys) {
    for (const ring of rings) {
      for (const [lon, lat] of ring) {
        if (lon >= w && lon <= e && lat >= s && lat <= n) return true;
      }
    }
  }
  return false;
}

const features = [];
for (const event of EVENTS) {
  const all = await fetchAllPages(event);
  const kept = all.filter((f) => {
    const t = new Date(f.properties.sent).getTime();
    // Timestamps carry a local offset, so compare instants rather than strings.
    return t >= windowStart && t <= windowEnd && touchesBbox(f);
  });
  console.log(`  ${event}: ${kept.length} kept (${all.length} returned)`);
  features.push(...kept);
}

if (!features.length) {
  console.error('No alerts found in that window. Nothing written.');
  process.exit(1);
}

features.sort((a, b) => new Date(a.properties.sent) - new Date(b.properties.sent));

// Bounds across every polygon, so the app can frame the map on load.
let west = 180;
let south = 90;
let east = -180;
let north = -90;
for (const f of features) {
  if (!f.geometry) continue;
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const rings of polys) {
    for (const ring of rings) {
      for (const [lon, lat] of ring) {
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
    }
  }
}

const counts = {};
for (const f of features) {
  const e = f.properties.event;
  counts[e] = (counts[e] ?? 0) + 1;
}

const areas = [...new Set(features.map((f) => f.properties.areaDesc))];

const fixture = {
  slug,
  capturedAt: new Date().toISOString(),
  source: 'https://api.weather.gov/alerts',
  note:
    'Genuine archived National Weather Service alerts. Nothing here is simulated, ' +
    'generated or edited. Replay mode steps through them in their original order.',
  window: { start, end },
  bounds: { west, south, east, north },
  counts,
  areas,
  features,
};

const outDir = path.join(process.cwd(), 'public', 'data', 'replay');
await fs.mkdir(outDir, { recursive: true });
const outFile = path.join(outDir, `${slug}.json`);
await fs.writeFile(outFile, JSON.stringify(fixture));

const kb = ((await fs.stat(outFile)).size / 1024).toFixed(0);
console.log(`\nWrote ${outFile} (${kb} KB)`);
console.log(`  ${features.length} alerts across ${areas.length} areas`);
console.log(`  bounds ${west.toFixed(2)},${south.toFixed(2)} to ${east.toFixed(2)},${north.toFixed(2)}`);
