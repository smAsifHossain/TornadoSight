import { useEffect, useId, useRef, useState } from 'react';
import { placeLabel, searchPlaces, type Place } from '../lib/geocode';
import type { ReplayEntry, ReplayEvent } from '../lib/replay';
import { relativeTime } from './ui';
import type { Mode } from '../App';

/**
 * The always visible control strip: where am I looking, is the data fresh, and
 * am I watching the world as it is or replaying an event that already happened.
 *
 * The distinction between live and replay is deliberately loud. Mistaking
 * archived data for a live situation is the worst mistake this tool could
 * invite, so replay mode restyles the strip rather than showing a quiet label.
 */

function PlaceSearch({ onPick }: { onPick: (p: Place) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const listId = useId();
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setBusy(true);
      searchPlaces(query, controller.signal)
        .then((r) => {
          setResults(r);
          setOpen(true);
        })
        .catch(() => undefined)
        .finally(() => setBusy(false));
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  return (
    <div ref={boxRef} className="relative order-last w-full min-w-0 sm:order-none sm:w-auto sm:flex-1 sm:max-w-72">
      <label htmlFor={listId} className="sr-only">
        Search for a community, county or state
      </label>
      <input
        id={listId}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        placeholder="Search a place"
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${listId}-list`}
        className="w-full rounded-lg border px-3 py-1.5 text-sm"
        style={{
          background: 'var(--surface-input)',
          borderColor: 'var(--border-soft)',
          color: 'var(--text-primary)',
        }}
      />
      {busy ? (
        <span className="absolute top-1.5 right-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          …
        </span>
      ) : null}

      {open && results.length ? (
        <ul
          id={`${listId}-list`}
          role="listbox"
          className="absolute top-full right-0 left-0 z-30 mt-1 max-h-72 overflow-y-auto rounded-lg border shadow-lg scroll-slim"
          style={{ background: 'var(--surface-panel)', borderColor: 'var(--border-soft)' }}
        >
          {results.map((p) => (
            <li key={p.id} role="option" aria-selected={false}>
              <button
                type="button"
                onClick={() => {
                  onPick(p);
                  setOpen(false);
                  setQuery(placeLabel(p));
                }}
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
  );
}

export interface HeaderProps {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  theme: 'dark' | 'light';
  onThemeChange: (t: 'dark' | 'light') => void;
  loading: boolean;
  lastUpdated: Date | null;
  now: number;
  alertCount: number;
  onRefresh: () => void;
  onPickPlace: (p: Place) => void;
  replay: ReplayEvent | null;
  replayAt: Date | null;
  playing: boolean;
  onPlayToggle: () => void;
  onScrub: (d: Date) => void;
  /** Every archived storm the app can replay. */
  catalog: ReplayEntry[];
  onPickEvent: (slug: string) => void;
  tornadoesOnly: boolean;
  onTornadoesOnly: (v: boolean) => void;
  /** Tornado products available before the filter, for the toggle's label. */
  tornadoCount: number;
  /** Replay rate, in simulated minutes per real second. */
  speed: number;
  onSpeed: (s: number) => void;
}

export default function Header(props: HeaderProps) {
  const {
    mode,
    onModeChange,
    theme,
    onThemeChange,
    loading,
    lastUpdated,
    now,
    alertCount,
    onRefresh,
    onPickPlace,
    replay,
    replayAt,
    playing,
    onPlayToggle,
    onScrub,
    catalog,
    onPickEvent,
    tornadoesOnly,
    onTornadoesOnly,
    tornadoCount,
    speed,
    onSpeed,
  } = props;

  const replaying = mode === 'replay';

  return (
    <header
      className="shrink-0 border-b"
      style={{
        background: replaying
          ? 'color-mix(in srgb, var(--band-review) 12%, var(--surface-panel))'
          : 'var(--surface-panel)',
        borderColor: replaying ? 'color-mix(in srgb, var(--band-review) 45%, transparent)' : 'var(--border-soft)',
      }}
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 sm:gap-3 sm:px-4">
        <h1 className="flex items-center gap-2 text-sm font-bold tracking-tight">
          <span
            aria-hidden
            className="grid size-6 place-items-center rounded"
            style={{ background: 'var(--band-high)', color: '#fff' }}
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M3 5h18M5 10h14M8 15h8M11 20h3" strokeLinecap="round" />
            </svg>
          </span>
          {/* The wordmark costs a third of a phone's header width, so on the
              narrowest screens the mark alone carries it. */}
          <span className="hidden min-[400px]:inline">TornadoSight</span>
        </h1>

        <div
          role="group"
          aria-label="Data mode"
          className="flex rounded-lg p-0.5"
          style={{ background: 'var(--surface-raised)' }}
        >
          {(['live', 'replay'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onModeChange(m)}
              aria-pressed={mode === m}
              className="rounded-md px-2.5 py-1 text-xs font-semibold capitalize"
              style={{
                background: mode === m ? (m === 'replay' ? 'var(--band-review)' : 'var(--accent)') : 'transparent',
                color: mode === m ? 'var(--accent-contrast)' : 'var(--text-muted)',
              }}
            >
              {m}
            </button>
          ))}
        </div>

        <PlaceSearch onPick={onPickPlace} />

        <div className="ml-auto flex items-center gap-2">
          {/* During an outbreak the map fills with flood and marine products.
              This strips it back to the one hazard the tool is for. */}
          <button
            type="button"
            onClick={() => onTornadoesOnly(!tornadoesOnly)}
            aria-pressed={tornadoesOnly}
            className="rounded-lg px-2.5 py-1.5 text-[11px] font-semibold"
            style={{
              background: tornadoesOnly ? 'var(--band-high)' : 'var(--surface-raised)',
              color: tornadoesOnly ? '#fff' : 'var(--text-secondary)',
            }}
            title="Show only tornado warnings and watches"
          >
            Tornadoes only
            <span className="ml-1 tabular-nums opacity-80">{tornadoCount}</span>
          </button>

          <span className="hidden text-[11px] tabular-nums sm:inline" style={{ color: 'var(--text-muted)' }}>
            {alertCount} active
          </span>

          {mode === 'live' ? (
            <button
              type="button"
              onClick={onRefresh}
              className="rounded-lg px-2.5 py-1.5 text-[11px]"
              style={{ background: 'var(--surface-raised)', color: 'var(--text-secondary)' }}
            >
              {loading ? 'Refreshing' : lastUpdated ? `Updated ${relativeTime(lastUpdated, now)}` : 'Refresh'}
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}
            className="rounded-lg px-2.5 py-1.5 text-[11px]"
            style={{ background: 'var(--surface-raised)', color: 'var(--text-secondary)' }}
            aria-label={`Switch to the ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
      </div>

      {replaying ? (
        <div
          className="flex flex-wrap items-center gap-3 border-t px-3 py-2 sm:px-4"
          style={{ borderColor: 'color-mix(in srgb, var(--band-review) 35%, transparent)' }}
        >
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider uppercase"
            style={{ background: 'var(--band-review)', color: '#fff' }}
          >
            Replay
          </span>

          {replay && replayAt ? (
            <>
              <button
                type="button"
                onClick={onPlayToggle}
                className="rounded-lg px-3 py-1 text-xs font-semibold"
                style={{ background: 'var(--surface-raised)', color: 'var(--text-primary)' }}
              >
                {playing ? 'Pause' : 'Play'}
              </button>

              {/* Two hours of storm is a long watch at life speed. */}
              <div className="flex rounded-lg p-0.5" style={{ background: 'var(--surface-raised)' }}>
                {[2, 4, 10].map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => onSpeed(s)}
                    aria-pressed={speed === s}
                    className="rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums"
                    style={{
                      background: speed === s ? 'var(--band-review)' : 'transparent',
                      color: speed === s ? '#fff' : 'var(--text-muted)',
                    }}
                  >
                    {s}x
                  </button>
                ))}
              </div>

              <label className="flex min-w-40 flex-1 items-center gap-2 text-[11px]">
                <span className="sr-only">Scrub through the event</span>
                <input
                  type="range"
                  min={replay.window.start.getTime()}
                  max={replay.window.end.getTime()}
                  step={60_000}
                  value={replayAt.getTime()}
                  onChange={(e) => onScrub(new Date(Number(e.target.value)))}
                  className="w-full accent-[var(--band-review)]"
                />
              </label>

              <time
                dateTime={replayAt.toISOString()}
                className="text-[11px] tabular-nums"
                style={{ color: 'var(--text-secondary)' }}
              >
                {replayAt.toUTCString().slice(5, 22)} UTC
              </time>

              {/* Pick a different storm. The library is rebuilt from the
                  archive, so it grows as real weather happens. */}
              <label className="flex items-center gap-1.5 text-[11px]">
                <span className="sr-only">Choose which archived storm to replay</span>
                <select
                  value={replay.slug}
                  onChange={(e) => onPickEvent(e.target.value)}
                  className="max-w-56 rounded-lg border px-2 py-1 text-[11px]"
                  style={{
                    background: 'var(--surface-input)',
                    borderColor: 'var(--border-soft)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {catalog.map((c) => (
                    <option key={c.slug} value={c.slug}>
                      {c.observed ? '● ' : ''}
                      {c.title} ({c.products} products)
                    </option>
                  ))}
                </select>
              </label>

              <p className="w-full text-[11px] sm:w-auto" style={{ color: 'var(--text-muted)' }}>
                {replay.summary || replay.title} Genuine archived National Weather Service products,
                nothing simulated.
              </p>
            </>
          ) : (
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Loading the archived event…
            </span>
          )}
        </div>
      ) : null}
    </header>
  );
}
