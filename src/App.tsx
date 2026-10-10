import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MapView from './components/MapView';
import SituationPanel from './components/SituationPanel';
import ReportsPanel from './components/ReportsPanel';
import ReportDialog, { type ReportDraft } from './components/ReportDialog';
import ExposurePanel from './components/ExposurePanel';
import Header from './components/Header';
import { fetchActiveAlerts, resolveZoneGeometry, type Alert } from './lib/nws';
import { fetchWeather, type WeatherSnapshot } from './lib/openmeteo';
import { loadFacilities, type FacilitySource } from './lib/facilities';
import { alertAnchor, buildSituation, type Situation } from './lib/situation';
import { reverseGeocode } from './lib/reverseGeocode';
import InjectionPanel from './components/InjectionPanel';
import { DEFAULT_INJECTION, injectedHistory, type InjectionSettings } from './lib/injection';
import { boundsOf, type LatLon } from './lib/geo';
import type { Facility } from './lib/scoring';
import {
  deleteReport,
  exportJson,
  listReports,
  saveReport,
  setReportStatus,
  setReportRadius,
  onReportsChanged,
  type ReportStatus,
  type StoredReport,
} from './lib/storage';
import {
  alertsAt,
  loadCatalog,
  loadReplay,
  observedTrack,
  openingMoment,
  pickEvent,
  trackedBounds,
  activeBounds,
  type ReplayEntry,
  type ReplayEvent,
} from './lib/replay';

export type Mode = 'live' | 'replay' | 'inject';
type Tab = 'situation' | 'reports' | 'exposure' | 'inject';

const LIVE_REFRESH_MS = 60_000;
const DEFAULT_POINT: LatLon = { lat: 34.4048, lon: -103.2052 };

function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('tornadosight.theme') : null;
    if (stored === 'dark' || stored === 'light') return stored;
    return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('tornadosight.theme', theme);
    } catch {
      /* private browsing */
    }
  }, [theme]);

  return [theme, setTheme] as const;
}

export default function App({ onExit }: { onExit?: () => void }) {
  const [theme, setTheme] = useTheme();
  const [mode, setMode] = useState<Mode>('live');
  const [tab, setTab] = useState<Tab>('situation');
  const [sheetOpen, setSheetOpen] = useState(false);

  const [point, setPoint] = useState<LatLon>(DEFAULT_POINT);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [weather, setWeather] = useState<WeatherSnapshot | null>(null);
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [facilitySource, setFacilitySource] = useState<FacilitySource>('none');
  const [reports, setReports] = useState<StoredReport[]>([]);

  const [catalog, setCatalog] = useState<ReplayEntry[]>([]);
  const [replay, setReplay] = useState<ReplayEvent | null>(null);
  const [replayAt, setReplayAt] = useState<Date | null>(null);
  const [playing, setPlaying] = useState(false);

  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showRadar, setShowRadar] = useState(true);
  const [showFacilities, setShowFacilities] = useState(true);
  const [fitBounds, setFitBounds] = useState<[number, number, number, number] | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  /** Tornado warnings that appeared since the last poll, newest first. */
  const [breaking, setBreaking] = useState<Alert[]>([]);
  const seenTornadoes = useRef<Set<string> | null>(null);
  /** Guards against an older zone resolution pass overwriting a newer refresh. */
  const zonePass = useRef(0);
  /** A human readable name for the selected point, resolved in the background. */
  const [placeLabel, setPlaceLabel] = useState<string | null>(null);
  /** The report currently being examined on the map. */
  const [activeReport, setActiveReport] = useState<string | null>(null);
  const [radarFrame, setRadarFrame] = useState<{ frame: number; total: number; time: number } | null>(null);
  /** Replay playback rate, in simulated minutes per real second. */
  const [speed, setSpeed] = useState(4);
  const [injection, setInjection] = useState<InjectionSettings>(DEFAULT_INJECTION);
  /** Show only storms that actually carry a tornado warning. */
  const [tornadoesOnly, setTornadoesOnly] = useState(false);
  /**
   * Which facilities to score and draw.
   *
   * "Shelters" is where a tornado response actually starts, so it is offered
   * first. "Life safety" adds the places that must be protected rather than
   * sent to. "Everything" is the full critical infrastructure list the
   * challenge asks for, including substations and towers.
   */
  const [facilityScope, setFacilityScope] = useState<'shelters' | 'lifesafety' | 'all'>('all');
  const [now, setNow] = useState(() => Date.now());

  /* A slow tick so every relative time on screen stays honest. */
  useEffect(() => {
    // One second, not fifteen. An expiry that counts down reads as live; one
    // that jumps in fifteen second steps reads as a screenshot.
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  /* ---------------------------------------------------------------- *
   * Live alerts
   * ---------------------------------------------------------------- */

  const refreshAlerts = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchActiveAlerts();

      /**
       * Notice a tornado warning that was not there a minute ago.
       *
       * This is the one thing in the feed that should interrupt someone. The
       * first poll only records what already exists, so opening the app during
       * an ongoing outbreak does not announce twenty warnings as breaking news.
       */
      const tornadoes = next.filter((a) => a.event === 'Tornado Warning');
      if (seenTornadoes.current === null) {
        seenTornadoes.current = new Set(tornadoes.map((a) => a.id));
      } else {
        const fresh = tornadoes.filter((a) => !seenTornadoes.current!.has(a.id));
        for (const a of tornadoes) seenTornadoes.current.add(a.id);
        if (fresh.length) setBreaking((prev) => [...fresh, ...prev].slice(0, 4));
      }

      setAlerts(next);
      setLastUpdated(new Date());
      setError(null);

      /**
       * Three quarters of the feed arrives with no polygon and would draw as
       * nothing at all. Fill those shapes in from the zones each product was
       * issued against, after the first paint so the drawn warnings are never
       * held up waiting for it.
       *
       * The callback matters: on a cold cache this takes a minute or two to
       * cover the country, and showing each batch as it lands means the map
       * visibly fills out instead of looking half empty until the end. A newer
       * refresh may land first, so a stale pass must not overwrite it.
       */
      const stamp = ++zonePass.current;
      void resolveZoneGeometry(next, undefined, (partial) => {
        if (zonePass.current === stamp) setAlerts(partial);
      })
        .then((withShapes) => {
          if (zonePass.current === stamp && withShapes !== next) setAlerts(withShapes);
        })
        .catch(() => undefined);
    } catch (err) {
      setError(
        err instanceof Error
          ? `Live alerts could not be refreshed: ${err.message}. The last known picture is still shown.`
          : 'Live alerts could not be refreshed.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mode !== 'live') return;
    void refreshAlerts();
    const id = setInterval(() => void refreshAlerts(), LIVE_REFRESH_MS);
    return () => clearInterval(id);
  }, [mode, refreshAlerts]);

  /* ---------------------------------------------------------------- *
   * Replay
   * ---------------------------------------------------------------- */

  const openEvent = useCallback((slug: string) => {
    setPlaying(false);
    void loadReplay(slug)
      .then((event) => {
        setReplay(event);
        // Open on the first tracked storm rather than at the start of the
        // captured window, which would show an empty map waiting for it.
        const opening = openingMoment(event);
        setReplayAt(opening.at);
        if (opening.point) setPoint(opening.point);
        setFitBounds(trackedBounds(event) ?? activeBounds(event));
        setError(null);
      })
      .catch((err) => setError(`That replay event could not be loaded: ${err.message}`));
  }, []);

  useEffect(() => {
    if (mode !== 'replay' || replay) return;
    void loadCatalog().then((list) => {
      setCatalog(list);
      const chosen = pickEvent(list);
      if (!chosen) {
        setError('No replay events are available. Run scripts/discover-events.mjs to build the library.');
        return;
      }
      openEvent(chosen.slug);
    });
  }, [mode, replay, openEvent]);

  useEffect(() => {
    if (mode !== 'replay' || !replay || !playing) return;
    const id = setInterval(() => {
      setReplayAt((current) => {
        if (!current) return current;
        const next = new Date(current.getTime() + speed * 60_000 * 0.1);
        if (next > replay.window.end) {
          setPlaying(false);
          return replay.window.end;
        }
        return next;
      });
    }, 250);
    return () => clearInterval(id);
  }, [mode, replay, playing, speed]);

  /** Everything on screen before the tornado filter. */
  const sourceAlerts = useMemo(() => {
    if (mode === 'replay') return replay && replayAt ? alertsAt(replay, replayAt) : [];
    // Injected products are built in the same shape as real ones, so they run
    // through the identical scoring path rather than a parallel test route.
    if (mode === 'inject') return injectedHistory(injection, point);
    return alerts;
  }, [mode, replay, replayAt, alerts, injection, point]);

  const tornadoProducts = useMemo(
    () => sourceAlerts.filter((a) => a.event === 'Tornado Warning' || a.event === 'Tornado Watch'),
    [sourceAlerts],
  );

  const tornadoCount = tornadoProducts.length;

  /**
   * The jump list behind the tornado filter, worst first.
   *
   * Only products with a shape can be flown to, since without one there is no
   * place to put the camera. Warnings come before watches, and a tornado
   * somebody has actually seen comes before one radar merely suspects.
   */
  const tornadoTargets = useMemo(
    () =>
      tornadoProducts
        .filter((a) => a.geometry || a.motion)
        .sort((a, b) => {
          const kind = Number(b.event === 'Tornado Warning') - Number(a.event === 'Tornado Warning');
          if (kind !== 0) return kind;
          const seen = Number(b.tornadoDetection === 'OBSERVED') - Number(a.tornadoDetection === 'OBSERVED');
          if (seen !== 0) return seen;
          return b.sent.getTime() - a.sent.getTime();
        })
        .map((a) => ({
          id: a.id,
          event: a.event,
          // areaDesc is the county list the issuing office wrote. It can run
          // long on a watch, so it is trimmed rather than wrapped to four lines.
          area: a.areaDesc.length > 64 ? `${a.areaDesc.slice(0, 61)}...` : a.areaDesc,
          detection: a.tornadoDetection,
          warning: a.event === 'Tornado Warning',
        })),
    [tornadoProducts],
  );

  /** Fly to one tornado product and select it, so the panels fill in with it. */
  const jumpToTornado = useCallback(
    (id: string) => {
      const found = tornadoProducts.find((a) => a.id === id);
      if (!found) return;
      setTornadoesOnly(true);
      const at = found.motion?.position ?? alertAnchor(found);
      if (at) setPoint(at);
      const b = found.geometry ? boundsOf(found.geometry.coordinates, found.geometry.type) : null;
      if (b) {
        setFitBounds([b.west - 0.25, b.south - 0.2, b.east + 0.25, b.north + 0.2]);
      } else if (at) {
        setFitBounds([at.lon - 0.5, at.lat - 0.4, at.lon + 0.5, at.lat + 0.4]);
      }
      setHighlighted(null);
    },
    [tornadoProducts],
  );

  const visibleAlerts = useMemo(() => {
    if (!tornadoesOnly) return sourceAlerts;
    // During an outbreak the national feed is mostly flood and marine products
    // and the thing you are looking for is buried under them.
    return sourceAlerts.filter((a) => a.event === 'Tornado Warning' || a.event === 'Tornado Watch');
  }, [sourceAlerts, tornadoesOnly]);

  /* Follow the storm during replay so the selection does not fall behind it. */
  useEffect(() => {
    if (mode !== 'replay' || !replay || !replayAt) return;
    const tracked = visibleAlerts.filter((a) => a.motion);
    if (!tracked.length) return;
    const newest = tracked.reduce((best, a) => (a.sent > best.sent ? a : best), tracked[0]);
    setPoint(newest.motion!.position);
  }, [mode, replay, replayAt, visibleAlerts]);

  /* ---------------------------------------------------------------- *
   * Weather and infrastructure for the selected point
   * ---------------------------------------------------------------- */

  useEffect(() => {
    // Replay alerts are historical; pairing them with today's weather would be
    // dishonest, so weather is only shown in live mode.
    if (mode === 'replay') {
      setWeather(null);
      return;
    }
    const controller = new AbortController();
    void fetchWeather(point, controller.signal)
      .then(setWeather)
      .catch(() => setWeather(null));
    return () => controller.abort();
  }, [point, mode]);

  useEffect(() => {
    const controller = new AbortController();
    const pad = 0.35;
    const bbox = {
      west: point.lon - pad,
      south: point.lat - pad,
      east: point.lon + pad,
      north: point.lat + pad,
    };
    void loadFacilities(bbox, controller.signal).then((result) => {
      setFacilities(result.facilities);
      setFacilitySource(result.source);
    });
    return () => controller.abort();
  }, [point]);

  /** Resolve the selected point to a name a responder can act on. */
  useEffect(() => {
    const controller = new AbortController();
    setPlaceLabel(null);
    void reverseGeocode(point, controller.signal).then(setPlaceLabel);
    return () => controller.abort();
  }, [point]);

  /* ---------------------------------------------------------------- *
   * Reports
   * ---------------------------------------------------------------- */

  const refreshReports = useCallback(() => {
    void listReports().then(setReports).catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshReports();
    // A reporter filing from the public form is a second tab over the same
    // database. Without this the responder would have to reload to see it.
    return onReportsChanged(refreshReports);
  }, [refreshReports]);

  /**
   * Everything time relative on screen is measured against this. In replay that
   * is the replay clock, otherwise an archived warning reads as having expired
   * days ago, which is true of the calendar and useless to the viewer.
   */
  const clock = mode === 'replay' && replayAt ? replayAt.getTime() : now;

  /** Where radar has already placed this storm, drawn as history behind it. */
  const track = useMemo(
    () => (mode === 'replay' && replay && replayAt ? observedTrack(replay, replayAt) : []),
    [mode, replay, replayAt],
  );

  /** Focus the map on one facility and make it stand out from its neighbours. */
  const focusFacility = useCallback(
    (id: string) => {
      const found = situationRef.current?.exposure.facilities.find((f) => f.id === id);
      if (!found) return;
      setHighlighted(id);
      setFitBounds([found.lon - 0.05, found.lat - 0.04, found.lon + 0.05, found.lat + 0.04]);
    },
    [],
  );

  const situationRef = useRef<Situation | null>(null);

  /** The report currently open on the map, if any. */
  const examined = useMemo(
    () => reports.find((r) => r.id === activeReport) ?? null,
    [reports, activeReport],
  );

  /** Facilities narrowed to the scope the operator has chosen. */
  const scopedFacilities = useMemo(() => {
    if (facilityScope === 'all') return facilities;
    const keep =
      facilityScope === 'shelters'
        ? new Set<string>(['storm_shelter'])
        : new Set<string>(['storm_shelter', 'hospital', 'nursing_home', 'school', 'fire_station', 'police']);
    return facilities.filter((f) => keep.has(f.kind));
  }, [facilities, facilityScope]);

  const situation: Situation | null = useMemo(
    () =>
      buildSituation({
        point,
        alerts: visibleAlerts,
        // In injection mode the atmosphere comes from the sliders, so the
        // weather term can be driven across its whole range on a calm day.
        weather:
          mode === 'inject'
            ? {
                ...injection.weather,
                observedAt: new Date(),
                temperatureF: null,
                humidityPct: null,
                windDirectionDeg: null,
                convectiveInhibition: null,
                cached: false,
              }
            : weather,
        facilities: scopedFacilities,
      }),
    [point, visibleAlerts, weather, scopedFacilities, mode, injection, examined],
  );

  situationRef.current = situation;

  const handleSubmitReport = useCallback(
    async (draft: ReportDraft) => {
      const s = draft.situation;
      const report: StoredReport = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        lat: draft.point.lat,
        lon: draft.point.lon,
        photo: draft.photo,
        photoName: draft.photoName,
        placeName: draft.placeName,
        note: draft.note,
        reporter: draft.reporter,
        imageConfidence: draft.screening?.probability ?? null,
        imageUncertain: draft.screening?.uncertain ?? false,
        priorityScore: s.priority.score,
        band: s.priority.band,
        reasons: s.priority.reasons,
        warningScore: s.warning.score,
        weatherScore: s.weatherScore.score,
        exposureScore: s.exposure.score,
        status: 'new',
        // Five miles is about what a sighting from a road covers.
        radiusMiles: 5,
        replaySlug: mode === 'replay' ? (replay?.slug ?? null) : null,
      };
      await saveReport(report);
      refreshReports();
      setDialogOpen(false);
      setTab('reports');
      setSheetOpen(true);
    },
    [mode, replay, refreshReports],
  );

  const handleStatus = useCallback(
    async (id: string, status: ReportStatus) => {
      await setReportStatus(id, status, 'operator');
      refreshReports();
    },
    [refreshReports],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteReport(id);
      refreshReports();
    },
    [refreshReports],
  );

  const openReport = useCallback(
    (r: StoredReport) => {
      setActiveReport(r.id);
      setPoint({ lat: r.lat, lon: r.lon });
      const pad = Math.max(0.08, r.radiusMiles / 55);
      setFitBounds([r.lon - pad * 1.3, r.lat - pad, r.lon + pad * 1.3, r.lat + pad]);
      setHighlighted(null);
    },
    [],
  );

  const handleRadius = useCallback(
    async (id: string, miles: number) => {
      await setReportRadius(id, miles);
      refreshReports();
    },
    [refreshReports],
  );

  const handleExport = useCallback(async () => {
    const json = await exportJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tornadosight-reports-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const focusOnAlerts = useCallback(() => {
    const withGeometry = visibleAlerts.filter((a) => a.geometry);
    if (!withGeometry.length) return;
    let west = 180;
    let south = 90;
    let east = -180;
    let north = -90;
    for (const a of withGeometry) {
      const b = boundsOf(a.geometry!.coordinates, a.geometry!.type);
      if (!b) continue;
      /**
       * Ignore anything outside the states.
       *
       * The National Weather Service also issues for Guam, American Samoa and
       * the far Pacific, and a single small craft advisory out there dragged
       * this to a view of the whole globe with the United States a thumbnail
       * in the corner. Those products are real and stay on the map; they just
       * do not get a vote on where the camera goes.
       */
      if (b.east < -180 || b.west > -60 || b.north < 15 || b.south > 73) continue;
      west = Math.min(west, b.west);
      south = Math.min(south, b.south);
      east = Math.max(east, b.east);
      north = Math.max(north, b.north);
    }
    if (west <= east) setFitBounds([west, south, east, north]);
  }, [visibleAlerts]);

  const dialogFacilities = useRef(facilities);
  dialogFacilities.current = facilities;

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'situation', label: 'Situation' },
    { id: 'reports', label: 'Reports', badge: reports.filter((r) => r.status !== 'dismissed').length },
    { id: 'exposure', label: 'Exposure', badge: situation?.exposure.facilities.length },
  ];
  // The injection controls only exist in the mode they belong to.
  if (mode === 'inject') tabs.push({ id: 'inject', label: 'Inject' });

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <a href="#panel" className="skip-link">
        Skip to the situation panel
      </a>

      <Header
        mode={mode}
        onModeChange={(m) => {
          setMode(m);
          setPlaying(false);
          setError(null);
        }}
        theme={theme}
        onThemeChange={setTheme}
        loading={loading}
        lastUpdated={lastUpdated}
        now={now}
        alertCount={visibleAlerts.length}
        onRefresh={() => void refreshAlerts()}
        onPickPlace={(p) => {
          setPoint({ lat: p.lat, lon: p.lon });
          setFitBounds([p.lon - 0.4, p.lat - 0.3, p.lon + 0.4, p.lat + 0.3]);
        }}
        replay={replay}
        replayAt={replayAt}
        playing={playing}
        onPlayToggle={() => setPlaying((v) => !v)}
        onScrub={(d) => {
          setPlaying(false);
          setReplayAt(d);
        }}
        catalog={catalog}
        onPickEvent={openEvent}
        tornadoesOnly={tornadoesOnly}
        onTornadoesOnly={(v) => {
          setTornadoesOnly(v);
          if (!v) return;
          const tor = sourceAlerts.filter(
            (a) => (a.event === 'Tornado Warning' || a.event === 'Tornado Watch') && a.geometry,
          );
          if (!tor.length) return;
          let w = 180;
          let so = 90;
          let e = -180;
          let n = -90;
          for (const a of tor) {
            const b = boundsOf(a.geometry!.coordinates, a.geometry!.type);
            if (!b) continue;
            w = Math.min(w, b.west);
            so = Math.min(so, b.south);
            e = Math.max(e, b.east);
            n = Math.max(n, b.north);
          }
          if (w > e) return;
          setFitBounds([w - 0.2, so - 0.2, e + 0.2, n + 0.2]);
          // Put the selection on the most urgent one so the panel fills in too.
          const first = tor.find((a) => a.event === 'Tornado Warning') ?? tor[0];
          const at = first.motion?.position ?? alertAnchor(first);
          if (at) setPoint(at);
        }}
        tornadoCount={tornadoCount}
        tornadoTargets={tornadoTargets}
        onJumpToTornado={jumpToTornado}
        onExit={onExit}
        onOpenInject={() => {
          setTab('inject');
          setSheetOpen(true);
        }}
        speed={speed}
        onSpeed={setSpeed}
      />

      {error ? (
        <p
          role="alert"
          className="border-b px-4 py-2 text-xs"
          style={{
            borderColor: 'var(--border-soft)',
            background: 'color-mix(in srgb, var(--band-high) 12%, var(--surface-panel))',
            color: 'var(--band-high)',
          }}
        >
          {error}
        </p>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden lg:grid lg:grid-rows-[minmax(0,1fr)] lg:grid-cols-[1fr_400px]">
        <main className="relative h-full min-h-[45dvh] overflow-hidden lg:min-h-0" aria-label="Situation map">
          <MapView
            alerts={visibleAlerts}
            facilities={situation?.exposure.facilities ?? []}
            reports={
              tornadoesOnly
                ? reports.filter((r) => r.status === 'confirmed' || r.band === 'High')
                : reports
            }
            point={point}
            tracked={situation?.tracked ?? null}
            projectionMinutes={45}
            showRadar={showRadar && mode === 'live'}
            showFacilities={showFacilities}
            theme={theme}
            fitBounds={fitBounds}
            track={track}
            highlighted={highlighted}
            examined={
              examined
                ? { lat: examined.lat, lon: examined.lon, radiusMiles: examined.radiusMiles, band: examined.band }
                : null
            }
            onSelectPoint={(p) => {
              setHighlighted(null);
              setPoint(p);
            }}
            onSelectFacility={setHighlighted}
            onRadarFrame={(frame, total, time) => setRadarFrame({ frame, total, time })}
          />

          {/* A tornado warning that appeared since the last poll. The only
              thing in the feed allowed to interrupt. */}
          {breaking.length ? (
            <div className="absolute top-3 right-3 left-3 z-20 flex flex-col gap-2 lg:left-auto lg:w-80">
              {breaking.map((a) => (
                <div
                  key={a.id}
                  role="alert"
                  className="pointer-events-auto rounded-lg border px-3 py-2 shadow-lg"
                  style={{
                    background: 'color-mix(in srgb, var(--band-high) 20%, var(--surface-panel))',
                    borderColor: 'var(--band-high)',
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-bold" style={{ color: 'var(--band-high)' }}>
                      New tornado warning
                    </span>
                    <button
                      type="button"
                      onClick={() => setBreaking((prev) => prev.filter((b) => b.id !== a.id))}
                      className="text-xs"
                      style={{ color: 'var(--text-muted)' }}
                      aria-label="Dismiss"
                    >
                      Dismiss
                    </button>
                  </div>
                  <p className="mt-0.5 text-xs" style={{ color: 'var(--text-primary)' }}>
                    {a.areaDesc}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      const at = a.motion?.position ?? alertAnchor(a);
                      if (at) {
                        setPoint(at);
                        setFitBounds([at.lon - 0.5, at.lat - 0.4, at.lon + 0.5, at.lat + 0.4]);
                      }
                      setBreaking((prev) => prev.filter((b) => b.id !== a.id));
                    }}
                    className="mt-1.5 rounded px-2 py-1 text-[11px] font-semibold"
                    style={{ background: 'var(--band-high)', color: '#fff' }}
                  >
                    Go to it
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <div className="pointer-events-none absolute top-3 left-3 flex flex-col gap-2">
            <div
              className="pointer-events-auto flex flex-wrap gap-1 rounded-lg p-1"
              style={{ background: 'color-mix(in srgb, var(--surface-panel) 92%, transparent)' }}
            >
              {mode === 'live' ? (
                <LayerToggle active={showRadar} onClick={() => setShowRadar((v) => !v)}>
                  Radar
                  {/* A loop is only useful if you can tell which moment you are
                      looking at, so the frame labels itself. */}
                  {showRadar && radarFrame ? (
                    <span className="ml-1 tabular-nums opacity-80">
                      {/* Real frame timestamps from the radar index, rather
                          than assuming a fixed five minutes a step. */}
                      {(() => {
                        const mins = Math.round((Date.now() / 1000 - radarFrame.time) / 60);
                        return mins <= 1 ? 'now' : `-${mins}m`;
                      })()}
                    </span>
                  ) : null}
                </LayerToggle>
              ) : null}
              <LayerToggle active={showFacilities} onClick={() => setShowFacilities((v) => !v)}>
                Infrastructure
              </LayerToggle>
              {/* What counts as infrastructure. Shelters first, because that
                  is where a tornado response starts, with the full critical
                  infrastructure list the brief asks for one tap away. */}
              {showFacilities
                ? (
                    [
                      ['shelters', 'Shelters'],
                      ['lifesafety', 'Life safety'],
                      ['all', 'All'],
                    ] as const
                  ).map(([id, label]) => (
                    <LayerToggle key={id} active={facilityScope === id} onClick={() => setFacilityScope(id)}>
                      {label}
                    </LayerToggle>
                  ))
                : null}
              <LayerToggle active={false} onClick={focusOnAlerts}>
                Fit to alerts
              </LayerToggle>
            </div>

            {facilitySource === 'none' ? (
              <p
                className="pointer-events-auto max-w-56 rounded-lg px-2.5 py-1.5 text-[11px]"
                style={{ background: 'var(--surface-panel)', color: 'var(--band-medium)' }}
              >
                Infrastructure data is unavailable for this area. Exposure is not being scored, which
                is not the same as there being nothing here.
              </p>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="absolute right-4 bottom-20 rounded-full px-5 py-3 text-sm font-semibold shadow-lg lg:bottom-6"
            style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
          >
            File a report
          </button>
        </main>

        {/* Desktop rail, mobile bottom sheet. */}
        <aside
          id="panel"
          aria-label="Situation detail"
          className={[
            'flex flex-col border-t lg:border-t-0 lg:border-l',
            'absolute inset-x-0 bottom-0 z-10 max-h-[85dvh] rounded-t-2xl lg:static lg:max-h-none lg:rounded-none',
            sheetOpen ? 'h-[70dvh]' : 'h-auto',
            'lg:h-auto',
          ].join(' ')}
          style={{ background: 'var(--surface-panel)', borderColor: 'var(--border-soft)' }}
        >
          <div className="flex items-center gap-1 border-b px-2 py-2" style={{ borderColor: 'var(--border-soft)' }}>
            <button
              type="button"
              onClick={() => setSheetOpen((v) => !v)}
              className="rounded px-2 py-1 text-xs lg:hidden"
              style={{ color: 'var(--text-muted)' }}
              aria-expanded={sheetOpen}
            >
              {sheetOpen ? 'Collapse' : 'Expand'}
            </button>
            <div role="tablist" aria-label="Panel sections" className="flex flex-1 gap-1">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => {
                    setTab(t.id);
                    setSheetOpen(true);
                  }}
                  className="flex-1 rounded-md px-2 py-1.5 text-xs font-medium"
                  style={{
                    background: tab === t.id ? 'var(--surface-raised)' : 'transparent',
                    color: tab === t.id ? 'var(--text-primary)' : 'var(--text-muted)',
                  }}
                >
                  {t.label}
                  {t.badge ? <span className="ml-1 tabular-nums opacity-70">{t.badge}</span> : null}
                </button>
              ))}
            </div>
          </div>

          <div className={['min-h-0 flex-1 overflow-y-auto scroll-slim', sheetOpen ? '' : 'hidden lg:block'].join(' ')}>
            {tab === 'situation' ? (
              <SituationPanel
                situation={situation}
                now={clock}
                placeLabel={placeLabel}
                onFocusFacility={focusFacility}
              />
            ) : tab === 'reports' ? (
              <ReportsPanel
                reports={reports}
                now={clock}
                onFocus={openReport}
                activeId={activeReport}
                onRadius={(id, miles) => void handleRadius(id, miles)}
                onStatus={handleStatus}
                onDelete={(id) => void handleDelete(id)}
                onExport={() => void handleExport()}
              />
            ) : tab === 'inject' ? (
              <InjectionPanel settings={injection} onChange={setInjection} />
            ) : (
              <ExposurePanel
                situation={situation}
                source={facilitySource}
                highlighted={highlighted}
                onFocusFacility={focusFacility}
              />
            )}
          </div>
        </aside>
      </div>

      <ReportDialog
        open={dialogOpen}
        mapPoint={point}
        onClose={() => setDialogOpen(false)}
        onSubmit={(draft) => void handleSubmitReport(draft)}
      />
    </div>
  );
}

function LayerToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="rounded-md px-2.5 py-1.5 text-[11px] font-medium"
      style={{
        background: active ? 'var(--accent)' : 'var(--surface-raised)',
        color: active ? 'var(--accent-contrast)' : 'var(--text-secondary)',
      }}
    >
      {children}
    </button>
  );
}

export { deleteReport };
