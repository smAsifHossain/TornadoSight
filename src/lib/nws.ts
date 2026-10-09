/**
 * National Weather Service alert handling.
 *
 * Everything here is derived from the public api.weather.gov feed, which needs
 * no key and sends permissive CORS headers, so it can be called straight from
 * the browser. See notes/data-sources.md for the field survey this is based on.
 */

import { KNOTS_TO_MPH, type LatLon } from './geo';

export const NWS_API = 'https://api.weather.gov';

/**
 * A descriptive User-Agent is requested by the NWS API terms. Browsers refuse
 * to let a page set User-Agent, so we send the contact detail they also accept
 * in an Accept header and identify the app in the query string instead.
 */
const NWS_HEADERS: HeadersInit = { Accept: 'application/geo+json' };

export interface StormMotion {
  /** Time the motion was measured. */
  time: Date;
  /** Direction the storm is coming FROM, degrees clockwise from north. */
  fromBearing: number;
  /** Direction the storm is travelling TOWARD. */
  heading: number;
  speedKnots: number;
  speedMph: number;
  /** Radar centroid of the storm at `time`. */
  position: LatLon;
}

export type ThreatLevel = 'OBSERVED' | 'RADAR INDICATED' | 'POSSIBLE' | null;

export interface Alert {
  id: string;
  event: string;
  headline: string | null;
  description: string;
  instruction: string | null;
  areaDesc: string;
  severity: string;
  certainty: string;
  urgency: string;
  sent: Date;
  onset: Date | null;
  expires: Date | null;
  ends: Date | null;
  senderName: string;
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] } | null;
  motion: StormMotion | null;
  tornadoDetection: ThreatLevel;
  tornadoDamageThreat: string | null;
  windThreat: ThreatLevel;
  maxWindGustMph: number | null;
  hailThreat: ThreatLevel;
  maxHailInches: number | null;
  /** Zone URLs a watch is issued against, used to give it a shape. */
  affectedZones: string[];
  /** VTEC string, which identifies one event across its updates. */
  vtec: string | null;
  /**
   * Office, phenomenon and tracking number pulled out of the VTEC, which is
   * what ties a first warning to every update that follows it for the same
   * storm. Without this, successive products for one supercell look like
   * unrelated alerts and there is no way to tell whether it is getting worse.
   */
  stormKey: string | null;
}

/**
 * Parse the identity out of a VTEC string such as
 * `/O.NEW.KLUB.TO.W.0004.000000T0000Z-260926T0415Z/`, giving `KLUB.TO.0004`.
 */
export function parseStormKey(vtec: string | null): string | null {
  if (!vtec) return null;
  const m = vtec.match(/\/[A-Z]\.[A-Z]{3}\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\./);
  return m ? `${m[1]}.${m[2]}.${m[4]}` : null;
}

/**
 * Parse `eventMotionDescription`, which looks like
 * `2026-09-26T04:11:00-00:00...storm...250DEG...19KT...34.65,-102.78`.
 *
 * The bearing is the direction the storm moves FROM, following wind convention.
 * That was confirmed against the narrative text of the same alerts: 259DEG
 * reads as "moving east", and 241DEG reads as "moving northeast". Getting this
 * backwards would send every projected path in the opposite direction.
 */
export function parseStormMotion(raw: string | undefined | null): StormMotion | null {
  if (!raw) return null;
  const parts = raw.split('...');
  if (parts.length < 5) return null;

  const time = new Date(parts[0]);
  const bearingMatch = parts[2]?.match(/(\d+(?:\.\d+)?)\s*DEG/i);
  const speedMatch = parts[3]?.match(/(\d+(?:\.\d+)?)\s*KT/i);
  const posMatch = parts[4]?.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (!bearingMatch || !speedMatch || !posMatch) return null;
  if (Number.isNaN(time.getTime())) return null;

  const fromBearing = Number(bearingMatch[1]) % 360;
  const speedKnots = Number(speedMatch[1]);

  return {
    time,
    fromBearing,
    heading: (fromBearing + 180) % 360,
    speedKnots,
    speedMph: speedKnots * KNOTS_TO_MPH,
    position: { lat: Number(posMatch[1]), lon: Number(posMatch[2]) },
  };
}

function firstParam(params: Record<string, string[]> | undefined, key: string): string | null {
  const v = params?.[key];
  return Array.isArray(v) && v.length ? v[0] : null;
}

function asThreat(value: string | null): ThreatLevel {
  if (!value) return null;
  const upper = value.toUpperCase();
  if (upper === 'OBSERVED' || upper === 'RADAR INDICATED' || upper === 'POSSIBLE') return upper;
  return null;
}

/**
 * `60 MPH`, `60` or `1.75` becomes a number.
 *
 * The leading decimal point matters. Hail size arrives as `.75`, and a pattern
 * that requires a digit before the point reads that as seventy five, which the
 * interface then reported as "hail to 75 in".
 */
function parseMeasure(value: string | null): number | null {
  if (!value) return null;
  const m = value.match(/(\d*\.\d+|\d+)/);
  return m ? Number(m[1]) : null;
}

function date(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function normalizeAlert(feature: any): Alert | null {
  const p = feature?.properties;
  if (!p?.id && !feature?.id) return null;
  const params = p.parameters as Record<string, string[]> | undefined;
  const geomType = feature?.geometry?.type;

  return {
    id: String(p.id ?? feature.id),
    event: String(p.event ?? 'Unknown'),
    headline: p.headline ?? null,
    description: String(p.description ?? ''),
    instruction: p.instruction ?? null,
    areaDesc: String(p.areaDesc ?? ''),
    severity: String(p.severity ?? 'Unknown'),
    certainty: String(p.certainty ?? 'Unknown'),
    urgency: String(p.urgency ?? 'Unknown'),
    sent: date(p.sent) ?? new Date(0),
    onset: date(p.onset),
    expires: date(p.expires),
    ends: date(p.ends),
    senderName: String(p.senderName ?? ''),
    geometry:
      geomType === 'Polygon' || geomType === 'MultiPolygon'
        ? { type: geomType, coordinates: feature.geometry.coordinates }
        : null,
    motion: parseStormMotion(firstParam(params, 'eventMotionDescription')),
    tornadoDetection: asThreat(firstParam(params, 'tornadoDetection')),
    tornadoDamageThreat: firstParam(params, 'tornadoDamageThreat'),
    windThreat: asThreat(firstParam(params, 'windThreat')),
    maxWindGustMph: parseMeasure(firstParam(params, 'maxWindGust')),
    hailThreat: asThreat(firstParam(params, 'hailThreat')),
    maxHailInches: parseMeasure(firstParam(params, 'maxHailSize')),
    affectedZones: Array.isArray(p.affectedZones) ? (p.affectedZones as string[]) : [],
    vtec: firstParam(params, 'VTEC'),
    stormKey: parseStormKey(firstParam(params, 'VTEC')),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * When the National Weather Service refuses, stop asking for a while.
 *
 * Polling a 403 once a minute is what keeps a temporary block in place. This
 * holds off for five minutes and reports plainly, rather than quietly
 * retrying into the same wall.
 */
let backoffUntil = 0;

export function nwsBackoffRemainingMs(): number {
  return Math.max(0, backoffUntil - Date.now());
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const waiting = nwsBackoffRemainingMs();
  if (waiting > 0) {
    throw new Error(
      `the National Weather Service is rate limiting this client. Retrying in about ${Math.ceil(waiting / 60000)} minutes.`,
    );
  }
  const res = await fetch(url, { headers: NWS_HEADERS, signal });
  if (res.status === 403 || res.status === 429) {
    backoffUntil = Date.now() + 5 * 60_000;
    throw new Error(
      'the National Weather Service is rate limiting this client. Backing off for five minutes.',
    );
  }
  if (!res.ok) throw new Error(`NWS request failed with ${res.status} for ${url}`);
  return res.json();
}

/**
 * All currently active alerts. `limit` is deliberately not sent: the API
 * rejects it with a 400, which cost some time to discover.
 */
export async function fetchActiveAlerts(signal?: AbortSignal): Promise<Alert[]> {
  const data = (await fetchJson(`${NWS_API}/alerts/active?status=actual`, signal)) as {
    features?: unknown[];
  };
  return (data.features ?? []).map(normalizeAlert).filter((a): a is Alert => a !== null);
}

/** Alerts active at a single point, used when the responder drops a pin. */
export async function fetchAlertsAtPoint(point: LatLon, signal?: AbortSignal): Promise<Alert[]> {
  const url = `${NWS_API}/alerts/active?status=actual&point=${point.lat.toFixed(4)},${point.lon.toFixed(4)}`;
  const data = (await fetchJson(url, signal)) as { features?: unknown[] };
  return (data.features ?? []).map(normalizeAlert).filter((a): a is Alert => a !== null);
}

/**
 * Archived alerts for Replay mode. These are real past alerts, not simulated
 * data, which matters because the challenge forbids fabricated demonstrations.
 */
export async function fetchArchivedAlerts(
  options: { event?: string; start: Date; end: Date; area?: string },
  signal?: AbortSignal,
): Promise<Alert[]> {
  const q = new URLSearchParams({
    start: options.start.toISOString(),
    end: options.end.toISOString(),
  });
  if (options.event) q.set('event', options.event);
  if (options.area) q.set('area', options.area);
  const data = (await fetchJson(`${NWS_API}/alerts?${q}`, signal)) as { features?: unknown[] };
  return (data.features ?? []).map(normalizeAlert).filter((a): a is Alert => a !== null);
}

/* ------------------------------------------------------------------ *
 * Zone geometry for products that carry none
 * ------------------------------------------------------------------ */

/**
 * Give a watch a shape.
 *
 * Only warnings come with a polygon. A watch is issued against a list of
 * counties and marine zones, so its `geometry` is null and it draws as nothing
 * at all: every tornado watch in the country was invisible on the map, and
 * "tornadoes only" had nothing to frame because the only tornado products
 * active were watches.
 *
 * The zone list on the alert is already a set of URLs. The bulk endpoint
 * returns those zones with null geometry even when asked for it, so each is
 * fetched individually and cached, which is affordable because watches are few
 * and their zones repeat heavily between products.
 */
/** Rings of one zone's polygon, or null if it has no usable shape. */
const zoneCache = new Map<string, number[][][] | null>();

async function fetchZone(url: string, signal?: AbortSignal): Promise<number[][][] | null> {
  const cached = zoneCache.get(url);
  if (cached !== undefined) return cached;
  if (zonesBlocked) return null;
  try {
    const res = await fetch(url, { headers: NWS_HEADERS, signal });
    if (res.status === 403 || res.status === 429) {
      zonesBlocked = true;
      console.warn('[TornadoSight] zone lookups refused, stopping them for this session');
      return null;
    }
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as {
      geometry?: { type: string; coordinates: unknown } | null;
    };
    const g = data.geometry;
    let rings: number[][][] | null = null;
    if (g?.type === 'Polygon') {
      rings = g.coordinates as number[][][];
    } else if (g?.type === 'MultiPolygon') {
      // Flatten a multipart county into one ring list; holes are rare here and
      // an outline is all this is used for.
      rings = (g.coordinates as number[][][][]).flat();
    }
    zoneCache.set(url, rings);
    return rings;
  } catch {
    zoneCache.set(url, null);
    return null;
  }
}

/** How many zones to resolve for one alert. A statewide watch can list dozens. */
const MAX_ZONES_PER_ALERT = 25;

/**
 * Zone lookups in flight at once, across every alert.
 *
 * Resolving four watches without a limit fired well over a hundred requests in
 * one breath and the alerts feed itself started failing, which is a far worse
 * outcome than a watch drawing slowly. The shapes are a nicety; the feed is not.
 */
const ZONE_CONCURRENCY = 1;

/** Total zone lookups allowed per refresh, across every alert. */
const MAX_ZONES_PER_REFRESH = 12;
/** Gap between zone lookups. */
const ZONE_GAP_MS = 300;

/**
 * A session wide stop.
 *
 * A burst of zone lookups earned a 403 from the National Weather Service and
 * took the entire alerts feed down with it, which is a catastrophic trade for
 * drawing a watch outline. One refusal and this stops asking for the rest of
 * the session: the feed matters, the outlines do not.
 */
let zonesBlocked = false;

async function inBatches(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  for (let i = 0; i < tasks.length && !zonesBlocked; i += limit) {
    await Promise.all(tasks.slice(i, i + limit).map((t) => t()));
    await new Promise((r) => setTimeout(r, ZONE_GAP_MS));
  }
}

/**
 * Fill in geometry for any alert that lacks it, from the zones it was issued
 * against. Alerts that already carry a polygon are returned untouched.
 */
export async function resolveZoneGeometry(alerts: Alert[], signal?: AbortSignal): Promise<Alert[]> {
  if (zonesBlocked) return alerts;
  // Tornado products only, and the most recent first. Outlining every flood
  // watch in the country is not worth a single request.
  const needing = alerts
    .filter((a) => !a.geometry && a.affectedZones.length && /Tornado/.test(a.event))
    .sort((a, b) => b.sent.getTime() - a.sent.getTime());
  if (!needing.length) return alerts;

  // One polygon per zone, so the result is a genuine MultiPolygon rather than
  // every county's rings tipped into a single bag.
  const collected = new Map<string, number[][][][]>();
  const jobs: (() => Promise<void>)[] = [];

  for (const alert of needing) {
    if (jobs.length >= MAX_ZONES_PER_REFRESH) break;
    const polygons: number[][][][] = [];
    collected.set(alert.id, polygons);
    const room = MAX_ZONES_PER_REFRESH - jobs.length;
    for (const url of alert.affectedZones.slice(0, Math.min(MAX_ZONES_PER_ALERT, room))) {
      jobs.push(async () => {
        const rings = await fetchZone(url, signal);
        if (rings?.length) polygons.push(rings);
      });
    }
  }

  await inBatches(jobs, ZONE_CONCURRENCY);

  const patched = new Map<string, Alert['geometry']>();
  for (const [id, polygons] of collected) {
    if (polygons.length) patched.set(id, { type: 'MultiPolygon', coordinates: polygons });
  }
  if (!patched.size) return alerts;

  return alerts.map((a) => (patched.has(a.id) ? { ...a, geometry: patched.get(a.id)! } : a));
}
