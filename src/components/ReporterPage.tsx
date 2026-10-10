import { useCallback, useEffect, useState } from 'react';
import { screenImage, warmUp, type ScreeningResult } from '../lib/model';
import { buildSituation } from '../lib/situation';
import { loadFacilities } from '../lib/facilities';
import { fetchAlertsAtPoint, type Alert } from '../lib/nws';
import { fetchWeather, type WeatherSnapshot } from '../lib/openmeteo';
import { placeLabel, searchPlaces, type Place } from '../lib/geocode';
import { saveReport, type StoredReport } from '../lib/storage';
import type { LatLon } from '../lib/geo';
import { Meter } from './ui';

/**
 * The public side: one short form for somebody who has just seen something.
 *
 * Deliberately not the console. A person standing on their porch watching a
 * funnel does not want a map, a radar loop or a scoring breakdown; they want
 * to say where they are, point a camera, and be done. Everything the system
 * needs beyond that, the warnings in effect, the weather, the shelters nearby,
 * it works out for itself from the location they gave.
 *
 * The assessment still runs, because the report has to arrive in the queue
 * already ranked. It simply happens out of sight.
 */

type Phase = 'form' | 'sending' | 'sent';

export default function ReporterPage({ onBack }: { onBack: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [place, setPlace] = useState<{ label: string; point: LatLon } | null>(null);
  const [locating, setLocating] = useState(false);

  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [screening, setScreening] = useState<ScreeningResult | null>(null);
  const [screeningBusy, setScreeningBusy] = useState(false);

  const [note, setNote] = useState('');
  const [reporter, setReporter] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [result, setResult] = useState<{ band: string; nearestShelter: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    warmUp();
  }, []);

  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  useEffect(() => {
    if (query.trim().length < 2 || place?.label === query) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchPlaces(query, controller.signal).then(setResults).catch(() => undefined);
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, place]);

  const useMyLocation = useCallback(() => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPlace({ label: 'My current location', point: { lat: pos.coords.latitude, lon: pos.coords.longitude } });
        setQuery('My current location');
        setResults([]);
        setLocating(false);
      },
      () => {
        setLocating(false);
        setError('Your location could not be read. Type a town or landmark instead.');
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, []);

  async function handlePhoto(file: File | undefined) {
    if (!file) return;
    setPhoto(file);
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(file);
    });
    setScreeningBusy(true);
    try {
      setScreening(await screenImage(file));
    } catch {
      // A failed screening must never block a report. The other signals stand.
      setScreening(null);
    } finally {
      setScreeningBusy(false);
    }
  }

  /**
   * Gather everything the system can learn about the reported place, score it,
   * and put it in the queue. The person filing never sees this machinery.
   */
  async function submit() {
    if (!place) return;
    setPhase('sending');
    setError(null);

    const pad = 0.3;
    const [alerts, weather, facilityLoad] = await Promise.all([
      fetchAlertsAtPoint(place.point).catch(() => [] as Alert[]),
      fetchWeather(place.point).catch(() => null as WeatherSnapshot | null),
      loadFacilities({
        west: place.point.lon - pad,
        south: place.point.lat - pad,
        east: place.point.lon + pad,
        north: place.point.lat + pad,
      }).catch(() => ({ facilities: [], source: 'none' as const, error: null })),
    ]);

    const situation = buildSituation({
      point: place.point,
      alerts,
      weather,
      facilities: facilityLoad.facilities,
      imageConfidence: screening?.probability ?? null,
      imageUncertain: screening?.uncertain ?? false,
    });

    const report: StoredReport = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      lat: place.point.lat,
      lon: place.point.lon,
      photo,
      photoName: photo?.name ?? null,
      placeName: place.label,
      note: note.trim(),
      reporter: reporter.trim() || 'Public report',
      imageConfidence: screening?.probability ?? null,
      imageUncertain: screening?.uncertain ?? false,
      priorityScore: situation.priority.score,
      band: situation.priority.band,
      reasons: situation.priority.reasons,
      warningScore: situation.warning.score,
      weatherScore: situation.weatherScore.score,
      exposureScore: situation.exposure.score,
      status: 'new',
      // Five miles is about what a sighting from a road covers.
      radiusMiles: 5,
      replaySlug: null,
    };

    try {
      await saveReport(report);
      const nearest = situation.exposure.shelters[0];
      setResult({
        band: situation.priority.band,
        nearestShelter: nearest ? `${nearest.name}, ${nearest.distanceMiles.toFixed(1)} miles away` : null,
      });
      setPhase('sent');
    } catch {
      setPhase('form');
      setError('The report could not be saved on this device. Please try again.');
    }
  }

  if (phase === 'sent') {
    return (
      <div
        className="flex min-h-[100dvh] items-center justify-center px-4 py-10"
        style={{ background: 'var(--surface-base)', color: 'var(--text-primary)' }}
      >
        <div className="panel w-full max-w-md p-6 text-center">
          <div
            className="mx-auto grid size-12 place-items-center rounded-full text-xl"
            style={{ background: 'color-mix(in srgb, var(--band-low) 20%, transparent)', color: 'var(--band-low)' }}
          >
            &#10003;
          </div>
          <h1 className="mt-4 text-xl font-bold">Report received</h1>
          <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            It is in the responder queue, ranked <strong>{result?.band}</strong> against everything
            else waiting.
          </p>

          {result?.nearestShelter ? (
            <p
              className="mt-4 rounded-lg px-3 py-2.5 text-sm"
              style={{ background: 'var(--surface-raised)', color: 'var(--text-secondary)' }}
            >
              Nearest storm shelter to you: <strong>{result.nearestShelter}</strong>
            </p>
          ) : null}

          <p
            className="mt-4 rounded-lg px-3 py-2.5 text-xs leading-relaxed"
            style={{ background: 'var(--surface-raised)', color: 'var(--band-medium)' }}
          >
            If you are in danger, take shelter now and call 911. This tool does not summon
            emergency services.
          </p>

          <div className="mt-5 flex gap-2">
            <button
              type="button"
              onClick={() => {
                setPhase('form');
                setPhoto(null);
                setPreview(null);
                setScreening(null);
                setNote('');
                setResult(null);
              }}
              className="flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold"
              style={{ background: 'var(--surface-raised)', color: 'var(--text-primary)' }}
            >
              File another
            </button>
            <button
              type="button"
              onClick={onBack}
              className="flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold"
              style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-[100dvh] px-4 py-8"
      style={{ background: 'var(--surface-base)', color: 'var(--text-primary)' }}
    >
      <div className="mx-auto w-full max-w-md">
        <button
          type="button"
          onClick={onBack}
          className="text-xs"
          style={{ color: 'var(--text-muted)' }}
        >
          &larr; Back
        </button>

        <h1 className="mt-4 text-2xl font-bold tracking-tight">Report a tornado</h1>
        <p className="mt-1.5 text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          Two questions. Everything else is worked out from where you are.
        </p>

        <p
          className="mt-4 rounded-lg px-3 py-2.5 text-xs leading-relaxed"
          style={{ background: 'color-mix(in srgb, var(--band-high) 12%, var(--surface-panel))', color: 'var(--band-high)' }}
        >
          If you are in immediate danger, take shelter and call 911 first. Report afterwards.
        </p>

        {/* 1. where */}
        <div className="panel mt-5 p-4">
          <label htmlFor="rp-where" className="block text-sm font-semibold">
            Where are you?
          </label>
          <div className="relative mt-2">
            <input
              id="rp-where"
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPlace(null);
              }}
              placeholder="Town, county or landmark"
              autoComplete="off"
              className="w-full rounded-lg border px-3 py-2.5 text-base"
              style={{ background: 'var(--surface-input)', borderColor: 'var(--border-soft)' }}
            />
            {results.length ? (
              <ul
                className="absolute right-0 left-0 z-20 mt-1 max-h-52 overflow-y-auto rounded-lg border shadow-lg"
                style={{ background: 'var(--surface-panel)', borderColor: 'var(--border-soft)' }}
              >
                {results.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setPlace({ label: placeLabel(p), point: { lat: p.lat, lon: p.lon } });
                        setQuery(placeLabel(p));
                        setResults([]);
                      }}
                      className="block w-full px-3 py-2.5 text-left text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      <span style={{ color: 'var(--text-primary)' }}>{p.name}</span>{' '}
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {[p.admin1, p.country].filter(Boolean).join(', ')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <button
            type="button"
            onClick={useMyLocation}
            className="mt-2 w-full rounded-lg px-3 py-2 text-sm"
            style={{ background: 'var(--surface-raised)', color: 'var(--text-secondary)' }}
          >
            {locating ? 'Finding you…' : 'Use my current location'}
          </button>
          {place ? (
            <p className="mt-2 text-xs" style={{ color: 'var(--band-low)' }}>
              &#10003; {place.label}
            </p>
          ) : null}
        </div>

        {/* 2. photo */}
        <div className="panel mt-3 p-4">
          <label htmlFor="rp-photo" className="block text-sm font-semibold">
            A photograph, if you have one
          </label>
          <input
            id="rp-photo"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => handlePhoto(e.target.files?.[0])}
            className="mt-2 w-full rounded-lg border px-3 py-2.5 text-sm file:mr-3 file:rounded file:border-0 file:px-3 file:py-1.5 file:text-xs"
            style={{ background: 'var(--surface-input)', borderColor: 'var(--border-soft)' }}
          />
          {preview ? (
            <img src={preview} alt="The storm you photographed" className="mt-3 max-h-56 w-full rounded-lg object-cover" />
          ) : null}
          {screeningBusy ? (
            <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }} role="status">
              Checking the photo on your phone…
            </p>
          ) : null}
          {screening ? (
            <div className="mt-2">
              <p className="flex justify-between text-xs">
                <span style={{ color: 'var(--text-secondary)' }}>{screening.label}</span>
                <span className="font-semibold tabular-nums">{(screening.probability * 100).toFixed(0)}%</span>
              </p>
              <div className="mt-1">
                <Meter value={screening.probability} color="var(--band-medium)" />
              </div>
            </div>
          ) : null}
          <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Checked on your own phone. The picture is never uploaded anywhere.
          </p>
        </div>

        {/* 3. words */}
        <div className="panel mt-3 p-4">
          <label htmlFor="rp-note" className="block text-sm font-semibold">
            What did you see?
          </label>
          <textarea
            id="rp-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="Funnel touching down south of the highway, debris in the air."
            className="mt-2 w-full rounded-lg border px-3 py-2.5 text-sm"
            style={{ background: 'var(--surface-input)', borderColor: 'var(--border-soft)' }}
          />
          <input
            value={reporter}
            onChange={(e) => setReporter(e.target.value)}
            placeholder="Your name or call sign, optional"
            className="mt-2 w-full rounded-lg border px-3 py-2.5 text-sm"
            style={{ background: 'var(--surface-input)', borderColor: 'var(--border-soft)' }}
            aria-label="Your name or call sign, optional"
          />
        </div>

        {error ? (
          <p className="mt-3 text-sm" style={{ color: 'var(--band-high)' }} role="alert">
            {error}
          </p>
        ) : null}

        <button
          type="button"
          onClick={() => void submit()}
          disabled={!place || phase === 'sending'}
          className="mt-4 w-full rounded-lg px-4 py-3 text-base font-semibold disabled:opacity-50"
          style={{ background: 'var(--band-high)', color: '#fff' }}
        >
          {phase === 'sending' ? 'Sending…' : 'Send report'}
        </button>
        {!place ? (
          <p className="mt-2 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
            Tell us where you are first.
          </p>
        ) : null}
      </div>
    </div>
  );
}
