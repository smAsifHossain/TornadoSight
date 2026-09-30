/**
 * Find real storms in the National Weather Service archive and save each as a
 * replay event.
 *
 * A storm is not one alert. A warned supercell produces a first warning and
 * then a string of updates as it moves, and the thing that ties them together
 * is the VTEC string every product carries:
 *
 *     /O.NEW.KLUB.TO.W.0004.000000T0000Z-260926T0415Z/
 *              ^^^^ ^^ ^ ^^^^
 *              office |  |  event tracking number
 *                     |  significance
 *                     phenomenon
 *
 * Office plus phenomenon plus tracking number identifies one storm, so grouping
 * on that recovers the actual events rather than guessing from timestamps. Only
 * groups with several updates and usable motion vectors are kept, because a
 * lone warning with no motion has nothing to replay.
 *
 *   node scripts/discover-events.mjs --min 4 --max 12
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const UA = 'TornadoSight/0.1 (https://github.com/smAsifHossain/TornadoSight; research prototype)';
const EVENTS = ['Tornado Warning', 'Severe Thunderstorm Warning'];

function arg(name, fallback) {
  const joined = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (joined) return joined.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, attempt = 0) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/geo+json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (attempt >= 4) throw err;
    await sleep(2000 * (attempt + 1));
    return getJson(url, attempt + 1);
  }
}

/**
 * The archive endpoint refuses a narrow date range, returning an empty
 * collection, while a window of a couple of weeks around the same dates returns
 * the alerts happily. So always ask wide and narrow the result here.
 */
async function fetchAll(event) {
  const end = new Date();
  const start = new Date(end.getTime() - 32 * 864e5);
  const q = new URLSearchParams({ start: start.toISOString(), end: end.toISOString(), event });
  let url = `https://api.weather.gov/alerts?${q}`;
  const out = [];
  for (let page = 0; page < 40 && url; page++) {
    const data = await getJson(url);
    const got = data.features ?? [];
    out.push(...got);
    const next = data.pagination?.next;
    url = got.length && next && next !== url ? next : null;
    await sleep(300);
  }
  return out;
}

/** Office, phenomenon and tracking number: the identity of one storm. */
function stormKey(feature) {
  const vtec = feature.properties?.parameters?.VTEC?.[0];
  if (!vtec) return null;
  const m = vtec.match(/\/[A-Z]\.[A-Z]{3}\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\./);
  return m ? `${m[1]}.${m[2]}.${m[4]}` : null;
}

function hasMotion(feature) {
  return Boolean(feature.properties?.parameters?.eventMotionDescription?.[0]);
}

const minUpdates = Number(arg('min', '4'));
const maxEvents = Number(arg('max', '12'));

console.log('Scanning the National Weather Service archive…');

const all = [];
for (const event of EVENTS) {
  const got = await fetchAll(event);
  console.log(`  ${event}: ${got.length}`);
  all.push(...got);
}

const storms = new Map();
for (const f of all) {
  const key = stormKey(f);
  if (!key) continue;
  if (!storms.has(key)) storms.set(key, []);
  storms.get(key).push(f);
}

console.log(`\n${storms.size} distinct storms found`);

/** Rank storms by how much there is to watch. */
const candidates = [...storms.entries()]
  .map(([key, features]) => {
    features.sort((a, b) => new Date(a.properties.sent) - new Date(b.properties.sent));
    const withMotion = features.filter(hasMotion);
    const tornadic = features.filter((f) => f.properties.event === 'Tornado Warning').length;
    const observed = features.filter(
      (f) => f.properties.parameters?.tornadoDetection?.[0] === 'OBSERVED',
    ).length;
    const minutes =
      (new Date(features.at(-1).properties.sent) - new Date(features[0].properties.sent)) / 60000;
    return { key, features, withMotion, tornadic, observed, minutes };
  })
  .filter((c) => c.features.length >= minUpdates && c.withMotion.length >= minUpdates - 1 && c.minutes >= 20)
  // A tornadic storm outranks a hail storm, then more updates, then longer life.
  .sort(
    (a, b) =>
      b.observed - a.observed ||
      b.tornadic - a.tornadic ||
      b.features.length - a.features.length ||
      b.minutes - a.minutes,
  )
  .slice(0, maxEvents);

console.log(`${candidates.length} have enough to replay\n`);

const outDir = path.join(process.cwd(), 'public', 'data', 'replay');
await fs.mkdir(outDir, { recursive: true });

const catalog = [];

for (const c of candidates) {
  const first = c.features[0].properties;
  const areas = [...new Set(c.features.map((f) => f.properties.areaDesc))];

  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  for (const f of c.features) {
    if (!f.geometry) continue;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const rings of polys)
      for (const ring of rings)
        for (const [lon, lat] of ring) {
          if (lon < west) west = lon;
          if (lon > east) east = lon;
          if (lat < south) south = lat;
          if (lat > north) north = lat;
        }
  }
  if (!Number.isFinite(west)) continue;

  const day = new Date(first.sent).toISOString().slice(0, 10);
  const place = areas[0].split(';')[0].trim().replace(/[^A-Za-z]+/g, '-').toLowerCase();
  // Include the tracking number: one office can warn two storms in the same
  // county on the same day, and without it the second overwrites the first.
  const [office, , etn] = c.key.split('.');
  const slug = `${place}-${day}-${office.toLowerCase()}-${etn}`;

  const kind = c.tornadic ? 'Tornado warning' : 'Severe thunderstorm warning';
  const title = `${areas[0].split(';')[0].trim()}, ${new Date(first.sent).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })}`;

  const summary =
    `${kind} sequence from ${first.senderName}. ` +
    `${c.features.length} products over ${Math.round(c.minutes)} minutes` +
    (c.observed ? `, with a tornado observed on the ground.` : '.');

  const window = {
    start: new Date(new Date(first.sent).getTime() - 5 * 60000).toISOString(),
    end: new Date(new Date(c.features.at(-1).properties.sent).getTime() + 45 * 60000).toISOString(),
  };

  await fs.writeFile(
    path.join(outDir, `${slug}.json`),
    JSON.stringify({
      slug,
      capturedAt: new Date().toISOString(),
      source: 'https://api.weather.gov/alerts',
      note:
        'Genuine archived National Weather Service products for a single storm, ' +
        'grouped by their VTEC event identifier. Nothing here is simulated, generated or edited.',
      window,
      bounds: { west, south, east, north },
      areas,
      counts: { total: c.features.length, tornadic: c.tornadic, observed: c.observed },
      features: c.features,
    }),
  );

  catalog.push({
    slug,
    title,
    summary,
    kind: c.tornadic ? 'tornado' : 'severe',
    observed: c.observed > 0,
    products: c.features.length,
    minutes: Math.round(c.minutes),
    office: first.senderName,
    start: window.start,
  });

  console.log(
    `  ${slug.padEnd(42)} ${String(c.features.length).padStart(3)} products, ` +
      `${String(Math.round(c.minutes)).padStart(3)} min${c.observed ? ', OBSERVED' : ''}`,
  );
}

// The app reads this to know what it can replay, so it never has to probe.
catalog.sort((a, b) => Number(b.observed) - Number(a.observed) || b.products - a.products);
await fs.writeFile(path.join(outDir, 'catalog.json'), JSON.stringify(catalog, null, 2));

console.log(`\nWrote ${catalog.length} events and a catalog to ${outDir}`);
