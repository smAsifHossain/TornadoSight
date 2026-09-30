import { describe, expect, it } from 'vitest';
import {
  distanceFactor,
  exposureFromPoints,
  facilityExposure,
  ramp,
  responderPriority,
  warningScore,
  weatherSeverity,
  type Facility,
} from './scoring';
import { normalizeAlert, parseStormMotion } from './nws';
import { destination, distanceMiles } from './geo';

/* ------------------------------------------------------------------ *
 * Storm motion
 * ------------------------------------------------------------------ */

describe('parseStormMotion', () => {
  const sample = '2026-09-26T04:11:00-00:00...storm...250DEG...19KT...34.65,-102.78';

  it('reads bearing, speed and position from the live format', () => {
    const m = parseStormMotion(sample)!;
    expect(m.fromBearing).toBe(250);
    expect(m.speedKnots).toBe(19);
    expect(m.position).toEqual({ lat: 34.65, lon: -102.78 });
  });

  it('treats the bearing as the direction the storm comes FROM', () => {
    // Verified against the narrative text of real alerts: 259DEG reads as
    // "moving east", 241DEG reads as "moving northeast". A storm reported at
    // 250DEG is travelling toward 070, which is east north east.
    expect(parseStormMotion(sample)!.heading).toBe(70);
    expect(parseStormMotion('2026-09-26T04:11:00-00:00...storm...259DEG...19KT...1,2')!.heading).toBe(79);
    expect(parseStormMotion('2026-09-26T04:11:00-00:00...storm...241DEG...21KT...1,2')!.heading).toBe(61);
    expect(parseStormMotion('2026-09-26T04:11:00-00:00...storm...010DEG...20KT...1,2')!.heading).toBe(190);
  });

  it('converts knots to miles per hour', () => {
    // The narrative for this alert rounds to 25 mph; we keep the exact value.
    expect(parseStormMotion(sample)!.speedMph).toBeCloseTo(21.86, 2);
  });

  it('returns null rather than guessing when the field is absent or malformed', () => {
    expect(parseStormMotion(null)).toBeNull();
    expect(parseStormMotion('')).toBeNull();
    expect(parseStormMotion('2026-09-26T04:11:00-00:00...storm')).toBeNull();
    expect(parseStormMotion('nonsense...storm...250DEG...19KT...1,2')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Weather severity
 * ------------------------------------------------------------------ */

describe('weatherSeverity', () => {
  it('scores a violently unstable environment near the top', () => {
    const r = weatherSeverity({
      cape: 4000,
      liftedIndex: -9,
      windGustMph: 80,
      windSpeedMph: 45,
      dewPointF: 74,
      precipitationMmH: 20,
      pressureMslHpa: 980,
    });
    expect(r.score).toBeGreaterThan(0.95);
  });

  it('scores a calm fair weather day near zero', () => {
    const r = weatherSeverity({
      cape: 20,
      liftedIndex: 6,
      windGustMph: 8,
      windSpeedMph: 3,
      dewPointF: 40,
      precipitationMmH: 0,
      pressureMslHpa: 1025,
    });
    expect(r.score).toBeLessThan(0.05);
  });

  // Regression: the Phase 2 formula weighted raw pressure positively, which
  // meant a fair weather high scored as more severe than a deep surface low.
  it('treats falling pressure as more severe, not less', () => {
    const base = {
      cape: 1500,
      liftedIndex: -3,
      windGustMph: 40,
      windSpeedMph: 20,
      dewPointF: 65,
      precipitationMmH: 5,
    };
    const low = weatherSeverity({ ...base, pressureMslHpa: 985 });
    const high = weatherSeverity({ ...base, pressureMslHpa: 1025 });
    expect(low.score).toBeGreaterThan(high.score);
  });

  // Regression: raw variables in different units were previously summed
  // directly. Every term must be 0..1 before it is weighted.
  it('normalises every term into 0..1 before weighting', () => {
    const r = weatherSeverity({ cape: 99999, windGustMph: 400, pressureMslHpa: 500 });
    for (const t of r.terms) {
      expect(t.value).toBeGreaterThanOrEqual(0);
      expect(t.value).toBeLessThanOrEqual(1);
    }
    expect(r.score).toBeLessThanOrEqual(1);
  });

  it('redistributes weight across the inputs that are present', () => {
    const partial = weatherSeverity({ windGustMph: 75 });
    // Gust alone at the top of its ramp should carry the whole score, not the
    // 0.25 it would contribute if the missing terms counted as zero.
    expect(partial.score).toBeCloseTo(1, 5);
    expect(partial.missing.length).toBeGreaterThan(0);
  });

  it('reports zero when nothing at all is available', () => {
    expect(weatherSeverity({}).score).toBe(0);
  });

  it('ramps backwards when lo is greater than hi', () => {
    expect(ramp(1018, 1018, 985)).toBe(0);
    expect(ramp(985, 1018, 985)).toBe(1);
    expect(ramp(1001.5, 1018, 985)).toBeCloseTo(0.5, 2);
  });
});

/* ------------------------------------------------------------------ *
 * Warning score
 * ------------------------------------------------------------------ */

function alertOf(event: string, params: Record<string, string[]> = {}) {
  return normalizeAlert({
    properties: {
      id: `urn:${event}`,
      event,
      severity: 'Severe',
      certainty: 'Observed',
      urgency: 'Immediate',
      sent: '2026-09-26T04:11:00Z',
      areaDesc: 'Test County',
      description: '',
      parameters: params,
    },
    geometry: null,
  })!;
}

describe('warningScore', () => {
  it('ranks tornado warnings above watches above thunderstorm warnings', () => {
    const tw = warningScore([alertOf('Tornado Warning')]).score;
    const twatch = warningScore([alertOf('Tornado Watch')]).score;
    const svr = warningScore([alertOf('Severe Thunderstorm Warning')]).score;
    expect(tw).toBeGreaterThan(twatch);
    expect(twatch).toBeGreaterThan(svr);
  });

  it('ignores alerts that have nothing to do with the scenario', () => {
    expect(warningScore([alertOf('Rip Current Statement')]).score).toBe(0);
    expect(warningScore([alertOf('Small Craft Advisory')]).score).toBe(0);
  });

  it('does not let an irrelevant alert dilute a real one', () => {
    const mixed = warningScore([alertOf('Rip Current Statement'), alertOf('Tornado Warning')]);
    expect(mixed.score).toBe(1);
  });

  it('ranks an observed tornado above one that is only radar indicated', () => {
    const observed = warningScore([
      alertOf('Tornado Warning', { tornadoDetection: ['OBSERVED'] }),
    ]).score;
    const radar = warningScore([
      alertOf('Tornado Warning', { tornadoDetection: ['RADAR INDICATED'] }),
    ]).score;
    expect(observed).toBeGreaterThan(radar);
  });

  it('scores zero with no alerts at all', () => {
    expect(warningScore([]).score).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Facility exposure
 * ------------------------------------------------------------------ */

const ORIGIN = { lat: 37.69, lon: -97.34 };

function facilityAt(id: string, kind: Facility['kind'], bearing: number, miles: number): Facility {
  const p = destination(ORIGIN, bearing, miles);
  return { id, kind, name: id, lat: p.lat, lon: p.lon };
}

describe('facilityExposure', () => {
  // Regression: min(points / 10, 1) hit its cap almost immediately in any city,
  // after which every report scored an identical 1.0 on this term.
  it('keeps separating dense areas instead of capping out', () => {
    const modest = exposureFromPoints(10);
    const dense = exposureFromPoints(25);
    const extreme = exposureFromPoints(60);
    expect(modest).toBeLessThan(dense);
    expect(dense).toBeLessThan(extreme);
    expect(extreme).toBeLessThanOrEqual(1);
  });

  // Regression: the old step bands made 0.99 miles worth ten times 1.01 miles.
  it('decays smoothly with distance, with no cliff at a band edge', () => {
    const justInside = distanceFactor(0.99);
    const justOutside = distanceFactor(1.01);
    expect(Math.abs(justInside - justOutside)).toBeLessThan(0.01);
  });

  it('weights a hospital above a school at the same distance', () => {
    const hospital = facilityExposure(ORIGIN, [facilityAt('h', 'hospital', 90, 1)]);
    const school = facilityExposure(ORIGIN, [facilityAt('s', 'school', 90, 1)]);
    expect(hospital.score).toBeGreaterThan(school.score);
  });

  it('ignores facilities beyond the search radius', () => {
    const r = facilityExposure(ORIGIN, [facilityAt('far', 'hospital', 90, 40)], { radiusMiles: 10 });
    expect(r.facilities).toHaveLength(0);
    expect(r.score).toBe(0);
  });

  it('computes time to impact for a facility in the projected path', () => {
    // Storm heading due east at 30 mph, hospital 10 miles due east.
    const hospital = facilityAt('ahead', 'hospital', 90, 10);
    const r = facilityExposure(ORIGIN, [hospital], {
      motion: { heading: 90, speedMph: 30 },
      projectionMinutes: 45,
      radiusMiles: 20,
    });
    const hit = r.facilities[0];
    expect(hit.minutesToImpact).not.toBeNull();
    // Ten miles at thirty miles per hour is twenty minutes.
    expect(hit.minutesToImpact!).toBeCloseTo(20, 0);
  });

  it('does not put a facility behind the storm in the path', () => {
    const behind = facilityAt('behind', 'hospital', 270, 8);
    const r = facilityExposure(ORIGIN, [behind], {
      motion: { heading: 90, speedMph: 30 },
      radiusMiles: 20,
    });
    expect(r.facilities[0].minutesToImpact).toBeNull();
  });

  it('ranks a facility in the path above an equally distant one beside it', () => {
    const inPath = facilityAt('ahead', 'hospital', 90, 8);
    const offPath = facilityAt('aside', 'hospital', 0, 8);
    const r = facilityExposure(ORIGIN, [offPath, inPath], {
      motion: { heading: 90, speedMph: 30 },
      radiusMiles: 20,
    });
    expect(r.facilities[0].id).toBe('ahead');
    expect(r.facilities[0].contribution).toBeGreaterThan(r.facilities[1].contribution);
  });
});

/* ------------------------------------------------------------------ *
 * Fusion
 * ------------------------------------------------------------------ */

const EMPTY_EXPOSURE = facilityExposure(ORIGIN, []);

describe('responderPriority', () => {
  it('sends a confirmed tornado over critical infrastructure to High', () => {
    const r = responderPriority({
      imageConfidence: 0.9,
      warning: warningScore([alertOf('Tornado Warning', { tornadoDetection: ['OBSERVED'] })]),
      weather: weatherSeverity({ cape: 3000, windGustMph: 70, dewPointF: 72, pressureMslHpa: 990 }),
      exposure: facilityExposure(ORIGIN, [facilityAt('h', 'hospital', 90, 4)], {
        motion: { heading: 90, speedMph: 35 },
        radiusMiles: 20,
      }),
    });
    expect(r.band).toBe('High');
  });

  it('keeps a quiet day with no warning at Low', () => {
    const r = responderPriority({
      imageConfidence: 0.1,
      warning: warningScore([]),
      weather: weatherSeverity({ cape: 30, windGustMph: 6, dewPointF: 41, pressureMslHpa: 1022 }),
      exposure: EMPTY_EXPOSURE,
    });
    expect(r.band).toBe('Low');
  });

  // A report arriving without a photo must not be treated as safer than one
  // with a photo. Scoring the missing signal as zero would do exactly that.
  it('redistributes weight instead of penalising a report with no photo', () => {
    const shared = {
      warning: warningScore([alertOf('Tornado Warning')]),
      weather: weatherSeverity({ cape: 2500, windGustMph: 60, dewPointF: 70, pressureMslHpa: 995 }),
      exposure: EMPTY_EXPOSURE,
    };
    const withoutPhoto = responderPriority({ ...shared, imageConfidence: null });
    const withZeroPhoto = responderPriority({ ...shared, imageConfidence: 0 });
    expect(withoutPhoto.score).toBeGreaterThan(withZeroPhoto.score);
    expect(withoutPhoto.contributions.map((c) => c.weight).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it('always has weights summing to one', () => {
    for (const imageConfidence of [null, 0, 0.5, 1]) {
      const r = responderPriority({
        imageConfidence,
        warning: warningScore([]),
        weather: weatherSeverity({ cape: 100 }),
        exposure: EMPTY_EXPOSURE,
      });
      const sum = r.contributions.reduce((a, c) => a + c.weight, 0);
      expect(sum).toBeCloseTo(1, 6);
    }
  });

  it('flags an uncertain image for a person rather than burying it in a number', () => {
    const r = responderPriority({
      imageConfidence: 0.5,
      imageUncertain: true,
      warning: warningScore([]),
      weather: weatherSeverity({ cape: 800 }),
      exposure: EMPTY_EXPOSURE,
    });
    expect(r.band).toBe('Needs Review');
  });

  it('explains itself in every case', () => {
    const r = responderPriority({
      imageConfidence: 0.8,
      warning: warningScore([alertOf('Tornado Warning')]),
      weather: weatherSeverity({ cape: 2000 }),
      exposure: EMPTY_EXPOSURE,
    });
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.contributions.length).toBe(4);
  });
});

/* ------------------------------------------------------------------ *
 * Geodesy sanity
 * ------------------------------------------------------------------ */

describe('geo', () => {
  it('round trips a destination back to the same distance', () => {
    const p = destination(ORIGIN, 47, 12.5);
    expect(distanceMiles(ORIGIN, p)).toBeCloseTo(12.5, 3);
  });

  it('matches a known distance, Wichita to Kansas City', () => {
    const wichita = { lat: 37.6872, lon: -97.3301 };
    const kansasCity = { lat: 39.0997, lon: -94.5786 };
    expect(distanceMiles(wichita, kansasCity)).toBeCloseTo(178, -1);
  });
});
