import type { Ps3Job, RecentJob, SubsystemId } from '@/lib/ps3-types';
import type { LibraryJob } from './useWorkspace';

type HistoryInput = {
  recent: readonly RecentJob[];
  library: readonly LibraryJob[];
  jobs: Readonly<Record<string, Ps3Job>>;
  selectedJobs: Readonly<Partial<Record<SubsystemId, string>>>;
};

/** Keep summary history separate from the much larger retained report payloads. */
export function deriveWorkspaceHistory({ recent, library, jobs, selectedJobs }: HistoryInput): RecentJob[] {
  const rows = new Map<string, RecentJob>();
  for (const row of recent) {
    if (!rows.has(row.id)) rows.set(row.id, { id: row.id, subsystem: row.subsystem, created_at: row.created_at });
  }
  // The catalog's server timestamp takes priority over the browser's saved-link date.
  for (const row of library) rows.set(row.id, { id: row.id, subsystem: row.subsystem, created_at: row.created_at });
  for (const id of Object.values(selectedJobs)) {
    if (!id || rows.has(id)) continue;
    const job = jobs[id];
    if (job) rows.set(id, { id: job.id, subsystem: job.subsystem, created_at: job.created_at });
  }
  return [...rows.values()].map((row, index) => {
    const timestamp = Date.parse(row.created_at);
    return { row, index, timestamp: Number.isFinite(timestamp) ? timestamp : -Infinity };
  }).sort((a, b) => a.timestamp === b.timestamp ? a.index - b.index : b.timestamp - a.timestamp).map(item => item.row);
}

type WatchInput = {
  history: readonly RecentJob[];
  catalogIds: readonly string[];
  latestCompletedIds: readonly string[];
  activeIds: readonly string[];
  activeId: string | null;
  selectedIds: readonly string[];
  catalogResolved?: boolean;
};

/** Resolve explicit selections and export candidates, not every historical report. */
export function workspaceWatchIds({ history, catalogIds, latestCompletedIds, activeIds, activeId, selectedIds, catalogResolved = true }: WatchInput): string[] {
  const catalog = new Set(catalogIds);
  // An empty catalog during startup does not establish that every saved link is
  // unknown. Wait for its first success or failure before resolving that fallback.
  const unknownLinks = catalogResolved ? history.filter(row => !catalog.has(row.id)).map(row => row.id) : [];
  return [...new Set([
    ...latestCompletedIds,
    ...activeIds,
    ...selectedIds,
    ...(activeId ? [activeId] : []),
    ...unknownLinks,
  ].filter(id => id.length > 0))].sort();
}

/** A retained catalog from before the current refresh cannot authorize export. */
export function catalogIsCurrent(checkedRevision: number | null, currentRevision: number, error: string): boolean {
  return checkedRevision !== null && checkedRevision === currentRevision && !error;
}
