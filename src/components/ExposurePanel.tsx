import type { Situation } from '../lib/situation';
import type { FacilitySource } from '../lib/facilities';
import { facilityLabel } from '../lib/facilities';
import { FACILITY_COLOR } from './MapView';
import { Empty, Meter, Section } from './ui';
import type { FacilityKind } from '../lib/scoring';

/**
 * What is exposed, and how soon.
 *
 * Sorted by time to impact rather than by distance, because a hospital eight
 * miles ahead of a storm matters more than a school two miles behind it, and
 * a list sorted by distance buries exactly that.
 */

const SOURCE_COPY: Record<FacilitySource, string> = {
  baked: 'Prepared from OpenStreetMap and served with the app, so it loads instantly and works offline.',
  live: 'Fetched live from OpenStreetMap for this area, because it was not prepared in advance.',
  none: 'No infrastructure data is available for this area. Exposure is not being scored here, which is not the same as there being nothing at risk.',
};

export default function ExposurePanel({
  situation,
  source,
}: {
  situation: Situation | null;
  source: FacilitySource;
}) {
  if (!situation) {
    return (
      <div className="p-4">
        <Empty>Choose a place on the map to see what is exposed.</Empty>
      </div>
    );
  }

  const { exposure, tracked } = situation;
  const inPath = exposure.facilities.filter((f) => f.minutesToImpact !== null);

  const byKind = new Map<FacilityKind, number>();
  for (const f of exposure.facilities) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
  const kinds = [...byKind.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <div>
      <Section
        title="Exposure score"
        aside={
          <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
            {exposure.weightedPoints.toFixed(1)} weighted points
          </span>
        }
      >
        <div className="flex items-baseline justify-between">
          <span className="text-2xl font-bold tabular-nums">{exposure.score.toFixed(2)}</span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {exposure.facilities.length} facilities in range
          </span>
        </div>
        <div className="mt-2">
          <Meter value={exposure.score} color="var(--band-medium)" />
        </div>
        <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Facilities are weighted by type and by a smooth distance decay, then combined through a
          saturating curve. The curve keeps separating a dense downtown from a single clinic instead
          of pinning both at the maximum.
        </p>
      </Section>

      {tracked?.motion ? (
        <Section title="Projected path">
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            Projected from the position radar last reported, along the motion vector published with the{' '}
            {tracked.event.toLowerCase()}, for the next 45 minutes.
          </p>
          <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
            A storm that turns, slows or dissipates will not follow this line. Treat it as the
            current best guess, not a forecast.
          </p>
        </Section>
      ) : null}

      <Section
        title={inPath.length ? 'In the path, soonest first' : 'Nearest facilities'}
        aside={
          <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
            {inPath.length ? `${inPath.length} exposed` : null}
          </span>
        }
      >
        {exposure.facilities.length ? (
          <ul className="space-y-1">
            {exposure.facilities.slice(0, 40).map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2"
                style={{ background: 'var(--surface-raised)' }}
              >
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: FACILITY_COLOR[f.kind] ?? FACILITY_COLOR.other }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                    {f.name}
                  </span>
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {facilityLabel(f.kind)} &middot; {f.distanceMiles.toFixed(1)} mi
                  </span>
                </span>
                {f.minutesToImpact !== null ? (
                  <span
                    className="shrink-0 text-xs font-bold tabular-nums"
                    style={{ color: f.minutesToImpact <= 15 ? 'var(--band-high)' : 'var(--band-medium)' }}
                  >
                    {Math.round(f.minutesToImpact)} min
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Nothing within range of this point.</Empty>
        )}
      </Section>

      {kinds.length ? (
        <Section title="By type">
          <ul className="grid grid-cols-2 gap-1.5">
            {kinds.map(([kind, count]) => (
              <li key={kind} className="flex items-center gap-2 text-[11px]">
                <span
                  aria-hidden
                  className="size-2 rounded-full"
                  style={{ background: FACILITY_COLOR[kind] ?? FACILITY_COLOR.other }}
                />
                <span className="flex-1 truncate" style={{ color: 'var(--text-secondary)' }}>
                  {facilityLabel(kind)}
                </span>
                <span className="tabular-nums" style={{ color: 'var(--text-primary)' }}>
                  {count}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Where this data comes from">
        <p className="text-[11px]" style={{ color: source === 'none' ? 'var(--band-medium)' : 'var(--text-muted)' }}>
          {SOURCE_COPY[source]}
        </p>
      </Section>
    </div>
  );
}
