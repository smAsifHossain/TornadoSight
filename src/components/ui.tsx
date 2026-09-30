import type { ReactNode } from 'react';
import type { PriorityBand } from '../lib/scoring';

/** Small shared pieces, kept in one place so the panels stay readable. */

export const BAND_STYLE: Record<PriorityBand, { color: string; label: string }> = {
  High: { color: 'var(--band-high)', label: 'High priority' },
  Medium: { color: 'var(--band-medium)', label: 'Medium priority' },
  Low: { color: 'var(--band-low)', label: 'Low priority' },
  'Needs Review': { color: 'var(--band-review)', label: 'Needs review' },
};

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="border-b px-4 py-4" style={{ borderColor: 'var(--border-soft)' }}>
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <h3
          className="text-[11px] font-semibold tracking-[0.14em] uppercase"
          style={{ color: 'var(--text-muted)' }}
        >
          {title}
        </h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function Meter({ value, color = 'var(--accent)' }: { value: number; color?: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full"
      style={{ background: 'var(--surface-raised)' }}
      role="presentation"
    >
      <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg px-3 py-2" style={{ background: 'var(--surface-raised)' }}>
      <div className="text-[10px] tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
        {label}
      </div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>
        {value}
      </div>
      {hint ? (
        <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export function BandChip({ band, score }: { band: PriorityBand; score?: number }) {
  const style = BAND_STYLE[band];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wide uppercase"
      style={{ background: `color-mix(in srgb, ${style.color} 18%, transparent)`, color: style.color }}
    >
      <span className="size-1.5 rounded-full" style={{ background: style.color }} aria-hidden />
      {band}
      {score !== undefined ? <span className="tabular-nums opacity-80">{Math.round(score * 100)}</span> : null}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg px-3 py-6 text-center text-sm" style={{ background: 'var(--surface-raised)', color: 'var(--text-muted)' }}>
      {children}
    </p>
  );
}

/** "in 12 minutes", "22 minutes ago". */
export function relativeTime(target: Date | number, now = Date.now()): string {
  const ms = (typeof target === 'number' ? target : target.getTime()) - now;
  const mins = Math.round(ms / 60000);
  const abs = Math.abs(mins);
  if (abs < 1) return 'just now';
  if (abs < 60) return ms > 0 ? `in ${abs} min` : `${abs} min ago`;
  const hours = Math.round(abs / 60);
  if (hours < 24) return ms > 0 ? `in ${hours} h` : `${hours} h ago`;
  const days = Math.round(hours / 24);
  return ms > 0 ? `in ${days} d` : `${days} d ago`;
}

export function formatCoord(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(3)}° ${ns}, ${Math.abs(lon).toFixed(3)}° ${ew}`;
}
