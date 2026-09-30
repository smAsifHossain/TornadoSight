import { useEffect, useId, useRef, useState } from 'react';
import { screenImage, warmUp, type ScreeningResult } from '../lib/model';
import type { LatLon } from '../lib/geo';
import { BandChip, Meter, formatCoord } from './ui';
import type { Situation } from '../lib/situation';
import { buildSituation } from '../lib/situation';
import type { Facility } from '../lib/scoring';
import type { Alert } from '../lib/nws';
import type { WeatherSnapshot } from '../lib/openmeteo';

/**
 * Filing a storm report.
 *
 * Uses a native <dialog> so focus is trapped, Escape closes it and the
 * backdrop is inert without any of that being reimplemented in JavaScript.
 *
 * The photograph is screened on this device. It is never uploaded, and the
 * dialog says so plainly, because a citizen handing over a picture of their own
 * street deserves to know where it goes.
 */

/**
 * Bundled public domain photographs, so the screener can be exercised without
 * anyone having to go and find a storm. One clear funnel and two of the cloud
 * forms most often mistaken for one.
 */
const SAMPLES = [
  { file: 'funnel.jpg', label: 'Tornado' },
  { file: 'shelf-cloud.jpg', label: 'Shelf cloud' },
  { file: 'mammatus.jpg', label: 'Mammatus' },
] as const;

export interface ReportDraft {
  point: LatLon;
  photo: Blob | null;
  photoName: string | null;
  note: string;
  reporter: string;
  screening: ScreeningResult | null;
  situation: Situation;
}

interface Props {
  open: boolean;
  point: LatLon | null;
  alerts: Alert[];
  weather: WeatherSnapshot | null;
  facilities: Facility[];
  onClose: () => void;
  onSubmit: (draft: ReportDraft) => void;
}

export default function ReportDialog({ open, point, alerts, weather, facilities, onClose, onSubmit }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [reporter, setReporter] = useState('');
  const [screening, setScreening] = useState<ScreeningResult | null>(null);
  const [status, setStatus] = useState<'idle' | 'screening' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const photoId = useId();
  const noteId = useId();
  const reporterId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // Fetch the backbone while the operator is still typing, so screening
      // feels immediate rather than stalling on a 29 MB download.
      warmUp();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  function reset() {
    setPhoto(null);
    setPreview(null);
    setNote('');
    setReporter('');
    setScreening(null);
    setStatus('idle');
    setError(null);
  }

  /** Load one of the bundled sample photographs and screen it like any other. */
  async function useSample(sample: (typeof SAMPLES)[number]) {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL ?? '/'}samples/${sample.file}`);
      if (!res.ok) throw new Error(`sample unavailable (${res.status})`);
      const blob = await res.blob();
      await handlePhoto(new File([blob], sample.file, { type: blob.type }));
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? `The sample could not be loaded: ${err.message}` : 'The sample could not be loaded.');
    }
  }

  async function handlePhoto(file: File | undefined) {
    if (!file) return;
    setPhoto(file);
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(file);
    });
    setStatus('screening');
    setError(null);
    try {
      const result = await screenImage(file);
      setScreening(result);
      setStatus('ready');
    } catch (err) {
      setStatus('error');
      setError(
        err instanceof Error
          ? `The photograph could not be screened: ${err.message}`
          : 'The photograph could not be screened.',
      );
    }
  }

  const situation = point
    ? buildSituation({
        point,
        alerts,
        weather,
        facilities,
        imageConfidence: screening?.probability ?? null,
        imageUncertain: screening?.uncertain ?? false,
      })
    : null;

  function submit() {
    if (!point || !situation) return;
    onSubmit({
      point,
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
      aria-labelledby={`${photoId}-title`}
      className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-xl border p-0 backdrop:bg-black/60"
      style={{ background: 'var(--surface-panel)', borderColor: 'var(--border-soft)', color: 'var(--text-primary)' }}
    >
      <form method="dialog" className="contents">
        <header
          className="flex items-center justify-between gap-3 border-b px-5 py-4"
          style={{ borderColor: 'var(--border-soft)' }}
        >
          <h2 id={`${photoId}-title`} className="text-base font-semibold">
            File a storm report
          </h2>
          <button
            type="submit"
            value="cancel"
            className="rounded px-2 py-1 text-sm"
            style={{ color: 'var(--text-muted)' }}
            aria-label="Close"
          >
            Close
          </button>
        </header>
      </form>

      <div className="max-h-[70dvh] overflow-y-auto px-5 py-4 scroll-slim">
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {point ? (
            <>Location taken from the map: {formatCoord(point.lat, point.lon)}</>
          ) : (
            <>Choose a point on the map first.</>
          )}
        </p>

        <div className="mt-4">
          <label htmlFor={photoId} className="block text-sm font-medium">
            Photograph
          </label>
          <input
            id={photoId}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => handlePhoto(e.target.files?.[0])}
            className="mt-1.5 w-full rounded-lg border px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:px-3 file:py-1 file:text-xs"
            style={{
              background: 'var(--surface-input)',
              borderColor: 'var(--border-soft)',
            }}
          />
          <p className="mt-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Screened on this device. The picture is never uploaded, and a report can be filed
            without one.
          </p>

          {/* Anyone evaluating this is unlikely to have a storm photograph to
              hand, and a screener nobody can try is a screener nobody trusts. */}
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
        </div>

        {preview ? (
          <figure className="mt-3">
            <img
              src={preview}
              alt="The storm photograph submitted with this report"
              className="max-h-52 w-full rounded-lg object-cover"
            />
          </figure>
        ) : null}

        {status === 'screening' ? (
          <p className="mt-3 text-sm" style={{ color: 'var(--text-secondary)' }} role="status">
            Screening the photograph on this device…
          </p>
        ) : null}

        {status === 'error' && error ? (
          <p
            className="mt-3 rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--band-high)', color: 'var(--band-high)' }}
            role="alert"
          >
            {error} The report can still be filed on the weather, warning and exposure signals alone.
          </p>
        ) : null}

        {screening ? (
          <div className="mt-3 rounded-lg px-3 py-3" style={{ background: 'var(--surface-raised)' }}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium">{screening.label}</span>
              <span className="text-sm font-semibold tabular-nums">
                {(screening.probability * 100).toFixed(0)}%
              </span>
            </div>
            <div className="mt-2">
              <Meter
                value={screening.probability}
                color={screening.uncertain ? 'var(--band-review)' : 'var(--band-medium)'}
              />
            </div>
            <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              A screening signal for triage only. It is not a confirmation of a tornado and does not
              replace National Weather Service products. Screened in {Math.round(screening.elapsedMs)} ms.
            </p>
          </div>
        ) : null}

        <div className="mt-4">
          <label htmlFor={noteId} className="block text-sm font-medium">
            What was seen
          </label>
          <textarea
            id={noteId}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="Rotating wall cloud south of the highway, debris in the air."
            className="mt-1.5 w-full rounded-lg border px-3 py-2 text-sm"
            style={{ background: 'var(--surface-input)', borderColor: 'var(--border-soft)' }}
          />
        </div>

        <div className="mt-3">
          <label htmlFor={reporterId} className="block text-sm font-medium">
            Reported by
          </label>
          <input
            id={reporterId}
            value={reporter}
            onChange={(e) => setReporter(e.target.value)}
            placeholder="Call sign or unit, not a personal address"
            className="mt-1.5 w-full rounded-lg border px-3 py-2 text-sm"
            style={{ background: 'var(--surface-input)', borderColor: 'var(--border-soft)' }}
          />
        </div>

        {situation ? (
          <div
            className="mt-4 rounded-lg border px-3 py-3"
            style={{ borderColor: 'var(--border-soft)' }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
                Priority if filed now
              </span>
              <BandChip band={situation.priority.band} score={situation.priority.score} />
            </div>
            {situation.priority.reasons.length ? (
              <ul className="mt-2 space-y-1">
                {situation.priority.reasons.map((r) => (
                  <li key={r} className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                    &bull; {r}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      <footer
        className="flex items-center justify-end gap-2 border-t px-5 py-4"
        style={{ borderColor: 'var(--border-soft)' }}
      >
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
          disabled={!point || status === 'screening'}
          className="rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
          style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
        >
          File report
        </button>
      </footer>
    </dialog>
  );
}
