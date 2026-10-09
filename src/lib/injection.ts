/**
 * Injection mode: a synthetic storm with every input under the operator's hand.
 *
 * Live mode shows the world as it is, and replay shows a storm that genuinely
 * happened. Neither lets you ask "what would this system do with a confirmed
 * tornado at 50 mph heading at a hospital" on a quiet Tuesday, which is exactly
 * the question someone evaluating it wants answered. Injection mode builds an
 * alert that is shaped like a real one, from values on sliders, so the whole
 * decision path can be driven to any corner of its range in a few seconds.
 *
 * Everything produced here is clearly labelled as injected, in the data and in
 * the interface, so it can never be mistaken for an observation. That is the
 * whole bargain: a test harness is only safe if it is impossible to confuse
 * with the real thing.
 */

import { destination, type LatLon } from './geo';
import type { Alert, ThreatLevel } from './nws';

export interface InjectionSettings {
  event: 'Tornado Warning' | 'Tornado Watch' | 'Severe Thunderstorm Warning' | 'None';
  detection: ThreatLevel;
  damageThreat: '' | 'CONSIDERABLE' | 'CATASTROPHIC';
  /** Direction of travel, degrees clockwise from north. */
  heading: number;
  speedMph: number;
  maxWindGustMph: number;
  maxHailInches: number;
  /** Minutes the warning still has to run. */
  minutesRemaining: number;
  weather: {
    cape: number;
    liftedIndex: number;
    windGustMph: number;
    windSpeedMph: number;
    dewPointF: number;
    precipitationMmH: number;
    pressureMslHpa: number;
  };
}

export const DEFAULT_INJECTION: InjectionSettings = {
  event: 'Tornado Warning',
  detection: 'RADAR INDICATED',
  damageThreat: '',
  heading: 55,
  speedMph: 35,
  maxWindGustMph: 70,
  maxHailInches: 1.75,
  minutesRemaining: 35,
  weather: {
    cape: 2600,
    liftedIndex: -6,
    windGustMph: 62,
    windSpeedMph: 28,
    dewPointF: 70,
    precipitationMmH: 9,
    pressureMslHpa: 994,
  },
};

/**
 * Presets that correspond to situations a responder would recognise, so the
 * system can be judged against named scenarios rather than arbitrary numbers.
 */
export const INJECTION_PRESETS: { name: string; summary: string; settings: InjectionSettings }[] = [
  {
    name: 'Confirmed tornado, fast mover',
    summary: 'Spotter confirmed, catastrophic damage threat, 50 mph. The worst case the scoring should recognise.',
    settings: {
      ...DEFAULT_INJECTION,
      detection: 'OBSERVED',
      damageThreat: 'CATASTROPHIC',
      speedMph: 50,
      maxWindGustMph: 90,
      minutesRemaining: 25,
      weather: { ...DEFAULT_INJECTION.weather, cape: 3800, liftedIndex: -9, windGustMph: 85, pressureMslHpa: 985 },
    },
  },
  {
    name: 'Radar indicated, marginal',
    summary: 'A warning on radar alone in a weak environment. Should land mid range, not high.',
    settings: {
      ...DEFAULT_INJECTION,
      detection: 'RADAR INDICATED',
      speedMph: 22,
      maxWindGustMph: 55,
      weather: { ...DEFAULT_INJECTION.weather, cape: 900, liftedIndex: -2, windGustMph: 38, dewPointF: 60, pressureMslHpa: 1008 },
    },
  },
  {
    name: 'Severe thunderstorm, hail',
    summary: 'No tornado, large hail. Tests that a non tornadic warning does not score like one.',
    settings: {
      ...DEFAULT_INJECTION,
      event: 'Severe Thunderstorm Warning',
      detection: 'RADAR INDICATED',
      maxHailInches: 2.5,
      speedMph: 30,
      weather: { ...DEFAULT_INJECTION.weather, cape: 2000, liftedIndex: -5, windGustMph: 58 },
    },
  },
  {
    name: 'Quiet day',
    summary: 'No warning and a stable atmosphere. Everything should sit at the bottom.',
    settings: {
      ...DEFAULT_INJECTION,
      event: 'None',
      detection: null,
      speedMph: 0,
      maxWindGustMph: 0,
      maxHailInches: 0,
      weather: { cape: 60, liftedIndex: 5, windGustMph: 9, windSpeedMph: 4, dewPointF: 44, precipitationMmH: 0, pressureMslHpa: 1021 },
    },
  },
];

/**
 * Build an alert in the same shape the National Weather Service feed produces,
 * so it flows through exactly the same scoring path as a real one. The polygon
 * is a corridor swept along the heading, which is what a warning polygon
 * actually looks like for a moving storm.
 */
export function injectedAlert(settings: InjectionSettings, at: LatLon, now = new Date()): Alert | null {
  if (settings.event === 'None') return null;

  const halfWidth = 4;
  const ahead = destination(at, settings.heading, Math.max(6, (settings.speedMph * 40) / 60));
  const behind = destination(at, (settings.heading + 180) % 360, 5);
  const ring = [
    destination(behind, settings.heading - 90, halfWidth),
    destination(ahead, settings.heading - 90, halfWidth),
    destination(ahead, settings.heading + 90, halfWidth),
    destination(behind, settings.heading + 90, halfWidth),
  ].map((p) => [p.lon, p.lat] as [number, number]);
  ring.push(ring[0]);

  const expires = new Date(now.getTime() + settings.minutesRemaining * 60_000);
  // The bearing a real product carries is the direction the storm comes FROM.
  const fromBearing = (settings.heading + 180) % 360;

  return {
    id: `injected:${settings.event}:${now.getTime()}`,
    event: settings.event,
    headline: `${settings.event} (injected test data)`,
    description: 'Injected test data. This is not a National Weather Service product.',
    instruction: null,
    areaDesc: 'Injected test area',
    severity: settings.damageThreat === 'CATASTROPHIC' ? 'Extreme' : 'Severe',
    certainty: settings.detection === 'OBSERVED' ? 'Observed' : 'Likely',
    urgency: 'Immediate',
    sent: now,
    onset: now,
    expires,
    ends: expires,
    senderName: 'Injected test data',
    geometry: { type: 'Polygon', coordinates: [ring] },
    motion:
      settings.speedMph > 0
        ? {
            time: now,
            fromBearing,
            heading: settings.heading,
            speedKnots: settings.speedMph / 1.150779,
            speedMph: settings.speedMph,
            position: at,
          }
        : null,
    tornadoDetection: settings.event === 'Tornado Warning' ? settings.detection : null,
    tornadoDamageThreat: settings.damageThreat || null,
    windThreat: settings.detection,
    maxWindGustMph: settings.maxWindGustMph || null,
    hailThreat: settings.maxHailInches ? 'RADAR INDICATED' : null,
    maxHailInches: settings.maxHailInches || null,
    affectedZones: [],
    vtec: null,
    // A stable key so successive injected products read as one storm and the
    // trend logic has something coherent to follow.
    stormKey: 'INJECT.TEST.0001',
  };
}

/**
 * A second, earlier product for the same injected storm, so Trend has a pair to
 * compare and can be exercised like everything else.
 */
export function injectedHistory(settings: InjectionSettings, at: LatLon, now = new Date()): Alert[] {
  const current = injectedAlert(settings, at, now);
  if (!current) return [];

  const earlier = injectedAlert(
    {
      ...settings,
      // The earlier product is deliberately milder, so an operator who raises
      // the detection or the damage threat sees the trend answer immediately.
      detection: settings.detection === 'OBSERVED' ? 'RADAR INDICATED' : settings.detection,
      damageThreat: '',
      maxWindGustMph: Math.max(0, settings.maxWindGustMph - 15),
    },
    destination(at, (settings.heading + 180) % 360, Math.max(2, (settings.speedMph * 20) / 60)),
    new Date(now.getTime() - 20 * 60_000),
  );

  return earlier ? [earlier, current] : [current];
}
