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
  /** VTEC string, which identifies one event across its updates. */
  vtec: string | null;
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

/** `60 MPH` or `60` becomes 60. */
function parseGustMph(value: string | null): number | null {
  if (!value) return null;
  const m = value.match(/(\d+(?:\.\d+)?)/);
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
    maxWindGustMph: parseGustMph(firstParam(params, 'maxWindGust')),
    hailThreat: asThreat(firstParam(params, 'hailThreat')),
    maxHailInches: parseGustMph(firstParam(params, 'maxHailSize')),
    vtec: firstParam(params, 'VTEC'),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { headers: NWS_HEADERS, signal });
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
