import { useCallback, useEffect, useRef } from 'react';
import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import type { Alert } from '../lib/nws';
import type { ExposedFacility } from '../lib/scoring';
import { destination, type LatLon } from '../lib/geo';
import type { StoredReport } from '../lib/storage';

/**
 * The operational picture.
 *
 * Layer order is deliberate and follows how a responder reads the screen:
 * radar underneath for context, then warning polygons, then the projected storm
 * corridor, then infrastructure, and reports on top because a report is the
 * thing a person has to act on.
 */

const VECTOR_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

/** Iowa Environmental Mesonet NEXRAD base reflectivity, free and key-less. */
const RADAR_TILES = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png';

/**
 * Warning colours follow National Weather Service convention so that anyone who
 * has used a weather product before already knows what red means here.
 */
const ALERT_COLOR: Record<string, string> = {
  'Tornado Warning': '#ff2d2d',
  'Extreme Wind Warning': '#ff4081',
  'Tornado Watch': '#ff9800',
  'Severe Thunderstorm Warning': '#ffd54f',
  'Severe Thunderstorm Watch': '#bcaaa4',
  'Flash Flood Warning': '#43a047',
  'Flood Warning': '#2e7d32',
  'Special Weather Statement': '#90a4ae',
};
const ALERT_FALLBACK = '#78909c';

const FACILITY_COLOR: Record<string, string> = {
  hospital: '#ff5252',
  nursing_home: '#ff7ab2',
  school: '#ffca28',
  fire_station: '#ff8a65',
  police: '#64b5f6',
  power_substation: '#ba68c8',
  communication_tower: '#4dd0e1',
  shelter: '#81c784',
  transport: '#a1887f',
  other: '#90a4ae',
};

export interface MapViewProps {
  alerts: Alert[];
  facilities: ExposedFacility[];
  reports: StoredReport[];
  point: LatLon | null;
  tracked: Alert | null;
  projectionMinutes: number;
  showRadar: boolean;
  showFacilities: boolean;
  theme: 'dark' | 'light';
  fitBounds: [number, number, number, number] | null;
  onSelectPoint: (p: LatLon) => void;
}

function alertsToGeoJson(alerts: Alert[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: alerts
      .filter((a) => a.geometry)
      .map((a) => ({
        type: 'Feature',
        geometry: a.geometry as unknown as GeoJSON.Geometry,
        properties: {
          id: a.id,
          event: a.event,
          areaDesc: a.areaDesc,
          color: ALERT_COLOR[a.event] ?? ALERT_FALLBACK,
          detection: a.tornadoDetection ?? '',
          expires: a.expires ? a.expires.toISOString() : '',
          sender: a.senderName,
        },
      })),
  };
}

/**
 * The projected path: a centreline from where radar last placed the storm, and
 * a corridor around it. This is the piece that turns "there is a warning" into
 * "this hospital has eleven minutes".
 */
function pathToGeoJson(
  tracked: Alert | null,
  minutes: number,
  halfWidthMiles = 2.5,
): { line: GeoJSON.FeatureCollection; corridor: GeoJSON.FeatureCollection; head: GeoJSON.FeatureCollection } {
  const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
  if (!tracked?.motion || tracked.motion.speedMph <= 0) {
    return { line: empty, corridor: empty, head: empty };
  }

  const { position, heading, speedMph } = tracked.motion;
  const end = destination(position, heading, (speedMph * minutes) / 60);

  const left = heading - 90;
  const right = heading + 90;
  const ring = [
    destination(position, left, halfWidthMiles),
    destination(end, left, halfWidthMiles),
    destination(end, right, halfWidthMiles),
    destination(position, right, halfWidthMiles),
  ].map((p) => [p.lon, p.lat]);
  ring.push(ring[0]);

  return {
    line: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [position.lon, position.lat],
              [end.lon, end.lat],
            ],
          },
          properties: { minutes },
        },
      ],
    },
    corridor: {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} }],
    },
    head: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [position.lon, position.lat] },
          properties: { heading, speed: Math.round(speedMph), event: tracked.event },
        },
      ],
    },
  };
}

function facilitiesToGeoJson(facilities: ExposedFacility[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: facilities.map((f) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
      properties: {
        name: f.name,
        kind: f.kind,
        color: FACILITY_COLOR[f.kind] ?? FACILITY_COLOR.other,
        inPath: f.minutesToImpact !== null ? 1 : 0,
        minutes: f.minutesToImpact === null ? -1 : Math.round(f.minutesToImpact),
        distance: Number(f.distanceMiles.toFixed(1)),
      },
    })),
  };
}

function reportsToGeoJson(reports: StoredReport[]): GeoJSON.FeatureCollection {
  const bandColor: Record<string, string> = {
    High: '#ff5252',
    Medium: '#ffa726',
    Low: '#2dd4a7',
    'Needs Review': '#a78bfa',
  };
  return {
    type: 'FeatureCollection',
    features: reports.map((r) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
      properties: {
        id: r.id,
        band: r.band,
        color: bandColor[r.band] ?? '#90a4ae',
        score: Math.round(r.priorityScore * 100),
      },
    })),
  };
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export default function MapView(props: MapViewProps) {
  const {
    alerts,
    facilities,
    reports,
    point,
    tracked,
    projectionMinutes,
    showRadar,
    showFacilities,
    theme,
    fitBounds,
    onSelectPoint,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  const observerRef = useRef<ResizeObserver | null>(null);
  const onSelectRef = useRef(onSelectPoint);
  onSelectRef.current = onSelectPoint;

  const setData = useCallback((id: string, data: GeoJSON.FeatureCollection) => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const source = map.getSource(id) as GeoJSONSource | undefined;
    source?.setData(data);
  }, []);

  /* Create the map once. */
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: VECTOR_STYLE,
      center: [-97.34, 37.69],
      zoom: 5,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(
      new maplibregl.GeolocateControl({ trackUserLocation: false, positionOptions: { enableHighAccuracy: true } }),
      'top-right',
    );
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');

    map.on('load', () => {
      for (const id of ['alerts', 'corridor', 'path', 'stormhead', 'facilities', 'reports', 'picked']) {
        map.addSource(id, { type: 'geojson', data: EMPTY });
      }

      map.addSource('radar', {
        type: 'raster',
        tiles: [RADAR_TILES],
        tileSize: 256,
        attribution: 'Radar: Iowa Environmental Mesonet',
      });
      map.addLayer({
        id: 'radar-layer',
        type: 'raster',
        source: 'radar',
        paint: { 'raster-opacity': 0.55 },
        layout: { visibility: 'none' },
      });

      map.addLayer({
        id: 'alert-fill',
        type: 'fill',
        source: 'alerts',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.18 },
      });
      map.addLayer({
        id: 'alert-line',
        type: 'line',
        source: 'alerts',
        paint: { 'line-color': ['get', 'color'], 'line-width': 2 },
      });

      map.addLayer({
        id: 'corridor-fill',
        type: 'fill',
        source: 'corridor',
        paint: { 'fill-color': '#ff2d2d', 'fill-opacity': 0.12 },
      });
      map.addLayer({
        id: 'path-line',
        type: 'line',
        source: 'path',
        paint: { 'line-color': '#ff2d2d', 'line-width': 3, 'line-dasharray': [2, 1.5] },
      });
      map.addLayer({
        id: 'stormhead-halo',
        type: 'circle',
        source: 'stormhead',
        paint: {
          'circle-radius': 14,
          'circle-color': '#ff2d2d',
          'circle-opacity': 0.25,
        },
      });
      map.addLayer({
        id: 'stormhead-dot',
        type: 'circle',
        source: 'stormhead',
        paint: {
          'circle-radius': 6,
          'circle-color': '#ff2d2d',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });

      map.addLayer({
        id: 'facility-dot',
        type: 'circle',
        source: 'facilities',
        paint: {
          'circle-radius': ['case', ['==', ['get', 'inPath'], 1], 7, 4],
          'circle-color': ['get', 'color'],
          'circle-stroke-width': ['case', ['==', ['get', 'inPath'], 1], 2, 0.5],
          'circle-stroke-color': ['case', ['==', ['get', 'inPath'], 1], '#ffffff', '#00000055'],
        },
      });

      map.addLayer({
        id: 'report-dot',
        type: 'circle',
        source: 'reports',
        paint: {
          'circle-radius': 9,
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#0a0e14',
        },
      });

      map.addLayer({
        id: 'picked-ring',
        type: 'circle',
        source: 'picked',
        paint: {
          'circle-radius': 9,
          'circle-color': 'transparent',
          'circle-stroke-width': 3,
          'circle-stroke-color': '#38bdf8',
        },
      });

      readyRef.current = true;
      map.fire('tornadosight.ready');
    });

    // The panel collapses and expands, and the bottom sheet changes height on a
    // phone, so the canvas has to follow its container rather than only the
    // window. Without this the map keeps whatever size it had at creation.
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);
    observerRef.current = observer;

    map.on('click', (e) => {
      // Clicking a facility or a report opens its detail instead of moving the
      // selection, which is what a person expects from a marker.
      const hits = map.queryRenderedFeatures(e.point, { layers: ['facility-dot', 'report-dot'] });
      if (hits.length) return;
      onSelectRef.current({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    });

    for (const layer of ['facility-dot', 'report-dot', 'alert-fill', 'stormhead-dot']) {
      map.on('mouseenter', layer, () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', layer, () => {
        map.getCanvas().style.cursor = '';
      });
    }

    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '260px' });

    map.on('click', 'facility-dot', (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as Record<string, string | number>;
      const timing =
        Number(p.minutes) >= 0
          ? `<strong style="color:#ff5252">In the projected path, about ${p.minutes} minutes away</strong>`
          : `${p.distance} miles from the storm`;
      popup
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-size:13px;line-height:1.45"><strong>${escapeHtml(String(p.name))}</strong><br>` +
            `<span style="opacity:.75">${escapeHtml(String(p.kind).replace(/_/g, ' '))}</span><br>${timing}</div>`,
        )
        .addTo(map);
    });

    map.on('click', 'stormhead-dot', (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as Record<string, string | number>;
      popup
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-size:13px;line-height:1.45"><strong>${escapeHtml(String(p.event))}</strong><br>` +
            `Radar placed the storm here, tracking ${p.heading}° at ${p.speed} mph.</div>`,
        )
        .addTo(map);
    });

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
  }, []);

  /* Push data whenever it changes, waiting for the style to finish loading. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      setData('alerts', alertsToGeoJson(alerts));
      const path = pathToGeoJson(tracked, projectionMinutes);
      setData('path', path.line);
      setData('corridor', path.corridor);
      setData('stormhead', path.head);
      setData('facilities', showFacilities ? facilitiesToGeoJson(facilities) : EMPTY);
      setData('reports', reportsToGeoJson(reports));
      setData(
        'picked',
        point
          ? {
              type: 'FeatureCollection',
              features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [point.lon, point.lat] }, properties: {} },
              ],
            }
          : EMPTY,
      );
    };
    if (readyRef.current) apply();
    else map.once('tornadosight.ready', apply);
  }, [alerts, facilities, reports, point, tracked, projectionMinutes, showFacilities, setData]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    if (map.getLayer('radar-layer')) {
      map.setLayoutProperty('radar-layer', 'visibility', showRadar ? 'visible' : 'none');
    }
  }, [showRadar]);

  /* Dim the basemap in dark mode so the warning colours carry the screen. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const canvas = map.getCanvasContainer();
      canvas.style.filter =
        theme === 'dark' ? 'brightness(0.62) saturate(0.75) contrast(1.06)' : 'none';
    };
    if (readyRef.current) apply();
    else map.once('tornadosight.ready', apply);
  }, [theme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitBounds) return;
    const apply = () =>
      map.fitBounds(
        [
          [fitBounds[0], fitBounds[1]],
          [fitBounds[2], fitBounds[3]],
        ],
        { padding: 64, duration: 900, maxZoom: 11 },
      );
    if (readyRef.current) apply();
    else map.once('tornadosight.ready', apply);
  }, [fitBounds]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      role="application"
      aria-label="Map of active severe weather warnings, critical infrastructure and storm reports"
    />
  );
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

export { ALERT_COLOR, FACILITY_COLOR };
