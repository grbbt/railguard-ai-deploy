'use client';

import { useMemo, useSyncExternalStore } from 'react';
import { Activity, DoorClosed, Fan, Waves } from 'lucide-react';
import type { RecentJob, SubsystemId } from '@/lib/ps3-types';
import { errorMessage } from './request-error';

export const SUBSYSTEMS = [
  { id: 'door', title: 'Door', subtitle: 'Action segmentation', icon: DoorClosed, input: 'Continuous door CSV', task: 'Find opening and closing actions, then classify each segment.', output: 'start_time · end_time · prediction' },
  { id: 'acv', title: 'ACV', subtitle: 'Car-level localisation', icon: Fan, input: 'One or more ACV Excel workbooks', task: 'Rank the cars in each recorded case for refrigerant leakage.', output: 'file_id · ranked_cars' },
  { id: 'rail', title: 'Rail corrugation', subtitle: 'Recording classification', icon: Waves, input: 'One or more vibration CSVs', task: 'Classify recordings as Normal, Side I or Side II.', output: 'file_id · prediction' },
  { id: 'shm', title: 'Structural health', subtitle: 'Fatigue damage regression', icon: Activity, input: 'One or more headerless CSVs', task: 'Estimate cumulative fatigue damage from recorded stress.', output: 'file_id · prediction' },
] as const;

export function displayValue(value: number | string | null | undefined, digits = 5) {
  if (value === null || value === undefined) return 'Not available';
  if (typeof value === 'string') return value;
  if (Number.isFinite(value) && value !== 0 && Math.abs(value) < 0.0001) return value.toExponential(3);
  return Number.isFinite(value) ? value.toLocaleString('en-GB', { maximumFractionDigits: digits }) : 'Not available';
}

export function jobTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(+date) ? value : date.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export async function ps3Request<T>(url: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  const timeout = new AbortController();
  const timer = timeoutMs ? setTimeout(() => timeout.abort(), timeoutMs) : undefined;
  const signal = timeoutMs ? AbortSignal.any([timeout.signal, ...(init?.signal ? [init.signal] : [])]) : init?.signal;
  try {
    const response = await fetch(url, { ...init, signal, cache: 'no-store' });
    if (!response.ok) throw new Error(await errorMessage(response));
    return await response.json();
  } catch (cause) {
    if (timeout.signal.aborted && !init?.signal?.aborted) throw new Error('The analysis service did not respond in time. Retrying a status check does not rerun the analysis.');
    throw cause;
  } finally { clearTimeout(timer); }
}

export async function downloadResult(url: string, name: string, body?: unknown) {
  const response = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  if (!response.ok) throw new Error(await errorMessage(response));
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

const STORAGE_KEY = 'railguard.ps3.jobs.v1';
const STORAGE_EVENT = 'railguard-ps3-jobs';
function subscribe(listener: () => void) {
  window.addEventListener('storage', listener);
  window.addEventListener(STORAGE_EVENT, listener);
  return () => { window.removeEventListener('storage', listener); window.removeEventListener(STORAGE_EVENT, listener); };
}
function storedJobs() {
  try { return window.localStorage.getItem(STORAGE_KEY) ?? '[]'; } catch { return '[]'; }
}
function parseJobs(raw: string): RecentJob[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((row): row is RecentJob => Boolean(row && typeof row.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(row.id) && SUBSYSTEMS.some(item => item.id === row.subsystem) && typeof row.created_at === 'string')).slice(0, 24) : [];
  } catch { return []; }
}
export function useRecentJobs() {
  const raw = useSyncExternalStore(subscribe, storedJobs, () => '[]');
  return useMemo(() => parseJobs(raw), [raw]);
}
export function rememberJob(id: string, subsystem: SubsystemId) {
  try {
    const previous = parseJobs(storedJobs());
    const row = previous.find(item => item.id === id) ?? { id, subsystem, created_at: new Date().toISOString() };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([row, ...previous.filter(item => item.id !== id)].slice(0, 24)));
    window.dispatchEvent(new Event(STORAGE_EVENT));
  } catch { /* The active job remains accessible when browser storage is blocked. */ }
}

/** Remove only the browser's saved link; retained server files are untouched. */
export function forgetJob(id: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parseJobs(storedJobs()).filter(item => item.id !== id)));
    window.dispatchEvent(new Event(STORAGE_EVENT));
    return true;
  } catch { return false; }
}
