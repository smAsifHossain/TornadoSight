import type { Situation } from '../lib/situation';
import { compass } from '../lib/openmeteo';
import { BandChip, Empty, Meter, Section, Stat, formatCoord, relativeTime } from './ui';
import { BAND_STYLE } from './ui';
import type { Alert } from '../lib/nws';

/**
 * What is happening at the selected place, and why the system thinks it
 * matters. Every number on this panel can be traced back to the measurement
 * that produced it, because a responder who cannot see the reasoning has no
 * grounds to trust or overrule it.
 */

const TREND_COPY: Record<Situation['trend']['state'], { label: string; color: string }> = {
  escalating: { label: 'Escalating', color: 'var(--band-high)' },
  steady: { label: 'Holding steady', color: 'var(--band-medium)' },
  easing: { label: 'Easing', color: 'var(--band-low)' },
  unknown: { label: 'Not enough history', color: 'var(--text-muted)' },
};

function AlertCard({ alert, now }: { alert: Alert; now: number }) {
  const expiry = alert.ends ?? alert.expires;
  const threats = [
    alert.tornadoDetection ? alert.tornadoDetection.toLowerCase() : null,
    alert.tornadoDamageThreat ? `${alert.tornadoDamageThreat.toLowerCase()} damage threat` : null,
    alert.maxWindGustMph ? `gusts to ${alert.maxWindGustMph} mph` : null,
    alert.maxHailInches ? `hail to ${alert.maxHailInches} in` : null,
  ].filter(Boolean) as string[];

  const urgent = alert.event === 'Tornado Warning';

  return (
    <article
      className="rounded-lg border p-3"
      style={{
        borderColor: urgent ? 'color-mix(in srgb, var(--band-high) 55%, transparent)' : 'var(--border-soft)',
        background: urgent ? 'color-mix(in srgb, var(--band-high) 8%, var(--surface-raised))' : 'var(--surface-raised)',
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-semibold" style={{ color: urgent ? 'var(--band-high)' : 'var(--text-primary)' }}>
          {alert.event}
        </h4>
        {expiry ? (
          <span className="shrink-0 text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
            expires {relativeTime(expiry, now)}
          </span>
        ) : null}
      </div>

      <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
        {alert.areaDesc}
      </p>

      {alert.motion ? (
        <p className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
          Tracking{' '}
          <strong style={{ color: 'var(--text-primary)' }}>
            {compass(alert.motion.heading)} at {Math.round(alert.motion.speedMph)} mph
          </strong>
          , radar fix {relativeTime(alert.motion.time, now)}
        </p>
      ) : null}

      {threats.length ? (
        <ul className="mt-2 flex flex-wrap gap-1">
          {threats.map((t) => (
            <li
              key={t}
              className="rounded px-1.5 py-0.5 text-[10px] tracking-wide uppercase"
              style={{ background: 'var(--surface-panel)', color: 'var(--text-secondary)' }}
            >
              {t}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {alert.senderName}
      </p>
    </article>
  );
}

export default function SituationPanel({
  situation,
  now,
  onFocusFacility,
}: {
  situation: Situation | null;
  now: number;
  onFocusFacility?: (id: string) => void;
}) {
  if (!situation) {
    return (
      <div className="p-4">
        <Empty>Choose a place on the map to see what is active there.</Empty>
      </div>
    );
  }

  const { local, weather, priority, weatherScore, exposure, trend, point } = situation;
  const band = BAND_STYLE[priority.band];
  const inPath = exposure.facilities.filter((f) => f.minutesToImpact !== null);

  return (
    <div>
      <Section title="Selected location">
        <p className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
          {formatCoord(point.lat, point.lon)}
        </p>
      </Section>

      <Section title="Responder priority">
        <div className="flex items-center gap-3">
          <div
            className="flex size-16 shrink-0 flex-col items-center justify-center rounded-xl"
            style={{ background: `color-mix(in srgb, ${band.color} 14%, transparent)` }}
          >
            <span className="text-2xl font-bold tabular-nums" style={{ color: band.color }}>
              {Math.round(priority.score * 100)}
            </span>
            <span className="text-[9px] tracking-wider uppercase" style={{ color: 'var(--text-muted)' }}>
              of 100
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <BandChip band={priority.band} />
            <div className="mt-2">
              <Meter value={priority.score} color={band.color} />
            </div>
          </div>
        </div>

        {priority.override ? (
          <p
            className="mt-3 rounded-lg border px-3 py-2 text-xs"
            style={{
              borderColor: 'color-mix(in srgb, var(--band-high) 45%, transparent)',
              color: 'var(--band-high)',
            }}
          >
            {priority.override}
          </p>
        ) : null}

        {priority.reasons.length ? (
          <ul className="mt-3 space-y-1.5">
            {priority.reasons.map((r) => (
              <li key={r} className="flex gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <span aria-hidden style={{ color: band.color }}>
                  &bull;
                </span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <details className="mt-3 group">
          <summary
            className="cursor-pointer list-none text-[11px] font-medium tracking-wide uppercase select-none"
            style={{ color: 'var(--text-muted)' }}
          >
            How this number was reached
          </summary>
          <table className="mt-2 w-full text-xs">
            <caption className="sr-only">Weighted contributions to the responder priority score</caption>
            <thead>
              <tr style={{ color: 'var(--text-muted)' }}>
                <th scope="col" className="pb-1 text-left font-normal">
                  Signal
                </th>
                <th scope="col" className="pb-1 text-right font-normal">
                  Weight
                </th>
                <th scope="col" className="pb-1 text-right font-normal">
                  Score
                </th>
                <th scope="col" className="pb-1 text-right font-normal">
                  Adds
                </th>
              </tr>
            </thead>
            <tbody style={{ color: 'var(--text-secondary)' }}>
              {priority.contributions.map((c) => (
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
          <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Weights are shared out across the signals that are actually available, so a report filed
            without a photograph is not treated as safer than one with a photograph.
          </p>
        </details>
      </Section>

      <Section
        title="Active here"
        aside={
          <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
            {local.length} alert{local.length === 1 ? '' : 's'}
          </span>
        }
      >
        {local.length ? (
          <div className="space-y-2">
            {local.map((a) => (
              <AlertCard key={a.id} alert={a} now={now} />
            ))}
          </div>
        ) : (
          <Empty>No National Weather Service alert covers this point right now.</Empty>
        )}
      </Section>

      {!inPath.length ? (
        /* This section used to disappear when empty, which reads as broken
           rather than as "nothing is in the path". Say which it is. */
        <Section title="In the projected path">
          <Empty>
            {!situation.tracked
              ? 'No storm near this point is reporting a motion vector, so there is no path to project yet.'
              : exposure.facilities.length
                ? 'A storm is being tracked, but no critical facility falls inside its projected corridor.'
                : 'No infrastructure data has loaded for this area, so nothing can be placed in the path.'}
          </Empty>
        </Section>
      ) : (
        <Section
          title="In the projected path"
          aside={
            <span className="text-[11px] tabular-nums" style={{ color: 'var(--band-high)' }}>
              {inPath.length} exposed
            </span>
          }
        >
          <ul className="space-y-1.5">
            {inPath.slice(0, 8).map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => onFocusFacility?.(f.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors"
                  style={{ background: 'var(--surface-raised)' }}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium" style={{ color: 'var(--text-primary)' }}>
                      {f.name}
                    </span>
                    <span style={{ color: 'var(--text-muted)' }}>{f.kind.replace(/_/g, ' ')}</span>
                  </span>
                  <span
                    className="shrink-0 font-semibold tabular-nums"
                    style={{ color: f.minutesToImpact! <= 15 ? 'var(--band-high)' : 'var(--band-medium)' }}
                  >
                    {Math.round(f.minutesToImpact!)} min
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Timings project the storm forward along the motion vector the National Weather Service
            published. They assume it holds its track and speed, which storms do not always do.
          </p>
        </Section>
      )}

      <Section
        title="Weather"
        aside={
          weather ? (
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {weather.cached ? 'cached' : relativeTime(weather.observedAt, now)}
            </span>
          ) : null
        }
      >
        {weather ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat label="CAPE" value={weather.cape != null ? `${Math.round(weather.cape)}` : '—'} hint="J/kg" />
              <Stat
                label="Lifted index"
                value={weather.liftedIndex != null ? weather.liftedIndex.toFixed(1) : '—'}
                hint="lower is less stable"
              />
              <Stat
                label="Wind gust"
                value={weather.windGustMph != null ? `${Math.round(weather.windGustMph)}` : '—'}
                hint="mph"
              />
              <Stat
                label="Wind"
                value={
                  weather.windSpeedMph != null
                    ? `${Math.round(weather.windSpeedMph)}${weather.windDirectionDeg != null ? ` ${compass(weather.windDirectionDeg)}` : ''}`
                    : '—'
                }
                hint="mph"
              />
              <Stat
                label="Dew point"
                value={weather.dewPointF != null ? `${Math.round(weather.dewPointF)}°` : '—'}
                hint="F"
              />
              <Stat
                label="Pressure"
                value={weather.pressureMslHpa != null ? Math.round(weather.pressureMslHpa) : '—'}
                hint="hPa at sea level"
              />
            </div>

            <div className="mt-3">
              <div className="mb-1 flex items-baseline justify-between text-xs">
                <span style={{ color: 'var(--text-secondary)' }}>Weather severity</span>
                <span className="font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>
                  {weatherScore.score.toFixed(2)}
                </span>
              </div>
              <Meter value={weatherScore.score} color="var(--band-medium)" />
            </div>

            <details className="mt-2">
              <summary
                className="cursor-pointer list-none text-[11px] tracking-wide uppercase select-none"
                style={{ color: 'var(--text-muted)' }}
              >
                Contributing terms
              </summary>
              <ul className="mt-2 space-y-1">
                {weatherScore.terms.map((t) => (
                  <li key={t.label} className="flex items-center justify-between gap-2 text-[11px]">
                    <span style={{ color: 'var(--text-secondary)' }}>{t.label}</span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums" style={{ color: 'var(--text-muted)' }}>
                        {t.detail}
                      </span>
                      <span className="w-14">
                        <Meter value={t.value} color="var(--accent)" />
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              {weatherScore.missing.length ? (
                <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Not reported here: {weatherScore.missing.join(', ')}. The remaining terms were
                  reweighted to compensate.
                </p>
              ) : null}
            </details>
          </>
        ) : (
          <Empty>Weather for this point has not loaded.</Empty>
        )}
      </Section>

      <Section
        title="Trend"
        aside={
          trend.products ? (
            <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
              {trend.products} products
            </span>
          ) : null
        }
      >
        <p className="text-sm font-semibold" style={{ color: TREND_COPY[trend.state].color }}>
          {TREND_COPY[trend.state].label}
        </p>

        {trend.detail ? (
          <p className="mt-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
            {trend.detail}
          </p>
        ) : (
          <p className="mt-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
            No tornado or severe thunderstorm warning is in effect near this point, so there is no
            storm to follow. A trend appears once a storm has been warned more than once.
          </p>
        )}

        <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Judged by following one storm through its own updates, matched on the tracking number the
          National Weather Service puts in every product it issues.
        </p>
      </Section>
    </div>
  );
}
