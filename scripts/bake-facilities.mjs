/**
 * Bake critical infrastructure into static shards the app serves from its own
 * origin.
 *
 * Overpass is a fine source and a poor runtime dependency. Probing it during
 * design returned a 406 and a 504 within minutes of each other, and a live
 * demonstration cannot pause while a community tile server recovers. Calling it
 * here instead, once, with retries and endpoint rotation, gives the app data
 * that loads instantly, costs nothing to serve, cannot be rate limited and
 * works with no network at all.
 *
 *   node scripts/bake-facilities.mjs --bbox=-104.6,33.6,-101.4,35.6
 *
 * Output is one file per whole degree cell, so the app fetches only the cells
 * its viewport touches.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const UA = 'TornadoSight/0.1 (IEEE Response Quest; emergency response research prototype)';

/**
 * OSM tags mapped onto the facility kinds the exposure model weights. Ordering
 * matters: the first rule that matches a feature wins, so nursing homes are
 * tested before the generic social facility catch all.
 */
const RULES = [
  { kind: 'hospital', query: 'nwr["amenity"="hospital"]' },
  { kind: 'nursing_home', query: 'nwr["amenity"="nursing_home"]' },
  { kind: 'nursing_home', query: 'nwr["social_facility"="nursing_home"]' },
  { kind: 'school', query: 'nwr["amenity"~"^(school|college|university|kindergarten)$"]' },
  { kind: 'fire_station', query: 'nwr["amenity"="fire_station"]' },
  { kind: 'police', query: 'nwr["amenity"="police"]' },
  { kind: 'power_substation', query: 'nwr["power"="substation"]' },
  { kind: 'communication_tower', query: 'nwr["man_made"="communications_tower"]' },
  { kind: 'communication_tower', query: 'nwr["tower:type"="communication"]' },
  { kind: 'shelter', query: 'nwr["amenity"="shelter"]' },
  { kind: 'shelter', query: 'nwr["emergency"="shelter"]' },
  { kind: 'transport', query: 'nwr["aeroway"="aerodrome"]' },
  { kind: 'transport', query: 'nwr["railway"="station"]' },
];

function arg(name, fallback) {
  const joined = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (joined) return joined.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(body) {
  let lastError;
  for (let attempt = 0; attempt < ENDPOINTS.length * 2; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.trimStart().startsWith('{')) throw new Error('non JSON response');
      return JSON.parse(text);
    } catch (err) {
      lastError = err;
      const wait = 4000 * (attempt + 1);
      console.warn(`    ${endpoint.split('/')[2]} failed (${err.message}), waiting ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw lastError;
}


function classify(tags = {}) {
  if (tags.amenity === 'hospital') return 'hospital';
  if (tags.amenity === 'nursing_home' || tags.social_facility === 'nursing_home') return 'nursing_home';
  if (['school', 'college', 'university', 'kindergarten'].includes(tags.amenity)) return 'school';
  if (tags.amenity === 'fire_station') return 'fire_station';
  if (tags.amenity === 'police') return 'police';
  if (tags.power === 'substation') return 'power_substation';
  if (tags.man_made === 'communications_tower' || tags['tower:type'] === 'communication')
    return 'communication_tower';
  if (tags.amenity === 'shelter' || tags.emergency === 'shelter') return 'shelter';
  if (tags.aeroway === 'aerodrome' || tags.railway === 'station') return 'transport';
  return 'other';
}

const NAMES = {
  hospital: 'Hospital',
  nursing_home: 'Nursing home',
  school: 'School',
  fire_station: 'Fire station',
  police: 'Police station',
  power_substation: 'Power substation',
  communication_tower: 'Communication tower',
  shelter: 'Shelter',
  transport: 'Transport hub',
  other: 'Facility',
};


/* ------------------------------------------------------------------ *
 * Tiled baking
 * ------------------------------------------------------------------ */

/**
 * A single Overpass query for anything larger than a county times out, so the
 * region is cut into tiles and fetched one at a time. Each finished tile is
 * written straight to disk, which makes the whole run resumable: a rerun skips
 * tiles it already has instead of starting the several hours again.
 */
const bbox = arg('bbox', '-104.6,33.6,-101.4,35.6').split(',').map(Number);
const [west, south, east, north] = bbox;
const slug = arg('name', 'region');

const TILE_DEGREES = Number(arg('tile', '2'));

const outDir = path.join(process.cwd(), 'public', 'data', 'facilities');
const indexPath = path.join(outDir, 'index.json');
await fs.mkdir(outDir, { recursive: true });

async function readIndex() {
  try {
    return JSON.parse(await fs.readFile(indexPath, 'utf8'));
  } catch {
    return { cells: [], regions: [], tiles: [] };
  }
}

const index = await readIndex();
index.tiles ??= [];
const doneTiles = new Set(index.tiles);

/** Merge new facilities into a one degree shard already on disk. */
async function mergeCell(key, list) {
  const file = path.join(outDir, `${key}.json`);
  let existing = [];
  try {
    existing = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    /* new shard */
  }
  const byId = new Map(existing.map((f) => [f.id, f]));
  for (const f of list) byId.set(f.id, f);
  const merged = [...byId.values()].sort((a, b) => a.lat - b.lat);
  await fs.writeFile(file, JSON.stringify(merged));
  return merged.length;
}

const tiles = [];
for (let s = Math.floor(south); s < north; s += TILE_DEGREES) {
  for (let w = Math.floor(west); w < east; w += TILE_DEGREES) {
    tiles.push([w, s, Math.min(w + TILE_DEGREES, east), Math.min(s + TILE_DEGREES, north)]);
  }
}

console.log(`Baking ${slug}: ${tiles.length} tiles of ${TILE_DEGREES} degrees`);

const counts = {};
let grandTotal = 0;
let skipped = 0;
let failed = 0;

for (const [i, tile] of tiles.entries()) {
  const [tw, ts, te, tn] = tile;
  const tileKey = `${tw}_${ts}_${te}_${tn}`;
  if (doneTiles.has(tileKey)) {
    skipped++;
    continue;
  }

  const area = `(${ts},${tw},${tn},${te})`;
  const clauses = RULES.map((r) => `${r.query}${area};`).join('');
  const query = `[out:json][timeout:300];(${clauses});out center tags;`;

  process.stdout.write(`  [${i + 1}/${tiles.length}] ${tw},${ts} `);

  let data;
  try {
    data = await overpass(query);
  } catch (err) {
    console.log(`failed: ${err.message}`);
    failed++;
    continue;
  }

  const cells = new Map();
  const seen = new Set();
  for (const el of data.elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;

    const kind = classify(el.tags);
    // A hospital mapped as both a node and a building way would otherwise be
    // counted twice and double its weight in the exposure score.
    const dedupe = `${kind}:${lat.toFixed(4)}:${lon.toFixed(4)}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    const key = `${Math.floor(lat)}_${Math.floor(lon)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push({
      id: `${el.type[0]}${el.id}`,
      kind,
      name: el.tags?.name ?? NAMES[kind],
      lat: Number(lat.toFixed(5)),
      lon: Number(lon.toFixed(5)),
    });
    counts[kind] = (counts[kind] ?? 0) + 1;
    grandTotal++;
  }

  for (const [key, list] of cells) {
    await mergeCell(key, list);
    if (!index.cells.includes(key)) index.cells.push(key);
  }

  index.tiles.push(tileKey);
  doneTiles.add(tileKey);
  index.cells.sort();
  index.regions = [
    ...index.regions.filter((r) => r.name !== slug),
    { name: slug, bbox, bakedAt: new Date().toISOString() },
  ];
  // Checkpoint after every tile, so an interrupted run loses one tile at most.
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2));

  console.log(`${data.elements.length} elements, ${cells.size} cells`);
}

console.log(`\n  ${grandTotal} facilities added across ${index.cells.length} cells`);
if (skipped) console.log(`  ${skipped} tiles already done`);
if (failed) console.log(`  ${failed} tiles failed, rerun to retry them`);
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(20)} ${v}`);
}
