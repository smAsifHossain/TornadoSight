/**
 * Local persistence.
 *
 * Storage is one of the four required elements of the challenge, and it is also
 * where the responsible handling argument lives. Reports, including the photo,
 * are held in IndexedDB on the responder's own device. Nothing is uploaded to
 * any server, because there is no server: the image classifier runs in the
 * browser, so a citizen's photograph never leaves the machine it was dropped
 * onto.
 *
 * What is stored is deliberately small and legible: the report, the scores it
 * produced, and an append only trail of what the operator did with it. That
 * trail is what makes the tool defensible after an event, when someone asks
 * why a particular report was or was not acted on.
 */

import type { PriorityBand } from './scoring';

const DB_NAME = 'tornadosight';
const DB_VERSION = 1;
const REPORTS = 'reports';
const AUDIT = 'audit';

export type ReportStatus = 'new' | 'reviewing' | 'confirmed' | 'dismissed';

export interface StoredReport {
  id: string;
  createdAt: number;
  lat: number;
  lon: number;
  /** Original photo as a blob, or null for a report filed without one. */
  photo: Blob | null;
  photoName: string | null;
  note: string;
  reporter: string;
  imageConfidence: number | null;
  imageUncertain: boolean;
  priorityScore: number;
  band: PriorityBand;
  reasons: string[];
  warningScore: number;
  weatherScore: number;
  exposureScore: number;
  status: ReportStatus;
  /** Set when the report came from Replay mode, so it is never mistaken for live. */
  replaySlug: string | null;
}

export interface AuditEntry {
  id?: number;
  reportId: string;
  at: number;
  action: string;
  detail: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(REPORTS)) {
        const store = db.createObjectStore(REPORTS, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
        store.createIndex('band', 'band');
      }
      if (!db.objectStoreNames.contains(AUDIT)) {
        const store = db.createObjectStore(AUDIT, { keyPath: 'id', autoIncrement: true });
        store.createIndex('reportId', 'reportId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB could not be opened'));
  });
  return dbPromise;
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error(`${store} operation failed`));
      }),
  );
}

/**
 * Every write that changes a report also writes an audit line. Storage is only
 * useful after the fact if it records the decision, not just the data.
 */
export async function saveReport(report: StoredReport): Promise<void> {
  await run(REPORTS, 'readwrite', (s) => s.put(report));
  await appendAudit({
    reportId: report.id,
    at: Date.now(),
    action: 'filed',
    detail: `Scored ${report.band} at ${(report.priorityScore * 100).toFixed(0)} out of 100`,
  });
}

export async function listReports(): Promise<StoredReport[]> {
  const all = await run<StoredReport[]>(REPORTS, 'readonly', (s) => s.getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function setReportStatus(id: string, status: ReportStatus, who: string): Promise<void> {
  const existing = await run<StoredReport | undefined>(REPORTS, 'readonly', (s) => s.get(id));
  if (!existing) return;
  await run(REPORTS, 'readwrite', (s) => s.put({ ...existing, status }));
  await appendAudit({
    reportId: id,
    at: Date.now(),
    action: status,
    detail: who ? `Marked ${status} by ${who}` : `Marked ${status}`,
  });
}

export async function deleteReport(id: string): Promise<void> {
  await run(REPORTS, 'readwrite', (s) => s.delete(id));
  await appendAudit({ reportId: id, at: Date.now(), action: 'deleted', detail: 'Report removed by operator' });
}

export async function appendAudit(entry: AuditEntry): Promise<void> {
  await run(AUDIT, 'readwrite', (s) => s.add(entry));
}

export async function auditFor(reportId: string): Promise<AuditEntry[]> {
  const all = await run<AuditEntry[]>(AUDIT, 'readonly', (s) => s.getAll());
  return all.filter((e) => e.reportId === reportId).sort((a, b) => a.at - b.at);
}

export async function allAudit(): Promise<AuditEntry[]> {
  const all = await run<AuditEntry[]>(AUDIT, 'readonly', (s) => s.getAll());
  return all.sort((a, b) => b.at - a.at);
}

/**
 * Export everything as JSON so a shift can be handed over, or an incident
 * reconstructed, without the data being locked inside one browser. Photos are
 * left out deliberately: the export is meant to be shareable, and the images
 * may show people or property.
 */
export async function exportJson(): Promise<string> {
  const [reports, audit] = await Promise.all([listReports(), allAudit()]);
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      note: 'Photographs are excluded from exports so that shareable records carry no imagery of people or property.',
      reports: reports.map(({ photo: _photo, ...rest }) => rest),
      audit,
    },
    null,
    2,
  );
}

export async function clearAll(): Promise<void> {
  await run(REPORTS, 'readwrite', (s) => s.clear());
  await run(AUDIT, 'readwrite', (s) => s.clear());
}
