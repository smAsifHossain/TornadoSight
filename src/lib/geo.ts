/**
 * Geodesy helpers.
 *
 * Distances are in miles because that is what United States emergency
 * responders and National Weather Service products use. Bearings are degrees
 * clockwise from true north.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_MILES = 3958.7613;
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export const KNOTS_TO_MPH = 1.150779;

/** Great circle distance in miles. */
export function distanceMiles(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from `a` to `b`, in degrees clockwise from north. */
export function bearingDegrees(a: LatLon, b: LatLon): number {
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * RAD + 360) % 360;
}

/** The point reached by travelling `miles` from `origin` along `bearing`. */
export function destination(origin: LatLon, bearingDeg: number, miles: number): LatLon {
  const ang = miles / EARTH_RADIUS_MILES;
  const brg = bearingDeg * DEG;
  const lat1 = origin.lat * DEG;
  const lon1 = origin.lon * DEG;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(brg),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brg) * Math.sin(ang) * Math.cos(lat1),
      Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: lat2 * RAD, lon: (((lon2 * RAD + 540) % 360) - 180) };
}

/**
 * Shortest distance in miles from `point` to the segment `a`..`b`, plus how far
 * along that segment the closest approach happens. `t` is clamped to 0..1, so
 * `t === 0` means the closest point is `a` and `t === 1` means it is `b`.
 *
 * Works in a local flat approximation, which is accurate well beyond the tens of
 * miles a storm corridor spans.
 */
export function distanceToSegmentMiles(
  point: LatLon,
  a: LatLon,
  b: LatLon,
): { miles: number; t: number } {
  const latScale = 69.0546;
  const midLat = ((a.lat + b.lat) / 2) * DEG;
  const lonScale = latScale * Math.cos(midLat);

  const px = (point.lon - a.lon) * lonScale;
  const py = (point.lat - a.lat) * latScale;
  const bx = (b.lon - a.lon) * lonScale;
  const by = (b.lat - a.lat) * latScale;

  const lenSq = bx * bx + by * by;
  if (lenSq === 0) return { miles: Math.hypot(px, py), t: 0 };

  const t = Math.max(0, Math.min(1, (px * bx + py * by) / lenSq));
  const dx = px - t * bx;
  const dy = py - t * by;
  return { miles: Math.hypot(dx, dy), t };
}

/** Ray casting point in polygon. `ring` is a closed or open list of positions. */
export function pointInRing(point: LatLon, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > point.lat !== yj > point.lat &&
      point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Point in polygon for a GeoJSON Polygon or MultiPolygon coordinate array.
 * Honours holes: a point inside an interior ring is outside the polygon.
 */
export function pointInPolygon(
  point: LatLon,
  coordinates: number[][][] | number[][][][],
  type: 'Polygon' | 'MultiPolygon',
): boolean {
  const polygons = (
    type === 'Polygon' ? [coordinates] : coordinates
  ) as unknown as [number, number][][][];
  for (const rings of polygons) {
    if (!rings.length) continue;
    if (!pointInRing(point, rings[0])) continue;
    let inHole = false;
    for (let i = 1; i < rings.length; i++) {
      if (pointInRing(point, rings[i])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

/** Axis aligned bounds of a GeoJSON coordinate array. */
export function boundsOf(
  coordinates: number[][][] | number[][][][],
  type: 'Polygon' | 'MultiPolygon',
): { west: number; south: number; east: number; north: number } | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const polygons = (
    type === 'Polygon' ? [coordinates] : coordinates
  ) as unknown as [number, number][][][];
  for (const rings of polygons) {
    for (const ring of rings) {
      for (const [lon, lat] of ring) {
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
    }
  }
  return Number.isFinite(west) ? { west, south, east, north } : null;
}

/** Centroid of a polygon's outer ring, good enough for placing a marker. */
export function ringCentroid(ring: [number, number][]): LatLon {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const f = xj * yi - xi * yj;
    area += f;
    cx += (xj + xi) * f;
    cy += (yj + yi) * f;
  }
  if (area === 0) {
    const [lon, lat] = ring[0] ?? [0, 0];
    return { lat, lon };
  }
  area *= 0.5;
  return { lat: cy / (6 * area), lon: cx / (6 * area) };
}
