import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MapView from './components/MapView';
import SituationPanel from './components/SituationPanel';
import ReportsPanel from './components/ReportsPanel';
import ReportDialog, { type ReportDraft } from './components/ReportDialog';
import ExposurePanel from './components/ExposurePanel';
import Header from './components/Header';
import { fetchActiveAlerts, type Alert } from './lib/nws';
import { fetchWeather, type WeatherSnapshot } from './lib/openmeteo';
import { loadFacilities, type FacilitySource } from './lib/facilities';
import { buildSituation, type Situation } from './lib/situation';
import { boundsOf, type LatLon } from './lib/geo';
import type { Facility } from './lib/scoring';
import {
  deleteReport,
  exportJson,
  listReports,
  saveReport,
  setReportStatus,
  type ReportStatus,
  type StoredReport,
} from './lib/storage';
import { alertsAt, loadReplay, openingMoment, REPLAY_CATALOG, trackedBounds, activeBounds, type ReplayEvent } from './lib/replay';

export type Mode = 'live' | 'replay';
type Tab = 'situation' | 'reports' | 'exposure';

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

export default function App() {
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
  const [now, setNow] = useState(() => Date.now());

  /* A slow tick so every relative time on screen stays honest. */
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  /* ---------------------------------------------------------------- *
   * Live alerts
   * ---------------------------------------------------------------- */

  const refreshAlerts = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchActiveAlerts();
      setAlerts(next);
      setLastUpdated(new Date());
      setError(null);
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

  useEffect(() => {
    if (mode !== 'replay' || replay) return;
    void loadReplay(REPLAY_CATALOG[0].slug)
      .then((event) => {
        setReplay(event);
        // Open just before the first tracked storm, on that storm, rather than
        // at the start of the captured window looking at an empty map.
        const opening = openingMoment(event);
        setReplayAt(opening.at);
        if (opening.point) setPoint(opening.point);
        setFitBounds(trackedBounds(event) ?? activeBounds(event));
        setError(null);
      })
      .catch((err) => setError(`The replay event could not be loaded: ${err.message}`));
  }, [mode, replay]);

  useEffect(() => {
    if (mode !== 'replay' || !replay || !playing) return;
    const id = setInterval(() => {
      setReplayAt((current) => {
        if (!current) return current;
        const next = new Date(current.getTime() + 60_000);
        if (next > replay.window.end) {
          setPlaying(false);
          return replay.window.end;
        }
        return next;
      });
    }, 250);
    return () => clearInterval(id);
  }, [mode, replay, playing]);

  const visibleAlerts = useMemo(() => {
    if (mode === 'replay') {
      return replay && replayAt ? alertsAt(replay, replayAt) : [];
    }
    return alerts;
  }, [mode, replay, replayAt, alerts]);

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

  /* ---------------------------------------------------------------- *
   * Reports
   * ---------------------------------------------------------------- */

  const refreshReports = useCallback(() => {
    void listReports().then(setReports).catch(() => undefined);
  }, []);

  useEffect(() => refreshReports(), [refreshReports]);

  /**
   * Everything time relative on screen is measured against this. In replay that
   * is the replay clock, otherwise an archived warning reads as having expired
   * days ago, which is true of the calendar and useless to the viewer.
   */
  const clock = mode === 'replay' && replayAt ? replayAt.getTime() : now;

  const situation: Situation | null = useMemo(
    () => buildSituation({ point, alerts: visibleAlerts, weather, facilities }),
    [point, visibleAlerts, weather, facilities],
  );

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
            reports={reports}
            point={point}
            tracked={situation?.tracked ?? null}
            projectionMinutes={45}
            showRadar={showRadar && mode === 'live'}
            showFacilities={showFacilities}
            theme={theme}
            fitBounds={fitBounds}
            onSelectPoint={setPoint}
          />

          <div className="pointer-events-none absolute top-3 left-3 flex flex-col gap-2">
            <div
              className="pointer-events-auto flex flex-wrap gap-1 rounded-lg p-1"
              style={{ background: 'color-mix(in srgb, var(--surface-panel) 92%, transparent)' }}
            >
              {mode === 'live' ? (
                <LayerToggle active={showRadar} onClick={() => setShowRadar((v) => !v)}>
                  Radar
                </LayerToggle>
              ) : null}
              <LayerToggle active={showFacilities} onClick={() => setShowFacilities((v) => !v)}>
                Infrastructure
              </LayerToggle>
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
              <SituationPanel situation={situation} now={clock} />
            ) : tab === 'reports' ? (
              <ReportsPanel
                reports={reports}
                now={clock}
                onFocus={(r) => {
                  setPoint({ lat: r.lat, lon: r.lon });
                  setFitBounds([r.lon - 0.15, r.lat - 0.12, r.lon + 0.15, r.lat + 0.12]);
                }}
                onStatus={handleStatus}
                onExport={() => void handleExport()}
              />
            ) : (
              <ExposurePanel situation={situation} source={facilitySource} />
            )}
          </div>
        </aside>
      </div>

      <ReportDialog
        open={dialogOpen}
        point={point}
        alerts={visibleAlerts}
        weather={weather}
        facilities={facilities}
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
