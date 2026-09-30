import { useEffect, useState } from 'react';
import type { ReportStatus, StoredReport } from '../lib/storage';
import { auditFor, type AuditEntry } from '../lib/storage';
import { BandChip, Empty, Section, relativeTime } from './ui';

/**
 * The triage inbox: which reports need attention first, and what was done about
 * each one. The ordering is the whole point, so the band is the first thing on
 * every row and the reasoning is one tap away.
 */

const STATUS_LABEL: Record<ReportStatus, string> = {
  new: 'New',
  reviewing: 'Reviewing',
  confirmed: 'Confirmed',
  dismissed: 'Dismissed',
};

const BAND_ORDER: Record<string, number> = { High: 0, 'Needs Review': 1, Medium: 2, Low: 3 };

function ReportRow({
  report,
  now,
  onFocus,
  onStatus,
}: {
  report: StoredReport;
  now: number;
  onFocus: (r: StoredReport) => void;
  onStatus: (id: string, status: ReportStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [thumb, setThumb] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void auditFor(report.id).then(setAudit);
  }, [open, report.id]);

  useEffect(() => {
    if (!report.photo) return;
    const url = URL.createObjectURL(report.photo);
    setThumb(url);
    return () => URL.revokeObjectURL(url);
  }, [report.photo]);

  return (
    <li className="rounded-lg border" style={{ borderColor: 'var(--border-soft)', background: 'var(--surface-raised)' }}>
      <div className="flex items-start gap-3 p-3">
        {thumb ? (
          <img src={thumb} alt="" className="size-12 shrink-0 rounded object-cover" />
        ) : (
          <div
            className="flex size-12 shrink-0 items-center justify-center rounded text-[10px]"
            style={{ background: 'var(--surface-panel)', color: 'var(--text-muted)' }}
          >
            no photo
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <BandChip band={report.band} score={report.priorityScore} />
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {relativeTime(report.createdAt, now)}
            </span>
            {report.replaySlug ? (
              <span
                className="rounded px-1.5 py-0.5 text-[10px] tracking-wide uppercase"
                style={{ background: 'var(--surface-panel)', color: 'var(--text-muted)' }}
              >
                replay
              </span>
            ) : null}
          </div>

          {report.note ? (
            <p className="mt-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
              {report.note}
            </p>
          ) : null}

          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onFocus(report)}
              className="rounded px-2 py-1 text-[11px]"
              style={{ background: 'var(--surface-panel)', color: 'var(--text-secondary)' }}
            >
              Show on map
            </button>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="rounded px-2 py-1 text-[11px]"
              style={{ background: 'var(--surface-panel)', color: 'var(--text-secondary)' }}
              aria-expanded={open}
            >
              {open ? 'Hide detail' : 'Why this rank'}
            </button>
          </div>
        </div>

        <label className="sr-only" htmlFor={`status-${report.id}`}>
          Status for this report
        </label>
        <select
          id={`status-${report.id}`}
          value={report.status}
          onChange={(e) => onStatus(report.id, e.target.value as ReportStatus)}
          className="shrink-0 rounded border px-1.5 py-1 text-[11px]"
          style={{ background: 'var(--surface-input)', borderColor: 'var(--border-soft)', color: 'var(--text-secondary)' }}
        >
          {Object.entries(STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {open ? (
        <div className="border-t px-3 py-3" style={{ borderColor: 'var(--border-soft)' }}>
          <ul className="space-y-1">
            {report.reasons.map((r) => (
              <li key={r} className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                &bull; {r}
              </li>
            ))}
          </ul>

          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            {[
              ['Image evidence', report.imageConfidence === null ? 'no photo' : report.imageConfidence.toFixed(2)],
              ['Warning status', report.warningScore.toFixed(2)],
              ['Weather severity', report.weatherScore.toFixed(2)],
              ['Facility exposure', report.exposureScore.toFixed(2)],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2">
                <dt style={{ color: 'var(--text-muted)' }}>{k}</dt>
                <dd className="tabular-nums" style={{ color: 'var(--text-primary)' }}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>

          {audit.length ? (
            <div className="mt-3">
              <h5 className="text-[10px] tracking-wider uppercase" style={{ color: 'var(--text-muted)' }}>
                Audit trail
              </h5>
              <ol className="mt-1 space-y-0.5">
                {audit.map((a) => (
                  <li key={a.id} className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                    <span className="tabular-nums" style={{ color: 'var(--text-muted)' }}>
                      {new Date(a.at).toLocaleTimeString()}
                    </span>{' '}
                    {a.detail}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export default function ReportsPanel({
  reports,
  now,
  onFocus,
  onStatus,
  onExport,
}: {
  reports: StoredReport[];
  now: number;
  onFocus: (r: StoredReport) => void;
  onStatus: (id: string, status: ReportStatus) => void;
  onExport: () => void;
}) {
  const sorted = [...reports].sort((a, b) => {
    const open = Number(a.status === 'dismissed') - Number(b.status === 'dismissed');
    if (open !== 0) return open;
    const band = (BAND_ORDER[a.band] ?? 9) - (BAND_ORDER[b.band] ?? 9);
    if (band !== 0) return band;
    return b.priorityScore - a.priorityScore;
  });

  return (
    <Section
      title="Report queue"
      aside={
        <button
          type="button"
          onClick={onExport}
          className="rounded px-2 py-1 text-[11px]"
          style={{ background: 'var(--surface-raised)', color: 'var(--text-secondary)' }}
        >
          Export
        </button>
      }
    >
      {sorted.length ? (
        <ul className="space-y-2">
          {sorted.map((r) => (
            <ReportRow key={r.id} report={r} now={now} onFocus={onFocus} onStatus={onStatus} />
          ))}
        </ul>
      ) : (
        <Empty>
          No reports yet. Choose a point on the map and file one to see it ranked against everything
          else in the queue.
        </Empty>
      )}
    </Section>
  );
}
