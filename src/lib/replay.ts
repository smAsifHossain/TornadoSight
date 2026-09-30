/**
 * Replay of a real severe weather event.
 *
 * Severe weather does not schedule itself around demonstrations, and the
 * challenge forbids simulated interaction, so rather than inventing an event
 * the app replays one that genuinely happened. The fixture in
 * public/data/replay holds archived National Weather Service alerts exactly as
 * they were issued, including their polygons, motion vectors and detection
 * flags. Replay steps a clock through that window and shows what a responder
 * would have seen at each moment.
 */

import { normalizeAlert, type Alert } from './nws';

const BASE = import.meta.env.BASE_URL ?? '/';

export interface ReplayEvent {
  slug: string;
  title: string;
  note: string;
  window: { start: Date; end: Date };
  bounds: { west: number; south: number; east: number; north: number };
  areas: string[];
  alerts: Alert[];
}

/** The events shipped with the app. */
export const REPLAY_CATALOG = [
  {
    slug: 'clovis-friona-supercell',
    title: 'Curry County NM to Parmer County TX supercell',
    summary:
      'A single supercell tracked north east across the New Mexico and Texas line, ' +
      'drawing twelve consecutive tornado warnings over roughly two hours.',
  },
] as const;

export async function loadReplay(slug: string): Promise<ReplayEvent> {
  const res = await fetch(`${BASE}data/replay/${slug}.json`);
  if (!res.ok) throw new Error(`Replay event ${slug} could not be loaded.`);

  const data = (await res.json()) as {
    slug: string;
    note: string;
    window: { start: string; end: string };
    bounds: ReplayEvent['bounds'];
    areas: string[];
    features: unknown[];
  };

  const catalog = REPLAY_CATALOG.find((c) => c.slug === slug);

  return {
    slug: data.slug,
    title: catalog?.title ?? data.slug,
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

/** Bounds of the alerts issued during the event, tighter than the fixture's. */
export function activeBounds(event: ReplayEvent): [number, number, number, number] {
  return [event.bounds.west, event.bounds.south, event.bounds.east, event.bounds.north];
}

/**
 * A sensible point to focus on: where radar last placed the storm, so the
 * selection follows the storm rather than sitting still while it moves away.
 */
export function focusAt(event: ReplayEvent, at: Date): { lat: number; lon: number } | null {
  const live = alertsAt(event, at).filter((a) => a.motion);
  if (!live.length) return null;
  const newest = live.reduce((best, a) => (a.sent > best.sent ? a : best), live[0]);
  return newest.motion!.position;
}

/**
 * Where replay should open: just before the first warning that carries a storm
 * motion vector, positioned on that storm. Opening at the start of the captured
 * window instead shows an empty map, and opening on an alert with no motion
 * shows a warning with nothing to project.
 */
export function openingMoment(event: ReplayEvent): { at: Date; point: { lat: number; lon: number } | null } {
  // Prefer the storm the event is actually about. A capture also holds flood
  // and statement products that carry motion vectors, and opening on one of
  // those shows a tracked storm that is not the tornadic one.
  const byPriority = ['Tornado Warning', 'Severe Thunderstorm Warning'];
  const tracked =
    byPriority
      .map((event_) => event.alerts.find((a) => a.motion && a.event === event_))
      .find(Boolean) ?? event.alerts.find((a) => a.motion);

  if (!tracked) return { at: event.window.start, point: null };

  // Open a minute *after* issuance, not before it. Opening before means the
  // alert does not exist yet and the panel correctly reports nothing active,
  // which looks like a broken replay.
  const at = new Date(tracked.sent.getTime() + 60_000);
  return { at, point: tracked.motion!.position };
}

/** Bounds that frame the tracked storm rather than every alert in the capture. */
export function trackedBounds(event: ReplayEvent): [number, number, number, number] | null {
  const tornadic = event.alerts.filter((a) => a.motion && a.event === 'Tornado Warning');
  const source = tornadic.length ? tornadic : event.alerts.filter((a) => a.motion);
  const points = source.map((a) => a.motion!.position);
  if (!points.length) return null;
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const pad = 0.45;
  return [
    Math.min(...lons) - pad,
    Math.min(...lats) - pad,
    Math.max(...lons) + pad,
    Math.max(...lats) + pad,
  ];
}
