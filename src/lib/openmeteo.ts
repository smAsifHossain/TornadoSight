/**
 * Open-Meteo client.
 *
 * Free, no key, permissive CORS. Beyond the surface variables the concept named
 * we also pull CAPE, lifted index and convective inhibition, which are what
 * actually separate a severe environment from a merely windy one.
 */

import type { LatLon } from './geo';
import type { WeatherInputs } from './scoring';

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

export interface WeatherSnapshot extends WeatherInputs {
  observedAt: Date;
  temperatureF: number | null;
  humidityPct: number | null;
  windDirectionDeg: number | null;
  convectiveInhibition: number | null;
  /** Set when the response was served from the in-memory cache. */
  cached: boolean;
}

const CURRENT = [
  'temperature_2m',
  'relative_humidity_2m',
  'dew_point_2m',
  'precipitation',
  'pressure_msl',
  'wind_speed_10m',
  'wind_gusts_10m',
  'wind_direction_10m',
  'cape',
].join(',');

const HOURLY = ['cape', 'lifted_index', 'convective_inhibition'].join(',');

interface CacheEntry {
  at: number;
  value: WeatherSnapshot;
}

/**
 * Weather at a given place does not change meaningfully inside a couple of
 * minutes, and a responder clicking around the map should not fire a request
 * per click. Keyed to about a kilometre of precision.
 */
const cache = new Map<string, CacheEntry>();
const CACHE_MS = 2 * 60 * 1000;

function keyFor(p: LatLon): string {
  return `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Pick the hourly value whose timestamp is nearest to now. */
function nearestHourly(times: string[] | undefined, values: (number | null)[] | undefined): number | null {
  if (!times?.length || !values?.length) return null;
  const now = Date.now();
  let bestIdx = 0;
  let bestGap = Infinity;
  for (let i = 0; i < times.length; i++) {
    const gap = Math.abs(new Date(times[i]).getTime() - now);
    if (gap < bestGap) {
      bestGap = gap;
      bestIdx = i;
    }
  }
  return num(values[bestIdx]);
}

export async function fetchWeather(
  point: LatLon,
  signal?: AbortSignal,
): Promise<WeatherSnapshot> {
  const key = keyFor(point);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.value, cached: true };

  const q = new URLSearchParams({
    latitude: point.lat.toFixed(4),
    longitude: point.lon.toFixed(4),
    current: CURRENT,
    hourly: HOURLY,
    wind_speed_unit: 'mph',
    temperature_unit: 'fahrenheit',
    precipitation_unit: 'mm',
    forecast_days: '1',
    timezone: 'UTC',
  });

  const res = await fetch(`${ENDPOINT}?${q}`, { signal });
  if (!res.ok) throw new Error(`Open-Meteo request failed with ${res.status}`);
  const data = (await res.json()) as {
    current?: Record<string, unknown>;
    hourly?: { time?: string[]; cape?: number[]; lifted_index?: number[]; convective_inhibition?: number[] };
  };

  const c = data.current ?? {};

  const snapshot: WeatherSnapshot = {
    observedAt: typeof c.time === 'string' ? new Date(`${c.time}Z`) : new Date(),
    temperatureF: num(c.temperature_2m),
    humidityPct: num(c.relative_humidity_2m),
    dewPointF: num(c.dew_point_2m),
    precipitationMmH: num(c.precipitation),
    // pressure_msl, not surface_pressure. Station pressure varies with
    // elevation, so a mountain town would always look like a deep low.
    pressureMslHpa: num(c.pressure_msl),
    windSpeedMph: num(c.wind_speed_10m),
    windGustMph: num(c.wind_gusts_10m),
    windDirectionDeg: num(c.wind_direction_10m),
    cape: num(c.cape) ?? nearestHourly(data.hourly?.time, data.hourly?.cape),
    liftedIndex: nearestHourly(data.hourly?.time, data.hourly?.lifted_index),
    convectiveInhibition: nearestHourly(data.hourly?.time, data.hourly?.convective_inhibition),
    cached: false,
  };

  cache.set(key, { at: Date.now(), value: snapshot });
  return snapshot;
}

/** Compass label for a bearing, for reading aloud in the interface. */
export function compass(deg: number): string {
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return points[Math.round(((deg % 360) / 22.5)) % 16];
}
