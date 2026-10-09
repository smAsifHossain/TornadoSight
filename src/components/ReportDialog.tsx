import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { screenImage, warmUp, type ScreeningResult } from '../lib/model';
import { distanceMiles, type LatLon } from '../lib/geo';
import { BandChip, Meter, Section, formatCoord } from './ui';
import { buildSituation, type Situation } from '../lib/situation';
import { loadFacilities, type FacilitySource } from '../lib/facilities';
import { fetchAlertsAtPoint, type Alert } from '../lib/nws';
import { compass, fetchWeather, type WeatherSnapshot } from '../lib/openmeteo';
import { placeLabel, searchPlaces, type Place } from '../lib/geocode';
import type { Facility } from '../lib/scoring';

/**
 * Filing a storm report.
 *
 * The whole point is that a person says where they saw something, in the words
 * they would actually use, and the system does the rest. Naming a place
 * resolves it to coordinates, then pulls the weather there, asks the National
 * Weather Service what is in effect over that exact point, finds the shelters
 * and critical facilities around it, screens the photograph on this device, and
 * only then reaches a decision. Each of those four is shown as it lands, so the
 * reasoning is visible rather than appearing fully formed at the end.
 *
 * Uses a native <dialog>, so focus is trapped, Escape closes it and the
 * backdrop is inert without reimplementing any of that.
 */

const SAMPLES = [
  { file: 'funnel.jpg', label: 'Tornado' },
  { file: 'shelf-cloud.jpg', label: 'Shelf cloud' },
  { file: 'mammatus.jpg', label: 'Mammatus' },
] as const;

type StepState = 'idle' | 'loading' | 'done' | 'error';

export interface ReportDraft {
  point: LatLon;
  placeName: string;
  photo: Blob | null;
  photoName: string | null;
  note: string;
  reporter: string;
  screening: ScreeningResult | null;
  situation: Situation;
}

interface Props {
  open: boolean;
  /** Where the map is currently looking, offered as a starting point. */
  mapPoint: LatLon | null;
  onClose: () => void;
  onSubmit: (draft: ReportDraft) => void;
}

/** One line of the live assessment, with its own state and finding. */
function Step({
  label,
  state,
  finding,
  detail,
  tone,
}: {
  label: string;
  state: StepState;
  finding?: string;
  detail?: string;
  tone?: string;
}) {
  const mark =
    state === 'done' ? '✓' : state === 'error' ? '!' : state === 'loading' ? '···' : '·';
  return (
    <li className="flex items-start gap-2.5 py-1.5">
      <span
        aria-hidden
        className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full text-[9px] font-bold"
        style={{
          background:
            state === 'done'
              ? 'color-mix(in srgb, var(--band-low) 25%, transparent)'
              : state === 'error'
                ? 'color-mix(in srgb, var(--band-medium) 25%, transparent)'
                : 'var(--surface-raised)',
          color: state === 'done' ? 'var(--band-low)' : state === 'error' ? 'var(--band-medium)' : 'var(--text-muted)',
        }}
      >
        {mark}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline justify-between gap-x-2">
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {label}
          </span>
          {finding ? (
            <span className="text-xs font-semibold" style={{ color: tone ?? 'var(--text-primary)' }}>
              {finding}
            </span>
          ) : null}
        </span>
        {detail ? (
          <span className="mt-0.5 block text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {detail}
          </span>
        ) : null}
      </span>
    </li>
  );
}

export default function ReportDialog({ open, mapPoint, onClose, onSubmit }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  /* where */
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [place, setPlace] = useState<{ label: string; point: LatLon } | null>(null);

  /* what the system found there */
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [weather, setWeather] = useState<WeatherSnapshot | null>(null);
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [facilitySource, setFacilitySource] = useState<FacilitySource>('none');
  const [alertState, setAlertState] = useState<StepState>('idle');
  const [weatherState, setWeatherState] = useState<StepState>('idle');
  const [facilityState, setFacilityState] = useState<StepState>('idle');

  /* the photograph */
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [screening, setScreening] = useState<ScreeningResult | null>(null);
  const [photoState, setPhotoState] = useState<StepState>('idle');
  const [photoError, setPhotoError] = useState<string | null>(null);

  const [note, setNote] = useState('');
  const [reporter, setReporter] = useState('');

  const baseId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // Fetch the backbone while the operator is still typing the location, so
      // screening feels immediate rather than stalling on a 29 MB download.
      warmUp();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  /* ---- place search ---- */
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      searchPlaces(query, controller.signal)
        .then(setResults)
        .catch(() => undefined)
        .finally(() => setSearching(false));
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  /**
   * Everything the system can learn about a location, gathered at once.
   * The three requests are independent, so they run together and each updates
   * its own line as it lands rather than waiting for the slowest.
   */
  const assess = useCallback(async (point: LatLon) => {
    setAlertState('loading');
    setWeatherState('loading');
    setFacilityState('loading');

    void fetchAlertsAtPoint(point)
      .then((a) => {
        setAlerts(a);
        setAlertState('done');
      })
      .catch(() => setAlertState('error'));

    void fetchWeather(point)
      .then((w) => {
        setWeather(w);
        setWeatherState('done');
      })
      .catch(() => setWeatherState('error'));

    const pad = 0.3;
    void loadFacilities({
      west: point.lon - pad,
      south: point.lat - pad,
      east: point.lon + pad,
      north: point.lat + pad,
    })
      .then((r) => {
        setFacilities(r.facilities);
        setFacilitySource(r.source);
        setFacilityState(r.source === 'none' ? 'error' : 'done');
      })
      .catch(() => setFacilityState('error'));
  }, []);

  const choosePlace = useCallback(
    (label: string, point: LatLon) => {
      setPlace({ label, point });
      setResults([]);
      setQuery(label);
      void assess(point);
    },
    [assess],
  );

  /** Use the device's own position, which is what a field responder has. */
  const useMyLocation = useCallback(() => {
    if (!navigator.geolocation) return;
    setAlertState('loading');
    navigator.geolocation.getCurrentPosition(
      (pos) => choosePlace('My current location', { lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => setAlertState('error'),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, [choosePlace]);

  async function handlePhoto(file: File | undefined) {
    if (!file) return;
    setPhoto(file);
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(file);
    });
    setPhotoState('loading');
    setPhotoError(null);
    try {
      setScreening(await screenImage(file));
      setPhotoState('done');
    } catch (err) {
      setPhotoState('error');
      setPhotoError(err instanceof Error ? err.message : 'The photograph could not be screened.');
    }
  }

  async function useSample(sample: (typeof SAMPLES)[number]) {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL ?? '/'}samples/${sample.file}`);
      if (!res.ok) throw new Error(`sample unavailable (${res.status})`);
      const blob = await res.blob();
      await handlePhoto(new File([blob], sample.file, { type: blob.type }));
    } catch (err) {
      setPhotoState('error');
      setPhotoError(err instanceof Error ? err.message : 'The sample could not be loaded.');
    }
  }

  function reset() {
    setQuery('');
    setResults([]);
    setPlace(null);
    setAlerts([]);
    setWeather(null);
    setFacilities([]);
    setFacilitySource('none');
    setAlertState('idle');
    setWeatherState('idle');
    setFacilityState('idle');
    setPhoto(null);
    setPreview(null);
    setScreening(null);
    setPhotoState('idle');
    setPhotoError(null);
    setNote('');
    setReporter('');
  }

  const situation = place
    ? buildSituation({
        point: place.point,
        alerts,
        weather,
        facilities,
        imageConfidence: screening?.probability ?? null,
        imageUncertain: screening?.uncertain ?? false,
      })
    : null;

  const busy = [alertState, weatherState, facilityState].includes('loading') || photoState === 'loading';

  const worstAlert = situation?.local[0] ?? null;
  const shelters = (situation?.exposure.facilities ?? []).filter((f) => f.kind === 'storm_shelter');
  const nearestShelter = shelters[0] ?? null;

  function submit() {
    if (!place || !situation) return;
    onSubmit({
      point: place.point,
      placeName: place.label,
      photo,
      photoName: photo?.name ?? null,
      note: note.trim(),
      reporter: reporter.trim(),
      screening,
      situation,
    });
    reset();
  }

  return (
    <dialog
      ref={dialogRef}
      closedby="any"
      onClose={() => {
        reset();
        onClose();
      }}
      aria-labelledby={`${baseId}-title`}
      className="m-auto w-[min(40rem,calc(100vw-1.5rem))] rounded-xl border p-0 backdrop:bg-black/70"
      style={{ background: 'var(--surface-panel)', borderColor: 'var(--border-soft)', color: 'var(--text-primary)' }}
    >
      <header
        className="flex items-center justify-between gap-3 border-b px-5 py-3.5"
        style={{ borderColor: 'var(--border-soft)' }}
      >
        <h2 id={`${baseId}-title`} className="text-base font-semibold">
          File a storm report
        </h2>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          className="rounded px-2 py-1 text-sm"
          style={{ color: 'var(--text-muted)' }}
        >
          Close
        </button>
      </header>

      <div className="max-h-[72dvh] overflow-y-auto scroll-slim">
        {/* ---- 1. where ---- */}
        <Section title="Where was it seen">
          <div className="relative">
            <label htmlFor={`${baseId}-place`} className="sr-only">
              Town, county or address where the tornado was seen
            </label>
            <div className="flex gap-2">
              <input
                id={`${baseId}-place`}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Town, county or landmark"
                autoComplete="off"
                className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm"
                style={{ background: 'var(--surface-input)', borderColor: 'var(--border-soft)' }}
              />
              <button
                type="button"
                onClick={useMyLocation}
                className="shrink-0 rounded-lg px-2.5 py-2 text-[11px]"
                style={{ background: 'var(--surface-raised)', color: 'var(--text-secondary)' }}
              >
                Use my location
              </button>
              {mapPoint ? (
                <button
                  type="button"
                  onClick={() => choosePlace(formatCoord(mapPoint.lat, mapPoint.lon), mapPoint)}
                  className="shrink-0 rounded-lg px-2.5 py-2 text-[11px]"
                  style={{ background: 'var(--surface-raised)', color: 'var(--text-secondary)' }}
                >
                  Use map pin
                </button>
              ) : null}
            </div>

            {searching ? (
              <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Searching…
              </p>
            ) : null}

            {results.length ? (
              <ul
                className="absolute right-0 left-0 z-30 mt-1 max-h-56 overflow-y-auto rounded-lg border shadow-lg scroll-slim"
                style={{ background: 'var(--surface-panel)', borderColor: 'var(--border-soft)' }}
              >
                {results.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => choosePlace(placeLabel(p), { lat: p.lat, lon: p.lon })}
                      className="block w-full px-3 py-2 text-left text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      <span style={{ color: 'var(--text-primary)' }}>{p.name}</span>
                      <span className="ml-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                        {[p.admin1, p.country].filter(Boolean).join(', ')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {place ? (
            <p className="mt-2 font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {place.label} &rarr; {formatCoord(place.point.lat, place.point.lon)}
            </p>
          ) : (
            <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Name the place and everything below is gathered for those coordinates automatically.
            </p>
          )}
        </Section>

        {/* ---- 2. what the system found ---- */}
        {place ? (
          <Section
            title="What the system found there"
            aside={
              busy ? (
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  checking…
                </span>
              ) : null
            }
          >
            <ul>
              <Step
                label="National Weather Service alerts"
                state={alertState}
                finding={
                  alertState === 'done'
                    ? worstAlert
                      ? worstAlert.event
                      : 'None in effect'
                    : alertState === 'error'
                      ? 'Unavailable'
                      : undefined
                }
                tone={worstAlert?.event === 'Tornado Warning' ? 'var(--band-high)' : undefined}
                detail={
                  worstAlert
                    ? [
                        worstAlert.areaDesc,
                        worstAlert.motion
                          ? `tracking ${compass(worstAlert.motion.heading)} at ${Math.round(worstAlert.motion.speedMph)} mph`
                          : null,
                        worstAlert.tornadoDetection?.toLowerCase(),
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : undefined
                }
              />

              <Step
                label="Weather at that point"
                state={weatherState}
                finding={weather ? `severity ${situation?.weatherScore.score.toFixed(2)}` : undefined}
                detail={
                  weather
                    ? [
                        weather.cape != null ? `CAPE ${Math.round(weather.cape)}` : null,
                        weather.liftedIndex != null ? `LI ${weather.liftedIndex.toFixed(1)}` : null,
                        weather.windGustMph != null ? `gust ${Math.round(weather.windGustMph)} mph` : null,
                        weather.dewPointF != null ? `dew ${Math.round(weather.dewPointF)}F` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : undefined
                }
              />

              <Step
                label="Shelters and critical facilities"
                state={facilityState}
                finding={
                  facilityState === 'done'
                    ? `${situation?.exposure.facilities.length ?? 0} within range`
                    : facilityState === 'error'
                      ? 'No data here'
                      : undefined
                }
                detail={
                  facilityState === 'error'
                    ? 'Exposure is not being scored, which is not the same as there being nothing here.'
                    : nearestShelter
                      ? `Nearest storm shelter ${nearestShelter.name}, ${nearestShelter.distanceMiles.toFixed(1)} mi`
                      : shelters.length === 0 && facilityState === 'done'
                        ? 'No designated storm shelter is mapped nearby.'
                        : undefined
                }
              />

              <Step
                label="Photograph"
                state={photoState}
                finding={
                  screening
                    ? `${(screening.probability * 100).toFixed(0)}%`
                    : photoState === 'error'
                      ? 'Could not screen'
                      : photoState === 'idle'
                        ? 'Optional'
                        : undefined
                }
                tone={screening && screening.probability >= 0.65 ? 'var(--band-high)' : undefined}
                detail={screening ? screening.label : photoError ?? undefined}
              />
            </ul>

            {facilitySource === 'live' ? (
              <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Infrastructure fetched live for this area, because it was not prepared in advance.
              </p>
            ) : null}
          </Section>
        ) : null}

        {/* ---- 3. the photograph ---- */}
        {place ? (
          <Section title="Photograph, if there is one">
            <input
              id={`${baseId}-photo`}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => handlePhoto(e.target.files?.[0])}
              className="w-full rounded-lg border px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:px-3 file:py-1 file:text-xs"
              style={{ background: 'var(--surface-input)', borderColor: 'var(--border-soft)' }}
            />
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Or try one:
              </span>
              {SAMPLES.map((s) => (
                <button
                  key={s.file}
                  type="button"
                  onClick={() => void useSample(s)}
                  className="rounded px-2 py-1 text-[11px]"
                  style={{ background: 'var(--surface-raised)', color: 'var(--text-secondary)' }}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {preview ? (
              <img
                src={preview}
                alt="The storm photograph submitted with this report"
                className="mt-3 max-h-44 w-full rounded-lg object-cover"
              />
            ) : null}

            {screening ? (
              <div className="mt-2">
                <Meter
                  value={screening.probability}
                  color={screening.uncertain ? 'var(--band-review)' : 'var(--band-medium)'}
                />
              </div>
            ) : null}

            <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Screened on this device in about half a second. The picture is never uploaded, and the
              result is a triage signal, not a confirmation of a tornado.
            </p>
          </Section>
        ) : null}

        {/* ---- 4. the decision ---- */}
        {situation ? (
          <Section title="Decision">
            <div className="flex items-center gap-3">
              <div
                className="flex size-14 shrink-0 flex-col items-center justify-center rounded-xl"
                style={{
                  background: `color-mix(in srgb, ${
                    situation.priority.band === 'High'
                      ? 'var(--band-high)'
                      : situation.priority.band === 'Medium'
                        ? 'var(--band-medium)'
                        : situation.priority.band === 'Low'
                          ? 'var(--band-low)'
                          : 'var(--band-review)'
                  } 14%, transparent)`,
                }}
              >
                <span className="text-xl font-bold tabular-nums">
                  {Math.round(situation.priority.score * 100)}
                </span>
                <span className="text-[9px] tracking-wider uppercase" style={{ color: 'var(--text-muted)' }}>
                  of 100
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <BandChip band={situation.priority.band} />
                <ul className="mt-2 space-y-1">
                  {situation.priority.reasons.map((r) => (
                    <li key={r} className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                      &bull; {r}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {situation.priority.override ? (
              <p className="mt-2 text-[11px]" style={{ color: 'var(--band-high)' }}>
                {situation.priority.override}
              </p>
            ) : null}

            {nearestShelter ? (
              <p
                className="mt-3 rounded-lg px-3 py-2 text-xs"
                style={{ background: 'var(--surface-raised)', color: 'var(--text-secondary)' }}
              >
                Nearest storm shelter: <strong style={{ color: 'var(--text-primary)' }}>{nearestShelter.name}</strong>,{' '}
                {nearestShelter.distanceMiles.toFixed(1)} miles{' '}
                {place
                  ? compass(
                      (Math.atan2(
                        nearestShelter.lon - place.point.lon,
                        nearestShelter.lat - place.point.lat,
                      ) *
                        180) /
                        Math.PI +
                        360,
                    )
                  : ''}
                {shelters.length > 1 ? `, ${shelters.length - 1} more within range` : ''}.
              </p>
            ) : null}

            <details className="mt-3">
              <summary
                className="cursor-pointer list-none text-[11px] tracking-wide uppercase select-none"
                style={{ color: 'var(--text-muted)' }}
              >
                How this number was reached
              </summary>
              <table className="mt-2 w-full text-[11px]">
                <tbody style={{ color: 'var(--text-secondary)' }}>
                  {situation.priority.contributions.map((c) => (
                    <tr key={c.label}>
                      <td className="py-0.5">{c.label}</td>
                      <td className="py-0.5 text-right tabular-nums">{c.weight.toFixed(2)}</td>
                      <td className="py-0.5 text-right tabular-nums">{c.value.toFixed(2)}</td>
                      <td
                        className="py-0.5 text-right font-semibold tabular-nums"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        {c.weighted.toFixed(3)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </Section>
        ) : null}

        {/* ---- 5. the human part ---- */}
        {place ? (
          <Section title="What was seen">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Rotating wall cloud south of the highway, debris in the air."
              className="w-full rounded-lg border px-3 py-2 text-sm"
              style={{ background: 'var(--surface-input)', borderColor: 'var(--border-soft)' }}
              aria-label="What was seen"
            />
            <input
              value={reporter}
              onChange={(e) => setReporter(e.target.value)}
              placeholder="Reported by: call sign or unit, not a personal address"
              className="mt-2 w-full rounded-lg border px-3 py-2 text-sm"
              style={{ background: 'var(--surface-input)', borderColor: 'var(--border-soft)' }}
              aria-label="Reported by"
            />
          </Section>
        ) : null}
      </div>

      <footer
        className="flex items-center justify-between gap-2 border-t px-5 py-3.5"
        style={{ borderColor: 'var(--border-soft)' }}
      >
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {place
            ? `${situation?.exposure.facilities.length ?? 0} facilities · ${alerts.length} alerts`
            : 'Name a location to begin'}
        </span>
        <span className="flex gap-2">
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className="rounded-lg px-3 py-2 text-sm"
            style={{ color: 'var(--text-secondary)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!place || busy}
            className="rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
            style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
          >
            File report
          </button>
        </span>
      </footer>
    </dialog>
  );
}

/** Re-exported so the report list can show how far a shelter was. */
export { distanceMiles };
