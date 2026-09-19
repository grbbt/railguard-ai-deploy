import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Compile the actual module so these tests also run on supported Node 20,
// which does not have Node 24's native TypeScript stripping.
const source = readFileSync(new URL('./job-state.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const { bundleState } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const key = 'current-refresh';
const job = (id, subsystem, status = 'completed', created_at = '2026-09-16T00:00:00Z') => ({ id, subsystem, status, created_at, reports: status === 'completed' ? [{ file_id: `${id}.csv` }] : [] });
const checked = (...ids) => Object.fromEntries(ids.map(id => [id, key]));

test('partial history cannot export a silently incomplete bundle', () => {
  const state = bundleState(['door', 'rail'], { door: job('door', 'door') }, {}, checked('door'), key);
  assert.equal(state.canExport, false);
  assert.deepEqual(state.pending, ['rail']);
});

test('an unavailable saved job blocks export despite cached completed results', () => {
  const state = bundleState(['rail'], { rail: job('rail', 'rail') }, { rail: 'Service unavailable' }, checked('rail'), key);
  assert.equal(state.canExport, false);
  assert.deepEqual(state.unavailable, ['rail']);
});

test('manual refresh must recheck all cached jobs before export', () => {
  const state = bundleState(['rail'], { rail: job('rail', 'rail') }, {}, { rail: 'previous-refresh' }, key);
  assert.equal(state.canExport, false);
  assert.deepEqual(state.pending, ['rail']);
});

test('a newer active job prevents exporting an older completed result', () => {
  for (const status of ['queued', 'running']) {
    const state = bundleState(['old', 'new'], { old: job('old', 'rail'), new: job('new', 'rail', status) }, {}, checked('old', 'new'), key);
    assert.equal(state.canExport, false);
    assert.deepEqual(state.running, ['new']);
  }
});

test('ready history includes the latest completed job for each saved subsystem exactly once', () => {
  const jobs = { d: job('d', 'door'), a: job('a', 'acv'), old: job('old', 'rail'), r: job('r', 'rail', 'completed', '2026-09-17T00:00:00Z'), s: job('s', 'shm') };
  const ids = Object.keys(jobs);
  const state = bundleState([...ids, 'r'], jobs, {}, checked(...ids), key);
  assert.equal(state.canExport, true);
  assert.deepEqual(state.completed.map(item => item.id), ['d', 'a', 'r', 's']);
});

test('explicitly forgotten links and unrelated cached jobs are excluded', () => {
  const state = bundleState(['rail'], { rail: job('rail', 'rail'), forgotten: job('forgotten', 'door') }, { forgotten: 'Not found' }, checked('rail'), key);
  assert.equal(state.canExport, true);
  assert.deepEqual(state.completed.map(item => item.id), ['rail']);
});

test('checked failed jobs are terminal and do not prevent exporting valid completed jobs', () => {
  const state = bundleState(['rail', 'failed'], { rail: job('rail', 'rail'), failed: job('failed', 'door', 'failed') }, {}, checked('rail', 'failed'), key);
  assert.equal(state.canExport, true);
  assert.deepEqual(state.completed.map(item => item.id), ['rail']);
});

test('empty history and empty reports cannot be exported', () => {
  assert.equal(bundleState([], {}, {}, {}, key).canExport, false);
  assert.equal(bundleState(['rail'], { rail: { ...job('rail', 'rail'), reports: [] } }, {}, checked('rail'), key).canExport, false);
});
