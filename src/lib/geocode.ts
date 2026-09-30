/**
 * Place search, so a responder can jump to a community, county or state by
 * name rather than panning a map under pressure.
 *
 * Open-Meteo's geocoding service is used because it is free, needs no key and
 * sends permissive CORS headers, keeping the app serverless.
 */

export interface Place {
  id: number;
  name: string;
  admin1: string | null;
  country: string | null;
  lat: number;
  lon: number;
  population: number | null;
}

const ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search';

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  const term = query.trim();
  if (term.length < 2) return [];

  const q = new URLSearchParams({ name: term, count: '8', language: 'en', format: 'json' });
  const res = await fetch(`${ENDPOINT}?${q}`, { signal });
  if (!res.ok) throw new Error(`Place search failed with ${res.status}`);

  const data = (await res.json()) as {
    results?: {
      id: number;
      name: string;
      admin1?: string;
      country?: string;
      latitude: number;
      longitude: number;
      population?: number;
    }[];
  };

  return (data.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    admin1: r.admin1 ?? null,
    country: r.country ?? null,
    lat: r.latitude,
    lon: r.longitude,
    population: r.population ?? null,
  }));
}

export function placeLabel(place: Place): string {
  return [place.name, place.admin1, place.country].filter(Boolean).join(', ');
}
