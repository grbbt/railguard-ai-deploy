'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Ps3Job, Ps3Status, RecentJob, SubsystemId } from '@/lib/ps3-types';
import { forgetJob, ps3Request, rememberJob, useRecentJobs } from '@/components/ps3/shared';
import { bundleState } from '@/components/ps3/job-state';
import type { ExportChoices } from './export-selection';
import { catalogIsCurrent, deriveWorkspaceHistory, workspaceWatchIds } from './workspace-state';

export type LibraryJob = RecentJob & {
  status: Ps3Job['status']; source: Ps3Job['source']; first_file: string | null;
  file_count: number; model_name?: string; progress: Ps3Job['progress'];
};

/** One selection and one job store power every view of the fleet workspace. */
export function useWorkspace() {
  const [subsystem, setSubsystem] = useState<SubsystemId>('door');
  const [status, setStatus] = useState<Ps3Status | null>(null);
  const [statusError, setStatusError] = useState('');
  const [library, setLibrary] = useState<LibraryJob[]>([]);
  const [libraryTotal, setLibraryTotal] = useState(0);
  const [libraryError, setLibraryError] = useState('');
  const [libraryChecked, setLibraryChecked] = useState<number | null>(null);
  const [latestCompletedIds, setLatestCompletedIds] = useState<string[]>([]);
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [jobRevision, setJobRevision] = useState(0);
  const [jobs, setJobs] = useState<Record<string, Ps3Job>>({});
  const [jobErrors, setJobErrors] = useState<Record<string, string>>({});
  const [jobChecks, setJobChecks] = useState<Record<string, string>>({});
  const [selectedJobs, setSelectedJobs] = useState<Partial<Record<SubsystemId, string>>>({});
  const [selectedFiles, setSelectedFiles] = useState<Record<string, string>>({});
  const [exportChoices, setExportChoices] = useState<ExportChoices | null>(null);
  const [transferring, setTransferring] = useState(false);
  const recent = useRecentJobs();
  const history = deriveWorkspaceHistory({ recent, library, jobs, selectedJobs });
  const activeId = selectedJobs[subsystem] ?? history.find(item => item.subsystem === subsystem)?.id ?? null;
  const activeJob = activeId && jobs[activeId]?.subsystem === subsystem ? jobs[activeId] : null;
  const report = activeJob?.status === 'completed'
    ? activeJob.reports.find(item => item.file_id === selectedFiles[activeJob.id]) ?? activeJob.reports[0] ?? null : null;
  const watchedIds = workspaceWatchIds({ history, catalogIds: library.map(item => item.id), catalogResolved: libraryChecked !== null || Boolean(libraryError), latestCompletedIds, activeIds, activeId,
    selectedIds: [...Object.values(selectedJobs).filter((id): id is string => Boolean(id)),
      ...Object.values(exportChoices ?? {}).map(choice => choice.jobId)] });
  const watchKey = JSON.stringify(watchedIds);
  const refreshKey = JSON.stringify([watchKey, jobRevision]);

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function update() {
      try {
        const result = await ps3Request<Ps3Status>('/api/ps3/status', { signal: abort.signal }, 12000);
        if (!abort.signal.aborted) { setStatus(result); setStatusError(''); }
      } catch (cause) {
        if (!abort.signal.aborted) setStatusError(cause instanceof Error ? cause.message : 'The local service is unavailable.');
      } finally { if (!abort.signal.aborted) timer = setTimeout(update, 15000); }
    }
    update();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [revision]);

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function update() {
      try {
        const result = await ps3Request<{ jobs: LibraryJob[]; total: number; latest_completed: LibraryJob[]; active_jobs: LibraryJob[] }>('/api/ps3/jobs?limit=40', { signal: abort.signal }, 12000);
        if (!abort.signal.aborted) {
          setLibrary([...new Map([...result.jobs, ...result.latest_completed, ...result.active_jobs].map(item => [item.id, item])).values()]);
          setLatestCompletedIds(result.latest_completed.map(item => item.id)); setActiveIds(result.active_jobs.map(item => item.id));
          setLibraryTotal(result.total); setLibraryError(''); setLibraryChecked(revision);
        }
      } catch (cause) {
        if (!abort.signal.aborted) setLibraryError(cause instanceof Error ? cause.message : 'The recording library is unavailable.');
      } finally { if (!abort.signal.aborted) timer = setTimeout(update, 15000); }
    }
    update();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [revision]);

  useEffect(() => {
    const ids: string[] = JSON.parse(watchKey);
    const abort = new AbortController();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    async function update(id: string) {
      try {
        const job = await ps3Request<Ps3Job>(`/api/ps3/jobs/${encodeURIComponent(id)}`, { signal: abort.signal }, 12000);
        if (abort.signal.aborted) return;
        if (job.id !== id) throw new Error('Saved job identity mismatch. Retry this entry.');
        setJobs(previous => ({ ...previous, [id]: job }));
        setJobErrors(previous => previous[id] ? { ...previous, [id]: '' } : previous);
        setJobChecks(previous => ({ ...previous, [id]: refreshKey }));
        if (job.status === 'queued' || job.status === 'running') timers.set(id, setTimeout(() => update(id), 1800));
      } catch (cause) {
        if (!abort.signal.aborted) {
          setJobErrors(previous => ({ ...previous, [id]: cause instanceof Error ? cause.message : 'This run could not be loaded.' }));
          setJobChecks(previous => ({ ...previous, [id]: refreshKey }));
          timers.set(id, setTimeout(() => update(id), 5000));
        }
      }
    }
    ids.forEach(id => { update(id); });
    return () => { abort.abort(); timers.forEach(clearTimeout); };
  }, [watchKey, refreshKey]);

  const selectJob = useCallback((id: string, target: SubsystemId) => {
    setSelectedJobs(previous => ({ ...previous, [target]: id })); setSubsystem(target);
  }, []);
  const onStarted = useCallback((id: string, target: SubsystemId) => {
    rememberJob(id, target); selectJob(id, target); setRevision(value => value + 1);
  }, [selectJob]);
  function selectFile(file: string) {
    if (activeJob) setSelectedFiles(previous => ({ ...previous, [activeJob.id]: file }));
  }
  function forgetUnavailable(id: string) {
    if (!jobErrors[id] || !forgetJob(id)) return false;
    setSelectedJobs(previous => Object.fromEntries(Object.entries(previous).filter(([, value]) => value !== id)));
    setJobs(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id)));
    setJobErrors(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id)));
    setJobChecks(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id)));
    return true;
  }
  const refresh = () => { setRevision(value => value + 1); setJobRevision(value => value + 1); };
  return { subsystem, setSubsystem, status, statusError, library, libraryTotal, libraryError, jobs, jobErrors,
    history, activeId, activeJob, report, selectJob, selectFile, onStarted, refresh, forgetUnavailable,
    libraryReady: catalogIsCurrent(libraryChecked, revision, libraryError),
    exportChoices, setExportChoices,
    exportJobReady: (id: string) => jobChecks[id] === refreshKey && !jobErrors[id] && jobs[id]?.status === 'completed',
    transferring, setTransferring, currentStatus: status?.subsystems.find(item => item.id === subsystem),
    busy: activeJob?.status === 'queued' || activeJob?.status === 'running',
    bundle: bundleState(watchedIds, jobs, jobErrors, jobChecks, refreshKey) };
}

export type WorkspaceData = ReturnType<typeof useWorkspace>;
