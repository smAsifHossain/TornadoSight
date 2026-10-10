/**
 * Turn coordinates into a place a person recognises.
 *
 * "34.405 N, 103.205 W" tells a responder nothing they can act on. "Clovis,
 * New Mexico" tells them where to send someone. Coordinates stay on screen
 * because they are exact and a name is not, but the name goes first.
 *
 * BigDataCloud's client endpoint is used rather than the National Weather
 * Service point lookup: both work, but the NWS API already rate limited this
 * client once and a label is not worth spending that budget on.
 */

import type { LatLon } from './geo';

const ENDPOINT = 'https://api.bigdatacloud.net/data/reverse-geocode-client';

/** Rounded to about a kilometre, which is far finer than a place name needs. */
function keyFor(p: LatLon): string {
  return `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
}

const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

/**
 * A human readable place for a point, or null when nothing can be resolved.
 * Never throws: a missing label is a cosmetic loss, not a failure worth
 * surfacing to someone watching a storm.
 */
export async function reverseGeocode(point: LatLon, signal?: AbortSignal): Promise<string | null> {
  const key = keyFor(point);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const existing = inflight.get(key);
  if (existing) return existing;

  const task = (async () => {
    try {
      const q = new URLSearchParams({
        latitude: point.lat.toFixed(4),
        longitude: point.lon.toFixed(4),
        localityLanguage: 'en',
      });
      const res = await fetch(`${ENDPOINT}?${q}`, { signal });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        city?: string;
        locality?: string;
        principalSubdivision?: string;
        countryName?: string;
        countryCode?: string;
      };

      // Work outward from the most specific name that exists. Open country
      // often has no city at all, and a county or state alone is still useful.
      const parts = [
        data.city || data.locality,
        data.principalSubdivision,
        data.countryCode === 'US' ? 'USA' : data.countryName,
      ].filter((s): s is string => Boolean(s && s.trim()));

      const label = parts.length ? [...new Set(parts)].join(', ') : null;
      cache.set(key, label);
      return label;
    } catch (err) {
      /**
       * An abort is not an answer, so it must not be cached as one.
       *
       * React runs effects twice in development: the first call is aborted by
       * its own cleanup, and caching that as "no name here" meant the second
       * call got the failure back instantly and no label ever appeared.
       */
      const aborted = signal?.aborted || (err instanceof DOMException && err.name === 'AbortError');
      if (!aborted) cache.set(key, null);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}
