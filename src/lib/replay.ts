/**
 * Replay of real severe weather events.
 *
 * Severe weather does not schedule itself around demonstrations, and the
 * challenge forbids simulated interaction, so rather than inventing an event
 * the app replays ones that genuinely happened. Each fixture in
 * public/data/replay holds the archived National Weather Service products for a
 * single storm, grouped by the VTEC identifier the products themselves carry,
 * exactly as issued: polygons, motion vectors, detection flags and all.
 *
 * `scripts/discover-events.mjs` builds the library by scanning the archive for
 * storms with enough updates to be worth watching, so the catalogue refreshes
 * as new weather happens rather than being one hand-picked storm forever.
 */

import { normalizeAlert, type Alert } from './nws';

const BASE = import.meta.env.BASE_URL ?? '/';

export interface ReplayEntry {
  slug: string;
  title: string;
  summary: string;
  kind: 'tornado' | 'severe';
  /** True when a tornado was confirmed on the ground, not just radar indicated. */
  observed: boolean;
  products: number;
  minutes: number;
  office: string;
  start: string;
}

export interface ReplayEvent extends ReplayEntry {
  note: string;
  window: { start: Date; end: Date };
  bounds: { west: number; south: number; east: number; north: number };
  areas: string[];
  alerts: Alert[];
}

let catalogPromise: Promise<ReplayEntry[]> | null = null;

/** Every event the app can replay, best first. */
export function loadCatalog(): Promise<ReplayEntry[]> {
  catalogPromise ??= fetch(`${BASE}data/replay/catalog.json`)
    .then((r) => (r.ok ? (r.json() as Promise<ReplayEntry[]>) : []))
    .catch(() => []);
  return catalogPromise;
}

export async function loadReplay(slug: string): Promise<ReplayEvent> {
  const [catalog, res] = await Promise.all([
    loadCatalog(),
    fetch(`${BASE}data/replay/${slug}.json`),
  ]);
  if (!res.ok) throw new Error(`Replay event ${slug} could not be loaded.`);

  const data = (await res.json()) as {
    slug: string;
    note: string;
    window: { start: string; end: string };
    bounds: ReplayEvent['bounds'];
    areas: string[];
    features: unknown[];
  };

  const entry = catalog.find((c) => c.slug === slug);

  return {
    slug: data.slug,
    title: entry?.title ?? data.slug,
    summary: entry?.summary ?? '',
    kind: entry?.kind ?? 'severe',
    observed: entry?.observed ?? false,
    products: entry?.products ?? data.features.length,
    minutes: entry?.minutes ?? 0,
    office: entry?.office ?? '',
    start: entry?.start ?? data.window.start,
    note: data.note,
    window: { start: new Date(data.window.start), end: new Date(data.window.end) },
    bounds: data.bounds,
    areas: data.areas,
    alerts: data.features
      .map(normalizeAlert)
      .filter((a): a is Alert => a !== null)
      .sort((a, b) => a.sent.getTime() - b.sent.getTime()),
  };
}

/**
 * Which event to open on. Rotates through the catalogue so the same storm is
 * not shown every single time, while still favouring the ones with a tornado
 * confirmed on the ground, which are the most informative to watch.
 */
export function pickEvent(catalog: ReplayEntry[], seed = Date.now()): ReplayEntry | null {
  if (!catalog.length) return null;
  const observed = catalog.filter((c) => c.observed);
  const pool = observed.length ? observed : catalog;
  return pool[Math.floor(seed / 60000) % pool.length];
}

/**
 * The alerts a responder would have had in front of them at `at`: issued
 * already, and not yet expired.
 */
export function alertsAt(event: ReplayEvent, at: Date): Alert[] {
  const t = at.getTime();
  return event.alerts.filter((a) => {
    const issued = a.sent.getTime();
    const gone = (a.ends ?? a.expires)?.getTime() ?? issued + 45 * 60000;
    return issued <= t && gone >= t;
  });
}

export function activeBounds(event: ReplayEvent): [number, number, number, number] {
  return [event.bounds.west, event.bounds.south, event.bounds.east, event.bounds.north];
}

/**
 * Where replay should open: on the first warning that carries a storm motion
 * vector, a minute after it was issued.
 *
 * A minute *after*, not before. Opening before means the warning does not exist
 * yet and the panel correctly reports nothing active, which reads as a broken
 * replay rather than an accurate one.
 */
export function openingMoment(event: ReplayEvent): { at: Date; point: { lat: number; lon: number } | null } {
  const byPriority = ['Tornado Warning', 'Severe Thunderstorm Warning'];
  const tracked =
    byPriority
      .map((name) => event.alerts.find((a) => a.motion && a.event === name))
      .find(Boolean) ?? event.alerts.find((a) => a.motion);

  if (!tracked) return { at: event.window.start, point: null };
  return { at: new Date(tracked.sent.getTime() + 60_000), point: tracked.motion!.position };
}

/** Bounds that frame the tracked storm rather than every alert in the capture. */
export function trackedBounds(event: ReplayEvent): [number, number, number, number] | null {
  const tornadic = event.alerts.filter((a) => a.motion && a.event === 'Tornado Warning');
  const source = tornadic.length ? tornadic : event.alerts.filter((a) => a.motion);
  const points = source.map((a) => a.motion!.position);
  if (!points.length) return null;
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const pad = 0.4;
  return [
    Math.min(...lons) - pad,
    Math.min(...lats) - pad,
    Math.max(...lons) + pad,
    Math.max(...lats) + pad,
  ];
}

/**
 * The path radar actually traced, as a line through every reported storm
 * position in order. This is history, not a projection, and the map draws it
 * differently for that reason.
 */
export function observedTrack(event: ReplayEvent, upTo?: Date): { lat: number; lon: number }[] {
  const limit = upTo?.getTime() ?? Infinity;
  return event.alerts
    .filter((a) => a.motion && a.sent.getTime() <= limit)
    .sort((a, b) => a.motion!.time.getTime() - b.motion!.time.getTime())
    .map((a) => a.motion!.position);
}
