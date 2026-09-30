/**
 * Turns the raw feeds into the one object the interface renders from.
 *
 * Keeping this outside React means the whole decision path, from alerts and
 * weather to the priority band, can be tested without mounting a component.
 */

import { boundsOf, distanceMiles, pointInPolygon, ringCentroid, type LatLon } from './geo';
import type { Alert } from './nws';
import {
  facilityExposure,
  responderPriority,
  warningScore,
  weatherSeverity,
  type ComponentScore,
  type ExposureResult,
  type Facility,
  type PriorityResult,
} from './scoring';
import type { WeatherSnapshot } from './openmeteo';

export type Trend = 'escalating' | 'steady' | 'easing' | 'unknown';

export interface Situation {
  point: LatLon;
  /** Alerts whose polygon contains the point, most severe first. */
  local: Alert[];
  /** Every alert in view, for the map. */
  nearby: Alert[];
  weather: WeatherSnapshot | null;
  warning: ComponentScore;
  weatherScore: ComponentScore;
  exposure: ExposureResult;
  priority: PriorityResult;
  /** The alert driving the storm track, if any. */
  tracked: Alert | null;
  trend: TrendResult;
}

/** Alerts whose polygon actually contains the point. */
export function alertsCovering(point: LatLon, alerts: Alert[]): Alert[] {
  return alerts.filter(
    (a) => a.geometry && pointInPolygon(point, a.geometry.coordinates, a.geometry.type),
  );
}

/** Alerts whose polygon falls within `miles` of the point. */
export function alertsNear(point: LatLon, alerts: Alert[], miles: number): Alert[] {
  return alerts.filter((a) => {
    if (!a.geometry) return false;
    if (pointInPolygon(point, a.geometry.coordinates, a.geometry.type)) return true;
    const b = boundsOf(a.geometry.coordinates, a.geometry.type);
    if (!b) return false;
    const centre = { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
    // Add the polygon's own radius so a large county warning still counts.
    const radius = distanceMiles(centre, { lat: b.north, lon: b.east });
    return distanceMiles(point, centre) <= miles + radius;
  });
}

const EVENT_RANK: Record<string, number> = {
  'Tornado Warning': 6,
  'Extreme Wind Warning': 5,
  'Severe Thunderstorm Warning': 4,
  'Tornado Watch': 3,
  'Severe Thunderstorm Watch': 2,
};

export function rankAlerts(alerts: Alert[]): Alert[] {
  return [...alerts].sort((a, b) => {
    const rank = (EVENT_RANK[b.event] ?? 0) - (EVENT_RANK[a.event] ?? 0);
    if (rank !== 0) return rank;
    return b.sent.getTime() - a.sent.getTime();
  });
}

export interface TrendResult {
  state: Trend;
  /** What was actually observed, in plain words, or null when there is nothing. */
  detail: string | null;
  /** How many products for this storm the judgement is based on. */
  products: number;
}

/**
 * How threatening a single product is. Ordered so that each step up is a real
 * operational escalation rather than a cosmetic one.
 */
function threatWeight(a: Alert): number {
  let w = a.event === 'Tornado Warning' ? 3 : 1;
  if (a.tornadoDetection === 'RADAR INDICATED') w += 1;
  if (a.tornadoDetection === 'OBSERVED') w += 3;
  const damage = a.tornadoDamageThreat?.toUpperCase();
  if (damage === 'CONSIDERABLE') w += 2;
  if (damage === 'CATASTROPHIC') w += 4;
  if (a.severity === 'Extreme') w += 1;
  if ((a.maxWindGustMph ?? 0) >= 70) w += 1;
  if ((a.maxHailInches ?? 0) >= 2) w += 1;
  return w;
}

/**
 * Whether the situation is getting worse, holding, or letting up.
 *
 * The brief asks explicitly whether an event is escalating, steady or
 * de-escalating. The judgement is made by following one storm through its own
 * updates, identified by the VTEC tracking number the products carry, rather
 * than by comparing unrelated alerts that happen to be nearby. A weather office
 * that upgrades a warning from radar indicated to observed, or adds a
 * considerable damage threat, is telling you directly that the threat is
 * growing, and that is what this reads.
 */
export function assessTrend(alerts: Alert[]): TrendResult {
  const warnings = alerts.filter(
    (a) => a.event === 'Tornado Warning' || a.event === 'Severe Thunderstorm Warning',
  );
  if (!warnings.length) return { state: 'unknown', detail: null, products: 0 };

  // Group by storm, then follow the most threatening one.
  const storms = new Map<string, Alert[]>();
  for (const a of warnings) {
    const key = a.stormKey ?? `${a.event}:${a.areaDesc}`;
    if (!storms.has(key)) storms.set(key, []);
    storms.get(key)!.push(a);
  }

  let tracked: Alert[] = [];
  let bestWeight = -1;
  for (const group of storms.values()) {
    const peak = Math.max(...group.map(threatWeight));
    if (peak > bestWeight || (peak === bestWeight && group.length > tracked.length)) {
      bestWeight = peak;
      tracked = group;
    }
  }

  tracked.sort((a, b) => a.sent.getTime() - b.sent.getTime());

  if (tracked.length < 2) {
    return {
      state: 'steady',
      detail: `One product so far for this storm, ${tracked[0].event.toLowerCase()} from ${tracked[0].senderName}. Nothing to compare it against yet.`,
      products: tracked.length,
    };
  }

  const first = tracked[0];
  const last = tracked[tracked.length - 1];
  const delta = threatWeight(last) - threatWeight(first);

  // Say what changed, not just that something did.
  const changes: string[] = [];
  if (first.event !== last.event && last.event === 'Tornado Warning') {
    changes.push('upgraded to a tornado warning');
  }
  if (first.tornadoDetection !== 'OBSERVED' && last.tornadoDetection === 'OBSERVED') {
    changes.push('a tornado is now confirmed on the ground');
  }
  if (!first.tornadoDamageThreat && last.tornadoDamageThreat) {
    changes.push(`a ${last.tornadoDamageThreat.toLowerCase()} damage threat was added`);
  }
  if ((last.maxWindGustMph ?? 0) > (first.maxWindGustMph ?? 0)) {
    changes.push(`peak gust raised to ${last.maxWindGustMph} mph`);
  }
  if ((last.maxHailInches ?? 0) > (first.maxHailInches ?? 0)) {
    changes.push(`hail raised to ${last.maxHailInches} inches`);
  }

  // Describe the way down as well as the way up. Reporting only increases let
  // the panel say "easing" above a sentence claiming nothing had changed.
  if (first.event === 'Tornado Warning' && last.event !== 'Tornado Warning') {
    changes.push(`downgraded to a ${last.event.toLowerCase()}`);
  }
  if (first.tornadoDetection === 'OBSERVED' && last.tornadoDetection === 'RADAR INDICATED') {
    changes.push('no longer confirmed on the ground');
  }
  if (first.tornadoDamageThreat && !last.tornadoDamageThreat) {
    changes.push('the damage threat was dropped');
  }
  if ((last.maxWindGustMph ?? 0) < (first.maxWindGustMph ?? 0)) {
    changes.push(`peak gust lowered to ${last.maxWindGustMph} mph`);
  }
  if ((last.maxHailInches ?? 0) < (first.maxHailInches ?? 0)) {
    changes.push(`hail lowered to ${last.maxHailInches} inches`);
  }

  const span = Math.round((last.sent.getTime() - first.sent.getTime()) / 60000);
  const basis = `${tracked.length} products over ${span} minutes from ${last.senderName}`;

  const state: Trend = delta > 0 ? 'escalating' : delta < 0 ? 'easing' : 'steady';
  const detail = changes.length
    ? `${changes.join(', ')}. Based on ${basis}.`
    : `The warning has been reissued without a change in threat. Based on ${basis}.`;

  return { state, detail, products: tracked.length };
}

/** The most recently issued alert that carries a usable motion vector. */
export function trackedAlert(alerts: Alert[]): Alert | null {
  const withMotion = alerts.filter((a) => a.motion && a.motion.speedMph > 0);
  if (!withMotion.length) return null;
  return rankAlerts(withMotion)[0];
}

export interface BuildOptions {
  point: LatLon;
  alerts: Alert[];
  weather: WeatherSnapshot | null;
  facilities: Facility[];
  imageConfidence?: number | null;
  imageUncertain?: boolean;
  projectionMinutes?: number;
  radiusMiles?: number;
}

export function buildSituation(options: BuildOptions): Situation {
  const {
    point,
    alerts,
    weather,
    facilities,
    imageConfidence = null,
    imageUncertain = false,
    projectionMinutes = 45,
    radiusMiles = 12,
  } = options;

  const local = rankAlerts(alertsCovering(point, alerts));
  const nearby = alertsNear(point, alerts, radiusMiles);
  const tracked = trackedAlert(local.length ? local : nearby);

  const warning = warningScore(local);
  const weatherScoreResult = weatherSeverity(weather ?? {});

  // The storm is projected from where radar last placed it, not from where the
  // responder happened to click, otherwise the corridor starts in the wrong
  // place and every time to impact is wrong with it.
  const projectionOrigin = tracked?.motion?.position ?? point;

  const exposure = facilityExposure(projectionOrigin, facilities, {
    motion: tracked?.motion ? { heading: tracked.motion.heading, speedMph: tracked.motion.speedMph } : null,
    projectionMinutes,
    radiusMiles,
  });

  const priority = responderPriority({
    imageConfidence,
    imageUncertain,
    warning,
    weather: weatherScoreResult,
    exposure,
  });

  return {
    point,
    local,
    nearby,
    weather,
    warning,
    weatherScore: weatherScoreResult,
    exposure,
    priority,
    tracked,
    trend: assessTrend(nearby),
  };
}

/** A representative point for an alert, used to drop its marker. */
export function alertAnchor(alert: Alert): LatLon | null {
  if (alert.motion) return alert.motion.position;
  if (!alert.geometry) return null;
  const rings = (
    alert.geometry.type === 'Polygon' ? alert.geometry.coordinates : alert.geometry.coordinates[0]
  ) as unknown as [number, number][][];
  return rings[0] ? ringCentroid(rings[0]) : null;
}
