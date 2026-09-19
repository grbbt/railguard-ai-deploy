import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the actual helper source on supported Node 20 as well as newer Node.
const source = readFileSync(new URL('./workspace-state.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const { deriveWorkspaceHistory, workspaceWatchIds, catalogIsCurrent } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const row = (id, subsystem = 'rail', created_at = '2026-09-18T00:00:00Z') => ({ id, subsystem, created_at });
const job = (id, subsystem = 'rail', created_at = '2026-09-18T00:00:00Z') => ({ ...row(id, subsystem, created_at), status: 'completed', reports: [{ file_id: `${id}.csv` }] });
const watch = overrides => workspaceWatchIds({ history: [], catalogIds: [], latestCompletedIds: [], activeIds: [], activeId: null, selectedIds: [], ...overrides });

test('catalog dates replace optimistic browser dates without duplicate history entries', () => {
  const recent = [row('server-old', 'rail', '2026-09-18T12:00:00Z')];
  const library = [row('server-old', 'rail', '2026-09-16T00:00:00Z'), row('server-new', 'door', '2026-09-17T00:00:00Z')];
  const history = deriveWorkspaceHistory({ recent, library, jobs: {}, selectedJobs: {} });
  assert.deepEqual(history.map(item => item.id), ['server-new', 'server-old']);
  assert.equal(history[1].created_at, '2026-09-16T00:00:00Z');
  assert.equal(recent[0].created_at, '2026-09-18T12:00:00Z');
});

test('an explicitly selected run outside the forty-row catalog stays selectable', () => {
  const library = Array.from({ length: 40 }, (_, index) => row(`catalog-${index}`));
  const selected = job('older-selected', 'acv', '2026-09-01T00:00:00Z');
  const history = deriveWorkspaceHistory({ recent: [], library, jobs: { [selected.id]: selected, unrelated: job('unrelated') }, selectedJobs: { acv: selected.id } });
  assert.equal(history.length, 41);
  assert.deepEqual(history.at(-1), row('older-selected', 'acv', selected.created_at));
  assert.equal(history.some(item => item.id === 'unrelated'), false);
  assert.deepEqual(watch({ history, catalogIds: library.map(item => item.id), activeId: selected.id, selectedIds: [selected.id] }), [selected.id]);
});

test('history sorting compares instants and preserves equal-date input order', () => {
  const history = deriveWorkspaceHistory({ recent: [row('equal-first', 'rail', '2026-09-18T08:00:00+08:00'), row('equal-second'), row('invalid', 'door', 'unavailable')], library: [row('newer', 'acv', '2026-09-18T01:00:00Z')], jobs: {}, selectedJobs: {} });
  assert.deepEqual(history.map(item => item.id), ['newer', 'equal-first', 'equal-second', 'invalid']);
});

test('missing selected payloads are not fabricated into history', () => {
  assert.deepEqual(deriveWorkspaceHistory({ recent: [], library: [], jobs: {}, selectedJobs: { rail: 'not-yet-loaded' } }), []);
  assert.deepEqual(watch({ selectedIds: ['not-yet-loaded'] }), ['not-yet-loaded']);
});

test('thirty-three known history rows do not trigger thirty-three full report requests', () => {
  const history = Array.from({ length: 33 }, (_, index) => row(`history-${index}`));
  const ids = watch({ history, catalogIds: history.map(item => item.id), latestCompletedIds: ['history-0'], activeId: 'history-17', selectedIds: ['history-17'] });
  assert.deepEqual(ids, ['history-0', 'history-17']);
});

test('unknown browser links are resolved while known unselected history stays summary-only', () => {
  const history = [row('known'), row('browser-link'), row('browser-link')];
  assert.deepEqual(watch({ history, catalogIds: ['known'] }), ['browser-link']);
});

test('unresolved initial catalog fetches only explicit selections, not all browser history', () => {
  const history = Array.from({ length: 33 }, (_, index) => row(`browser-${index}`));
  assert.deepEqual(watch({ history, catalogResolved: false }), []);
  assert.deepEqual(watch({ history, catalogResolved: false, activeId: 'browser-17', selectedIds: ['browser-17', 'browser-5'] }), ['browser-17', 'browser-5']);
});

test('failed initial catalog allows saved-link fallback after resolution', () => {
  const history = [row('saved-rail'), row('saved-door')];
  const libraryChecked = null;
  const libraryError = 'The local catalog did not respond';
  assert.deepEqual(watch({ history, catalogResolved: libraryChecked !== null || Boolean(libraryError) }), ['saved-door', 'saved-rail']);
});

test('resolved catalog suppresses known browser history while retaining explicit export and active candidates', () => {
  const history = [row('known-old'), row('unknown')];
  assert.deepEqual(watch({ history, catalogResolved: true, catalogIds: ['known-old'], latestCompletedIds: ['latest'], activeIds: ['running'] }), ['latest', 'running', 'unknown']);
});

test('latest completed runs across all four subsystems remain watched independently of selection', () => {
  const latestCompletedIds = ['door-latest', 'acv-latest', 'rail-latest', 'shm-latest'];
  assert.deepEqual(watch({ latestCompletedIds, activeIds: ['running-acv'], activeId: 'old-rail', selectedIds: ['old-rail', 'door-latest', ''] }), ['acv-latest', 'door-latest', 'old-rail', 'rail-latest', 'running-acv', 'shm-latest']);
});

test('watch keys are stable across input ordering and duplicates', () => {
  assert.deepEqual(watch({ latestCompletedIds: ['b', 'a'], selectedIds: ['a', 'b'] }), watch({ latestCompletedIds: ['a', 'b'], selectedIds: ['b', 'a'] }));
});

test('catalog gate blocks initial, stale, errored, and not-yet-checked refreshes', () => {
  assert.equal(catalogIsCurrent(null, 0, ''), false);
  assert.equal(catalogIsCurrent(1, 2, ''), false);
  assert.equal(catalogIsCurrent(2, 2, 'Fetch failed'), false);
  assert.equal(catalogIsCurrent(null, 2, ''), false);
  assert.equal(catalogIsCurrent(0, 0, ''), true);
  assert.equal(catalogIsCurrent(2, 2, ''), true);
});
