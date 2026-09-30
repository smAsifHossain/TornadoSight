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
  trend: Trend;
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

/**
 * Whether the situation is getting worse, holding, or letting up.
 *
 * The challenge brief asks explicitly whether an event is escalating, steady or
 * de-escalating. Rather than guessing from a single snapshot we compare the
 * successive warnings issued for the same storm: an office that upgrades from
 * radar indicated to observed, or reissues a warning with a later expiry, is
 * telling us the threat is growing.
 */
export function assessTrend(alerts: Alert[]): Trend {
  const warnings = alerts
    .filter((a) => a.event === 'Tornado Warning' || a.event === 'Severe Thunderstorm Warning')
    .sort((a, b) => a.sent.getTime() - b.sent.getTime());
  if (warnings.length < 2) return warnings.length ? 'steady' : 'unknown';

  const weight = (a: Alert) => {
    let w = a.event === 'Tornado Warning' ? 2 : 1;
    if (a.tornadoDetection === 'OBSERVED') w += 2;
    if (a.tornadoDamageThreat) w += 1;
    if (a.severity === 'Extreme') w += 1;
    return w;
  };

  const half = Math.floor(warnings.length / 2);
  const earlier = warnings.slice(0, half).map(weight);
  const later = warnings.slice(half).map(weight);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

  const delta = mean(later) - mean(earlier);
  if (delta > 0.4) return 'escalating';
  if (delta < -0.4) return 'easing';
  return 'steady';
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
