import { useCallback, useEffect, useRef } from 'react';
import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import type { Alert } from '../lib/nws';
import type { ExposedFacility } from '../lib/scoring';
import { destination, type LatLon } from '../lib/geo';
import type { StoredReport } from '../lib/storage';

/**
 * The operational picture.
 *
 * Reading order drives the layer order. Radar sits underneath for context, then
 * warning polygons, then the track the storm has already traced, then where it
 * is going, then infrastructure, and reports on top, because a report is the
 * thing a person has to act on.
 *
 * Only one element on this map is allowed to move: the tornado warning and the
 * storm head pulse. Everything else is still. Motion is the strongest signal a
 * screen has and spending it on anything less than "a tornado is on the ground
 * and heading somewhere" wastes it.
 */

/**
 * A raster basemap rather than a hosted vector style, on purpose.
 *
 * A vector style pulls a stylesheet, a sprite sheet, glyph ranges and two tile
 * sources, and when one of them stalled MapLibre never finished loading and the
 * warning polygons were never drawn at all. Raster tiles have one failure mode:
 * a missing tile costs a grey square, not the entire operational picture.
 *
 * Esri's Canvas basemaps need no key and are built as quiet backdrops for data
 * overlay. Labels come as a separate layer so place names can sit *above* the
 * warning polygons, which matters when a responder is trying to read which town
 * is inside the red shape.
 */
const BASEMAP = {
  dark: {
    base: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    labels:
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    background: '#0a0e14',
  },
  light: {
    base: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    labels:
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    background: '#eef1f6',
  },
} as const;

const BASEMAP_ATTRIBUTION =
  'Basemap: Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/**
 * Radar comes from RainViewer rather than the raw NEXRAD mosaic.
 *
 * The mosaic tiles are 256 pixels and unsmoothed, so at any useful zoom a storm
 * cell dissolves into visible squares and a responder is reading pixels instead
 * of weather. RainViewer serves the same data at 512 pixels with smoothing and
 * a published index of recent frames, which gives both a sharper picture and a
 * loop whose timestamps are real rather than assumed. Free, and no key.
 *
 * The URL shape is /v2/radar/<frame>/<size>/{z}/{x}/{y}/<colour>/<smooth>_<snow>.png
 * Colour 4 is the familiar NWS reflectivity ramp; 1_1 turns on smoothing and
 * snow shading.
 */
const RAINVIEWER_INDEX = 'https://api.rainviewer.com/public/weather-maps.json';
const RADAR_TILE_SIZE = 512;
const RADAR_COLOUR = 4;
/**
 * Deepest tile zoom RainViewer actually has radar for.
 *
 * Past this it answers 200 with a placeholder image stamped "Zoom Level Not
 * Supported", which MapLibre has no way to tell from real weather and happily
 * painted across the map in letters bigger than the storm. Measured rather
 * than assumed: tiles are 130KB at z7 and an identical 3.3KB at z8, z9 and
 * z10, which is the placeholder being served over and over. Capping the source
 * here makes MapLibre scale the last real tile instead of asking for one that
 * does not exist.
 *
 * These are 512 pixel tiles, so a tile zoom of 7 is a map zoom of about 8.
 */
const RADAR_MAX_ZOOM = 7;
/** Above this the upscaled radar is mush, so it fades out rather than lying. */
const RADAR_FADE_START = 9;
const RADAR_FADE_END = 11;

/** How long each radar frame holds, with a pause on the newest one. */
const RADAR_FRAME_MS = 420;
const RADAR_HOLD_MS = 1100;
/** How many recent frames to animate. RainViewer publishes around a dozen. */
const RADAR_FRAME_COUNT = 8;

interface RadarFrame {
  path: string;
  time: number;
}

async function loadRadarFrames(): Promise<RadarFrame[]> {
  const res = await fetch(RAINVIEWER_INDEX);
  if (!res.ok) throw new Error('radar index unavailable');
  const data = (await res.json()) as { host: string; radar?: { past?: { path: string; time: number }[] } };
  const past = data.radar?.past ?? [];
  return past.slice(-RADAR_FRAME_COUNT).map((f) => ({ path: `${data.host}${f.path}`, time: f.time }));
}

const radarTiles = (frame: RadarFrame) =>
  `${frame.path}/${RADAR_TILE_SIZE}/{z}/{x}/{y}/${RADAR_COLOUR}/1_1.png`;

function baseStyle(theme: 'dark' | 'light'): maplibregl.StyleSpecification {
  const cfg = BASEMAP[theme];
  return {
    version: 8,
    glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
    sources: {
      basemap: { type: 'raster', tiles: [cfg.base], tileSize: 256, attribution: BASEMAP_ATTRIBUTION, maxzoom: 19 },
      basemapLabels: { type: 'raster', tiles: [cfg.labels], tileSize: 256, maxzoom: 19 },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': cfg.background } },
      { id: 'basemap-layer', type: 'raster', source: 'basemap' },
    ],
  };
}

/**
 * Warning colours follow National Weather Service convention, so anyone who has
 * seen a weather product before already knows what red means here.
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
  storm_shelter: '#22d3ee',
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

/** Which facilities deserve to be drawn larger, matching the exposure weights. */
const FACILITY_RANK: Record<string, number> = {
  storm_shelter: 4,
  hospital: 3,
  nursing_home: 3,
  school: 2,
  fire_station: 2,
  police: 2,
  power_substation: 2,
  communication_tower: 1,
  shelter: 1,
  transport: 1,
  other: 0,
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
  /** Radar fixes already reported for this storm, oldest first. */
  track: { lat: number; lon: number }[];
  /** Facility id to single out from its neighbours. */
  highlighted: string | null;
  /** The report being examined, drawn as the area it covers. */
  examined: { lat: number; lon: number; radiusMiles: number; band: string } | null;
  onSelectPoint: (p: LatLon) => void;
  onSelectFacility: (id: string) => void;
  /** Fires as the radar loop advances, so the caption can say how old a frame is. */
  onRadarFrame?: (frame: number, total: number, timeSeconds: number) => void;
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * The area a report covers, as a real circle on the ground.
 *
 * Drawn in miles rather than as a fixed pixel radius, so zooming in does not
 * quietly shrink the area a responder thinks they are searching.
 */
function reportAreaGeoJson(
  examined: MapViewProps['examined'],
): { ring: GeoJSON.FeatureCollection; centre: GeoJSON.FeatureCollection } {
  if (!examined) return { ring: EMPTY, centre: EMPTY };
  const origin = { lat: examined.lat, lon: examined.lon };
  const coords: [number, number][] = [];
  for (let deg = 0; deg <= 360; deg += 6) {
    const p = destination(origin, deg, examined.radiusMiles);
    coords.push([p.lon, p.lat]);
  }
  return {
    ring: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [coords] },
          properties: { band: examined.band, radius: examined.radiusMiles },
        },
      ],
    },
    centre: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [examined.lon, examined.lat] },
          properties: { band: examined.band },
        },
      ],
    },
  };
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
          // Tornado warnings get the emphasis. Everything else is context.
          urgent: a.event === 'Tornado Warning' ? 1 : 0,
          observed: a.tornadoDetection === 'OBSERVED' ? 1 : 0,
          sender: a.senderName,
        },
      })),
  };
}

/**
 * Where the storm is going: a centreline from the last radar fix, a corridor
 * around it, and tick marks every ten minutes so the projection reads as a
 * schedule rather than a shape.
 */
function pathToGeoJson(
  tracked: Alert | null,
  minutes: number,
  halfWidthMiles = 2.5,
): {
  line: GeoJSON.FeatureCollection;
  corridor: GeoJSON.FeatureCollection;
  head: GeoJSON.FeatureCollection;
  ticks: GeoJSON.FeatureCollection;
} {
  const empty = { line: EMPTY, corridor: EMPTY, head: EMPTY, ticks: EMPTY };
  if (!tracked?.motion || tracked.motion.speedMph <= 0) return empty;

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

  const tickFeatures: GeoJSON.Feature[] = [];
  for (let m = 10; m <= minutes; m += 10) {
    const at = destination(position, heading, (speedMph * m) / 60);
    tickFeatures.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [at.lon, at.lat] },
      properties: { label: `${m} min` },
    });
  }

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
          properties: {},
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
          properties: {
            heading,
            speed: Math.round(speedMph),
            event: tracked.event,
            observed: tracked.tornadoDetection === 'OBSERVED' ? 1 : 0,
          },
        },
      ],
    },
    ticks: { type: 'FeatureCollection', features: tickFeatures },
  };
}

/** The path radar has already traced. History, so it is drawn faded. */
function trackToGeoJson(track: { lat: number; lon: number }[]): {
  line: GeoJSON.FeatureCollection;
  dots: GeoJSON.FeatureCollection;
} {
  if (track.length < 2) return { line: EMPTY, dots: EMPTY };
  return {
    line: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: track.map((p) => [p.lon, p.lat]) },
          properties: {},
        },
      ],
    },
    dots: {
      type: 'FeatureCollection',
      features: track.slice(0, -1).map((p, i) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        // Older fixes fade out, so the direction of travel is readable at a glance.
        properties: { age: (i + 1) / track.length },
      })),
    },
  };
}

function facilitiesToGeoJson(
  facilities: ExposedFacility[],
  highlighted: string | null,
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: facilities.map((f) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
      properties: {
        id: f.id,
        name: f.name,
        kind: f.kind,
        color: FACILITY_COLOR[f.kind] ?? FACILITY_COLOR.other,
        rank: FACILITY_RANK[f.kind] ?? 0,
        inPath: f.minutesToImpact !== null ? 1 : 0,
        isHighlighted: f.id === highlighted ? 1 : 0,
        minutes: f.minutesToImpact === null ? -1 : Math.round(f.minutesToImpact),
        label:
          f.minutesToImpact !== null ? `${f.name} · ${Math.round(f.minutesToImpact)} min` : f.name,
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
    track,
    highlighted,
    examined,
    onSelectPoint,
    onSelectFacility,
    onRadarFrame,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  const observerRef = useRef<ResizeObserver | null>(null);
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const onSelectRef = useRef(onSelectPoint);
  onSelectRef.current = onSelectPoint;
  const onFacilityRef = useRef(onSelectFacility);
  onFacilityRef.current = onSelectFacility;
  const onRadarFrameRef = useRef(onRadarFrame);
  onRadarFrameRef.current = onRadarFrame;

  const setData = useCallback((id: string, data: GeoJSON.FeatureCollection) => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);
  }, []);

  /* Create the map once. */
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: baseStyle(themeRef.current),
      /**
       * Open on the whole country, not on Tornado Alley.
       *
       * Zoom 5 over Kansas framed the plains and cut off both coasts, which
       * made a national picture look like a regional one and quietly implied
       * nothing was happening anywhere else. A responder should see every
       * state that has something active before deciding where to look closer.
       *
       * Given as bounds rather than a zoom number so the fit follows the pane:
       * the map shares the window with a side panel and gets much narrower on
       * a laptop than on a wall display, and any single zoom that frames the
       * country on one of those clips Maine and Oregon off the other.
       */
      bounds: [
        [-125.5, 24.0],
        [-66.5, 49.5],
      ],
      fitBoundsOptions: { padding: 24 },
      attributionControl: { compact: true },
      // A gentle curve makes a flyTo read as travel rather than teleportation,
      // which helps when the map jumps to a facility in a list.
      fadeDuration: 150,
    });
    mapRef.current = map;
    if (import.meta.env.DEV) (window as unknown as { __map?: maplibregl.Map }).__map = map;

    map.on('error', (e) => {
      console.error('[TornadoSight] map error', (e as { error?: unknown }).error ?? e);
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(
      new maplibregl.GeolocateControl({ trackUserLocation: false, positionOptions: { enableHighAccuracy: true } }),
      'top-right',
    );
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');

    const buildLayers = () => {
      for (const id of [
        'alerts',
        'corridor',
        'path',
        'pathticks',
        'stormhead',
        'trackline',
        'trackdots',
        'facilities',
        'reports',
        'reportarea',
        'reportcentre',
        'picked',
      ]) {
        map.addSource(id, { type: 'geojson', data: EMPTY });
      }

      /**
       * Radar is built later, in the effect that loads the frame index.
       *
       * It used to be created here with `tiles: []` and filled in once the
       * index resolved, which crashed the whole style: MapLibre takes the
       * template string the moment it decides to load a tile, and on an empty
       * array there is nothing to take, so every one of the eight frames threw
       * and no layer after them was ever added. A raster source is only made
       * now when there is a real URL to give it.
       */

      /* ---- warning polygons ---- */
      map.addLayer({
        id: 'alert-fill',
        type: 'fill',
        source: 'alerts',
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': ['case', ['==', ['get', 'urgent'], 1], 0.22, 0.1],
        },
      });
      map.addLayer({
        id: 'alert-line',
        type: 'line',
        source: 'alerts',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['case', ['==', ['get', 'urgent'], 1], 2.6, 1.4],
          'line-opacity': ['case', ['==', ['get', 'urgent'], 1], 1, 0.75],
        },
      });
      // A second outline, animated, only on tornado warnings.
      map.addLayer({
        id: 'alert-pulse',
        type: 'line',
        source: 'alerts',
        filter: ['==', ['get', 'urgent'], 1],
        paint: { 'line-color': '#ff2d2d', 'line-width': 7, 'line-opacity': 0.2, 'line-blur': 3 },
      });

      /* ---- the track already travelled ---- */
      map.addLayer({
        id: 'track-line',
        type: 'line',
        source: 'trackline',
        paint: { 'line-color': '#ff8a80', 'line-width': 2, 'line-opacity': 0.45, 'line-dasharray': [1, 1.6] },
      });
      map.addLayer({
        id: 'track-dots',
        type: 'circle',
        source: 'trackdots',
        paint: {
          'circle-radius': 3.5,
          'circle-color': '#ff8a80',
          'circle-opacity': ['interpolate', ['linear'], ['get', 'age'], 0, 0.2, 1, 0.7],
        },
      });

      /* ---- where it is going ---- */
      map.addLayer({
        id: 'corridor-fill',
        type: 'fill',
        source: 'corridor',
        paint: { 'fill-color': '#ff2d2d', 'fill-opacity': 0.1 },
      });
      map.addLayer({
        id: 'corridor-line',
        type: 'line',
        source: 'corridor',
        paint: { 'line-color': '#ff2d2d', 'line-width': 1, 'line-opacity': 0.35 },
      });
      map.addLayer({
        id: 'path-line',
        type: 'line',
        source: 'path',
        paint: { 'line-color': '#ff2d2d', 'line-width': 3, 'line-dasharray': [2, 1.4], 'line-opacity': 0.9 },
      });
      map.addLayer({
        id: 'path-ticks',
        type: 'circle',
        source: 'pathticks',
        paint: {
          'circle-radius': 3,
          'circle-color': '#0a0e14',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ff2d2d',
        },
      });
      map.addLayer({
        id: 'path-tick-labels',
        type: 'symbol',
        source: 'pathticks',
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 10,
          'text-offset': [0, -1.1],
          'text-allow-overlap': false,
        },
        paint: { 'text-color': '#ff8a80', 'text-halo-color': '#0a0e14', 'text-halo-width': 1.4 },
      });

      /* ---- the storm itself ---- */
      map.addLayer({
        id: 'stormhead-halo',
        type: 'circle',
        source: 'stormhead',
        paint: { 'circle-radius': 16, 'circle-color': '#ff2d2d', 'circle-opacity': 0.18, 'circle-blur': 0.6 },
      });
      map.addLayer({
        id: 'stormhead-dot',
        type: 'circle',
        source: 'stormhead',
        paint: {
          'circle-radius': 7,
          'circle-color': '#ff2d2d',
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ffffff',
        },
      });

      /* ---- infrastructure ---- */
      map.addLayer({
        id: 'facility-dot',
        type: 'circle',
        source: 'facilities',
        paint: {
          'circle-radius': [
            'case',
            ['==', ['get', 'isHighlighted'], 1],
            11,
            ['==', ['get', 'inPath'], 1],
            ['interpolate', ['linear'], ['get', 'rank'], 0, 5, 3, 8],
            ['interpolate', ['linear'], ['get', 'rank'], 0, 3, 3, 5],
          ],
          'circle-color': ['get', 'color'],
          'circle-opacity': ['case', ['==', ['get', 'inPath'], 1], 1, 0.75],
          'circle-stroke-width': [
            'case',
            ['==', ['get', 'isHighlighted'], 1],
            3,
            ['==', ['get', 'inPath'], 1],
            2,
            0.5,
          ],
          'circle-stroke-color': [
            'case',
            ['==', ['get', 'isHighlighted'], 1],
            '#38bdf8',
            ['==', ['get', 'inPath'], 1],
            '#ffffff',
            '#00000055',
          ],
        },
      });
      map.addLayer({
        id: 'facility-hover',
        type: 'circle',
        source: 'facilities',
        filter: ['==', ['get', 'id'], '__none__'],
        paint: {
          'circle-radius': 14,
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.28,
        },
      });

      // A ring that only exists for the facility someone just clicked.
      map.addLayer({
        id: 'facility-focus',
        type: 'circle',
        source: 'facilities',
        filter: ['==', ['get', 'isHighlighted'], 1],
        paint: {
          'circle-radius': 20,
          'circle-color': 'transparent',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#38bdf8',
          'circle-stroke-opacity': 0.8,
        },
      });
      // Names only for what is in the path, or what was singled out. Labelling
      // every school in a city would bury the four that matter.
      map.addLayer({
        id: 'facility-label',
        type: 'symbol',
        source: 'facilities',
        filter: ['any', ['==', ['get', 'inPath'], 1], ['==', ['get', 'isHighlighted'], 1]],
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 11,
          'text-offset': [0, 1.3],
          'text-anchor': 'top',
          'text-max-width': 12,
          'text-allow-overlap': false,
          'text-optional': true,
        },
        paint: { 'text-color': '#e8eef7', 'text-halo-color': '#0a0e14', 'text-halo-width': 1.6 },
      });

      /* ---- reports and the selected point ---- */
      map.addLayer({
        id: 'report-area-fill',
        type: 'fill',
        source: 'reportarea',
        paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.1 },
      });
      map.addLayer({
        id: 'report-area-line',
        type: 'line',
        source: 'reportarea',
        paint: { 'line-color': '#38bdf8', 'line-width': 2, 'line-dasharray': [3, 2] },
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

      // Place names last, so they sit above the warning shapes and a responder
      // can still read which town is inside the red.
      map.addLayer({ id: 'basemap-labels', type: 'raster', source: 'basemapLabels', paint: { 'raster-opacity': 0.9 } });

      readyRef.current = true;
      map.fire('tornadosight.ready');
    };

    /**
     * Build on whichever event arrives first.
     *
     * `load` is the documented moment, but it waits on a first render and never
     * arrives in a throttled tab, which leaves a responder looking at an empty
     * rectangle. `built` is set only after the build succeeds, so an attempt
     * made a moment too early throws harmlessly and the next event retries.
     */
    let built = false;
    let lastBuildError: unknown = null;
    const tryBuild = () => {
      if (built || !map.getStyle()?.layers?.length) return;
      try {
        buildLayers();
        built = true;
      } catch (err) {
        /* too early, a later event will retry */
        lastBuildError = err;
      }
    };
    map.on('styledata', tryBuild);
    map.on('load', tryBuild);
    map.on('idle', tryBuild);
    tryBuild();

    /**
     * Keep trying for a while before declaring failure.
     *
     * A single check at five seconds reported the map as broken on a slow or
     * backgrounded tab that went on to build itself perfectly a moment later,
     * which is a red console error contradicted by the working map behind it.
     * This retries quietly and only complains once, after a grace period long
     * enough that the complaint means something.
     */
    let attempts = 0;
    const retry = () => {
      tryBuild();
      attempts += 1;
      if (built) return;
      if (attempts < 6) {
        fallbackRef.current = setTimeout(retry, 2500);
        return;
      }
      console.error('[TornadoSight] the map layers could not be built', lastBuildError);
    };
    fallbackRef.current = setTimeout(retry, 2500);

    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);
    observerRef.current = observer;

    /* ---- interaction ---- */
    map.on('click', (e) => {
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

    // Grow the facility under the pointer. Small, but it makes a field of dots
    // feel like a set of things rather than a texture.
    let hovered: string | null = null;
    map.on('mousemove', 'facility-dot', (e) => {
      const id = e.features?.[0]?.properties?.id as string | undefined;
      if (!id || id === hovered) return;
      hovered = id;
      if (map.getLayer('facility-hover')) {
        map.setFilter('facility-hover', ['==', ['get', 'id'], id]);
      }
    });
    map.on('mouseleave', 'facility-dot', () => {
      hovered = null;
      if (map.getLayer('facility-hover')) {
        map.setFilter('facility-hover', ['==', ['get', 'id'], '__none__']);
      }
    });

    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '280px' });

    map.on('click', 'facility-dot', (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as Record<string, string | number>;
      onFacilityRef.current(String(p.id));
      const timing =
        Number(p.minutes) >= 0
          ? `<strong style="color:#ff5252">In the projected path, about ${p.minutes} minutes away</strong>`
          : `${p.distance} miles from the storm, not in the projected path`;
      popup
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-size:13px;line-height:1.45"><strong>${escapeHtml(String(p.name))}</strong><br>` +
            `<span style="opacity:.75">${escapeHtml(String(p.kind).replace(/_/g, ' '))}</span><br>${timing}</div>`,
        )
        .addTo(map);
    });

    map.on('click', 'alert-fill', (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as Record<string, string | number>;
      popup
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-size:13px;line-height:1.45"><strong>${escapeHtml(String(p.event))}</strong><br>` +
            `<span style="opacity:.75">${escapeHtml(String(p.areaDesc))}</span><br>` +
            `<span style="opacity:.6">${escapeHtml(String(p.sender))}</span></div>`,
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
            `Radar placed the storm here, tracking ${p.heading}&deg; at ${p.speed} mph.` +
            (Number(p.observed) === 1
              ? '<br><strong style="color:#ff5252">Tornado confirmed on the ground</strong>'
              : '') +
            `</div>`,
        )
        .addTo(map);
    });

    /**
     * The only animation on the map. A slow breath on the tornado warning
     * outline and the storm head, so the eye is pulled to the one thing that
     * matters without anything jumping.
     */
    const animate = () => {
      if (readyRef.current && map.getLayer('alert-pulse')) {
        const t = (Date.now() % 2200) / 2200;
        const wave = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
        try {
          map.setPaintProperty('alert-pulse', 'line-width', 5 + wave * 7);
          map.setPaintProperty('alert-pulse', 'line-opacity', 0.28 - wave * 0.16);
          map.setPaintProperty('stormhead-halo', 'circle-radius', 14 + wave * 10);
          map.setPaintProperty('stormhead-halo', 'circle-opacity', 0.26 - wave * 0.14);
        } catch {
          /* layer removed mid frame */
        }
      }
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (fallbackRef.current) clearTimeout(fallbackRef.current);
      observerRef.current?.disconnect();
      observerRef.current = null;
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
  }, []);

  /* Push data whenever it changes. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      setData('alerts', alertsToGeoJson(alerts));
      const path = pathToGeoJson(tracked, projectionMinutes);
      setData('path', path.line);
      setData('corridor', path.corridor);
      setData('stormhead', path.head);
      setData('pathticks', path.ticks);
      const history = trackToGeoJson(track);
      setData('trackline', history.line);
      setData('trackdots', history.dots);
      setData('facilities', showFacilities ? facilitiesToGeoJson(facilities, highlighted) : EMPTY);
      setData('reports', reportsToGeoJson(reports));
      const area = reportAreaGeoJson(examined);
      setData('reportarea', area.ring);
      setData('reportcentre', area.centre);
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
  }, [alerts, facilities, reports, point, tracked, projectionMinutes, showFacilities, track, highlighted, examined, setData]);

  /**
   * Run the radar loop.
   *
   * Every frame is kept visible but transparent rather than hidden, so the
   * tiles stay warm in the tile cache and the loop does not stutter on its
   * second pass while a hidden layer refetches. Only opacity changes.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let frames: RadarFrame[] = [];
    let frame = 0;

    const clearAll = () => {
      for (let i = 0; i < RADAR_FRAME_COUNT; i++) {
        const id = `radar-layer-${i}`;
        if (!map.getLayer(id)) continue;
        map.setLayoutProperty(id, 'visibility', 'none');
        map.setPaintProperty(id, 'raster-opacity', 0);
      }
    };

    const step = () => {
      if (cancelled || !frames.length || !map.getLayer('radar-layer-0')) return;
      for (let i = 0; i < frames.length; i++) {
        const id = `radar-layer-${i}`;
        if (!map.getLayer(id)) continue;
        map.setPaintProperty(
          id,
          'raster-opacity',
          i === frame
            ? ([
                'interpolate',
                ['linear'],
                ['zoom'],
                RADAR_FADE_START,
                0.62,
                RADAR_FADE_END,
                0,
              ] as unknown as number)
            : 0,
        );
      }
      onRadarFrameRef.current?.(frame, frames.length, frames[frame].time);
      // Hold a beat on the newest frame, the way every radar loop does, so the
      // eye can register where the storm ended up before it jumps back.
      const isNewest = frame === frames.length - 1;
      frame = (frame + 1) % frames.length;
      timer = setTimeout(step, isNewest ? RADAR_HOLD_MS : RADAR_FRAME_MS);
    };

    const start = async () => {
      if (!showRadar) {
        clearAll();
        return;
      }
      try {
        frames = await loadRadarFrames();
      } catch {
        // No radar is survivable; the warnings and the storm track are not.
        console.warn('[TornadoSight] radar frames unavailable');
        return;
      }
      if (cancelled || !frames.length) return;

      /**
       * Build one source and layer per frame, now that each has a real URL.
       *
       * Radar has to sit under the warnings and the storm track but over the
       * basemap, so each layer is inserted before the first warning layer
       * rather than appended on top. Any previous stack is torn down first,
       * because refreshing the index gives a new set of frame paths.
       */
      const beneath = map.getLayer('alert-fill') ? 'alert-fill' : undefined;
      for (let i = 0; i < RADAR_FRAME_COUNT; i++) {
        if (map.getLayer(`radar-layer-${i}`)) map.removeLayer(`radar-layer-${i}`);
        if (map.getSource(`radar${i}`)) map.removeSource(`radar${i}`);
      }

      frames.forEach((f, i) => {
        map.addSource(`radar${i}`, {
          type: 'raster',
          tiles: [radarTiles(f)],
          tileSize: RADAR_TILE_SIZE,
          maxzoom: RADAR_MAX_ZOOM,
          attribution: i === 0 ? 'Radar: <a href="https://www.rainviewer.com">RainViewer</a>' : undefined,
        });
        map.addLayer(
          {
            id: `radar-layer-${i}`,
            type: 'raster',
            source: `radar${i}`,
            paint: { 'raster-opacity': 0, 'raster-fade-duration': 0 },
          },
          beneath,
        );
      });

      frame = 0;
      step();
    };

    if (readyRef.current) void start();
    else map.once('tornadosight.ready', () => void start());

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [showRadar]);

  /** Swap basemap tiles on a theme change, leaving the data layers untouched. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const cfg = BASEMAP[theme];
      (map.getSource('basemap') as { setTiles?: (t: string[]) => void } | undefined)?.setTiles?.([cfg.base]);
      (map.getSource('basemapLabels') as { setTiles?: (t: string[]) => void } | undefined)?.setTiles?.([cfg.labels]);
      if (map.getLayer('background')) {
        map.setPaintProperty('background', 'background-color', cfg.background);
      }
      const halo = theme === 'dark' ? '#0a0e14' : '#ffffff';
      const text = theme === 'dark' ? '#e8eef7' : '#101722';
      for (const id of ['facility-label', 'path-tick-labels']) {
        if (!map.getLayer(id)) continue;
        map.setPaintProperty(id, 'text-halo-color', halo);
        if (id === 'facility-label') map.setPaintProperty(id, 'text-color', text);
      }
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
        { padding: 72, duration: 1100, maxZoom: 13, essential: true },
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
