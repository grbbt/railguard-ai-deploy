import type { Ps3Job, SubsystemId } from '@/lib/ps3-types';

const SUBSYSTEM_IDS: SubsystemId[] = ['door', 'acv', 'rail', 'shm'];

/** Export only after every saved link has been checked in this refresh. */
export function bundleState(
  savedIds: readonly string[],
  jobs: Record<string, Ps3Job>,
  errors: Record<string, string>,
  checked: Record<string, string>,
  refreshKey: string,
) {
  const ids = [...new Set(savedIds)];
  const pending = ids.filter(id => checked[id] !== refreshKey);
  const unavailable = ids.filter(id => Boolean(errors[id]));
  const running = ids.filter(id => jobs[id]?.status === 'queued' || jobs[id]?.status === 'running');
  const completed = SUBSYSTEM_IDS.map(subsystem => ids.map(id => jobs[id])
    .filter(job => job?.subsystem === subsystem && job.status === 'completed' && job.reports.length > 0)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0])
    .filter((job): job is Ps3Job => Boolean(job));
  return { pending, unavailable, running, completed, canExport: completed.length > 0 && !pending.length && !unavailable.length && !running.length };
}
