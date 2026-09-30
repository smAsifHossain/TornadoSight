/**
 * Critical infrastructure loading.
 *
 * Primary source is the static shards produced by scripts/bake-facilities.mjs,
 * which are served from the app's own origin: instant, free, rate limit proof
 * and available with no network once cached. For a region that was never baked
 * the app falls back to a live Overpass query and says so in the interface,
 * because pretending there is no infrastructure when we simply have no data
 * would be the most dangerous possible failure.
 */

import type { Facility, FacilityKind } from './scoring';

const BASE = import.meta.env.BASE_URL ?? '/';

export type FacilitySource = 'baked' | 'live' | 'none';

export interface FacilityLoad {
  facilities: Facility[];
  source: FacilitySource;
  /** Set when a live lookup was attempted and failed. */
  error: string | null;
}

let cellIndex: Set<string> | null = null;
const cellCache = new Map<string, Facility[]>();

async function loadIndex(): Promise<Set<string>> {
  if (cellIndex) return cellIndex;
  try {
    const res = await fetch(`${BASE}data/facilities/index.json`);
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { cells?: string[] };
    cellIndex = new Set(data.cells ?? []);
  } catch {
    cellIndex = new Set();
  }
  return cellIndex;
}

function cellsFor(bbox: { west: number; south: number; east: number; north: number }): string[] {
  const keys: string[] = [];
  for (let lat = Math.floor(bbox.south); lat <= Math.floor(bbox.north); lat++) {
    for (let lon = Math.floor(bbox.west); lon <= Math.floor(bbox.east); lon++) {
      keys.push(`${lat}_${lon}`);
    }
  }
  return keys;
}

async function loadCell(key: string): Promise<Facility[]> {
  const cached = cellCache.get(key);
  if (cached) return cached;
  try {
    const res = await fetch(`${BASE}data/facilities/${key}.json`);
    if (!res.ok) throw new Error(String(res.status));
    const list = (await res.json()) as Facility[];
    cellCache.set(key, list);
    return list;
  } catch {
    cellCache.set(key, []);
    return [];
  }
}

const OVERPASS = 'https://overpass-api.de/api/interpreter';

const LIVE_QUERY = (s: number, w: number, n: number, e: number) => {
  const a = `(${s},${w},${n},${e})`;
  return (
    `[out:json][timeout:25];(` +
    `nwr["amenity"~"^(hospital|nursing_home|school|college|university|fire_station|police)$"]${a};` +
    `nwr["power"="substation"]${a};` +
    `nwr["man_made"="communications_tower"]${a};` +
    `nwr["emergency"="shelter"]${a};` +
    `);out center tags;`
  );
};

function classify(tags: Record<string, string> = {}): FacilityKind {
  if (tags.amenity === 'hospital') return 'hospital';
  if (tags.amenity === 'nursing_home') return 'nursing_home';
  if (['school', 'college', 'university', 'kindergarten'].includes(tags.amenity)) return 'school';
  if (tags.amenity === 'fire_station') return 'fire_station';
  if (tags.amenity === 'police') return 'police';
  if (tags.power === 'substation') return 'power_substation';
  if (tags.man_made === 'communications_tower') return 'communication_tower';
  if (tags.emergency === 'shelter') return 'shelter';
  return 'other';
}

const KIND_LABEL: Record<FacilityKind, string> = {
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

export function facilityLabel(kind: FacilityKind): string {
  return KIND_LABEL[kind] ?? 'Facility';
}

async function fetchLive(
  bbox: { west: number; south: number; east: number; north: number },
  signal?: AbortSignal,
): Promise<Facility[]> {
  const res = await fetch(OVERPASS, {
    method: 'POST',
    body: new URLSearchParams({ data: LIVE_QUERY(bbox.south, bbox.west, bbox.north, bbox.east) }),
    signal,
  });
  if (!res.ok) throw new Error(`Overpass returned ${res.status}`);
  const data = (await res.json()) as {
    elements?: { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[];
  };
  const seen = new Set<string>();
  const out: Facility[] = [];
  for (const el of data.elements ?? []) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const kind = classify(el.tags);
    const dedupe = `${kind}:${lat.toFixed(4)}:${lon.toFixed(4)}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ id: `${el.type[0]}${el.id}`, kind, name: el.tags?.name ?? KIND_LABEL[kind], lat, lon });
  }
  return out;
}

/**
 * Facilities covering a bounding box. Baked shards are preferred; a live lookup
 * only happens for a region with no baked coverage at all.
 */
export async function loadFacilities(
  bbox: { west: number; south: number; east: number; north: number },
  signal?: AbortSignal,
): Promise<FacilityLoad> {
  const index = await loadIndex();
  const keys = cellsFor(bbox);
  const baked = keys.filter((k) => index.has(k));

  if (baked.length) {
    const lists = await Promise.all(baked.map(loadCell));
    const facilities = lists.flat().filter((f) => {
      return f.lat >= bbox.south && f.lat <= bbox.north && f.lon >= bbox.west && f.lon <= bbox.east;
    });
    return { facilities, source: 'baked', error: null };
  }

  try {
    const facilities = await fetchLive(bbox, signal);
    return { facilities, source: 'live', error: null };
  } catch (err) {
    return {
      facilities: [],
      source: 'none',
      error: err instanceof Error ? err.message : 'Infrastructure lookup failed',
    };
  }
}
