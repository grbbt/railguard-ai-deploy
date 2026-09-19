import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./export-selection.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const { defaultExportChoices, buildExportPlan } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const report = (file_id, subsystem = 'rail', rows = [{ file_id, prediction: 'Normal' }]) => ({ subsystem, file_id, prediction_rows: rows });
const job = (id = 'rail-old', subsystem = 'rail', reports = [report('first.csv', subsystem), report('second.csv', subsystem)], status = 'completed') => ({ id, subsystem, status, reports });
const choice = (jobId = 'rail-old', fileIds = ['first.csv']) => ({ jobId, fileIds });
const plan = (choices, ...jobs) => buildExportPlan(choices, Object.fromEntries(jobs.map(item => [item.id, item])));
const deepFreeze = value => { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(deepFreeze); } return value; };

test('defaults select all files of the first completed run for each subsystem', () => {
  const jobs = [job('pending', 'rail', [], 'running'), job(), job('newer'), job('door', 'door')];
  assert.deepEqual(defaultExportChoices(jobs), {
    rail: choice('rail-old', ['first.csv', 'second.csv']), door: choice('door', ['first.csv', 'second.csv']),
  });
  assert.deepEqual(defaultExportChoices([]), {});
});

test('a chosen subset produces exactly one CSV and counts only selected rows', () => {
  const result = plan({ rail: choice('rail-old', ['second.csv']) }, job());
  assert.deepEqual(result.selections, [{ job_id: 'rail-old', file_ids: ['second.csv'] }]);
  assert.deepEqual(result.outputs, [{ subsystem: 'rail', filename: 'rail_predictions.csv', fileCount: 1, rowCount: 1 }]);
  assert.equal(result.fileCount, 1);
  assert.equal(result.rowCount, 1);
  assert.deepEqual(result.problems, []);
});

test('file order follows retained reports rather than checkbox click order', () => {
  assert.deepEqual(plan({ rail: choice('rail-old', ['second.csv', 'first.csv']) }, job()).selections[0].file_ids, ['first.csv', 'second.csv']);
});

test('empty choices and intentionally deselected subsystems produce zero totals', () => {
  for (const choices of [{}, { rail: choice('missing', []) }]) {
    assert.deepEqual(plan(choices), { selections: [], fileCount: 0, rowCount: 0, outputs: [], problems: [], selectedJobs: [] });
  }
});

test('refresh does not replace a pinned older run or re-add a removed file', () => {
  const choices = { rail: choice('rail-old', ['second.csv']) };
  const old = job(); const newer = job('rail-new', 'rail', [report('third.csv')]);
  const result = plan(choices, old, newer);
  assert.deepEqual(result.selections, [{ job_id: 'rail-old', file_ids: ['second.csv'] }]);
  assert.deepEqual(result.selectedJobs, [old]);
  const stale = plan(choices, newer);
  assert.equal(stale.problems.length, 1);
  assert.deepEqual(stale.selections, []);
});

test('unknown and case-changed file IDs block that selection without broadening it', () => {
  for (const id of ['missing.csv', 'First.csv']) {
    const result = plan({ rail: choice('rail-old', ['second.csv', id]) }, job());
    assert.equal(result.problems.length, 1);
    assert.deepEqual(result.selections, []);
    assert.equal(result.fileCount, 0);
  }
});

test('queued, running and failed selected jobs are unavailable for export', () => {
  for (const status of ['queued', 'running', 'failed']) {
    const result = plan({ rail: choice() }, job('rail-old', 'rail', undefined, status));
    assert.equal(result.problems.length, 1);
    assert.deepEqual(result.selections, []);
  }
});

test('job identity and subsystem mismatch are rejected', () => {
  for (const invalid of [job('different'), job('rail-old', 'acv')]) {
    const result = buildExportPlan({ rail: choice() }, { 'rail-old': invalid });
    assert.equal(result.problems.length, 1);
    assert.deepEqual(result.selections, []);
  }
});

test('duplicate selected file IDs including casing cannot duplicate output rows', () => {
  for (const fileIds of [['first.csv', 'first.csv'], ['first.csv', 'FIRST.csv']]) {
    assert.equal(plan({ rail: choice('rail-old', fileIds) }, job()).problems.length, 1);
  }
});

test('ambiguous duplicate saved filenames and mismatched reports are rejected', () => {
  for (const reports of [[report('first.csv'), report('first.csv')], [report('first.csv'), report('FIRST.csv')], [report('first.csv', 'acv')]]) {
    const result = plan({ rail: choice() }, job('rail-old', 'rail', reports));
    assert.equal(result.problems.length, 1);
    assert.deepEqual(result.selections, []);
  }
});

test('selected reports without prediction rows cannot form an empty success export', () => {
  for (const rows of [[], null, undefined]) {
    const broken = report('first.csv'); broken.prediction_rows = rows;
    const result = plan({ rail: choice() }, job('rail-old', 'rail', [broken]));
    assert.equal(result.problems.length, 1);
    assert.deepEqual(result.selections, []);
  }
});

test('all Door action rows and zero SHM predictions are retained in totals', () => {
  const door = job('door-run', 'door', [report('stream.csv', 'door', Array.from({ length: 38 }, (_, index) => ({ start_time: index, end_time: index + 1, prediction: 'Normal' })))]);
  const shm = job('shm-run', 'shm', [report('zero.csv', 'shm', [{ file_id: 'zero.csv', prediction: 0 }])]);
  const result = plan({ shm: choice(shm.id, ['zero.csv']), door: choice(door.id, ['stream.csv']) }, door, shm);
  assert.equal(result.fileCount, 2);
  assert.equal(result.rowCount, 39);
  assert.deepEqual(result.outputs, [
    { subsystem: 'door', filename: 'door_predictions.csv', fileCount: 1, rowCount: 38 },
    { subsystem: 'shm', filename: 'shm_predictions.csv', fileCount: 1, rowCount: 1 },
  ]);
  assert.equal(result.selectedJobs[1].reports[0].prediction_rows[0].prediction, 0);
});

test('multiple Door streams cannot be exported together but one selected stream keeps all actions', () => {
  const door = job('door-run', 'door', [report('first.csv', 'door', [{ prediction: 'Normal' }, { prediction: 'Abnormal resistance' }]), report('second.csv', 'door')]);
  const invalid = plan(defaultExportChoices([door]), door);
  assert.equal(invalid.problems.length, 1);
  assert.match(invalid.problems[0], /one continuous recording/);
  assert.deepEqual(invalid.selections, []);
  const valid = plan({ door: choice(door.id, ['first.csv']) }, door);
  assert.deepEqual(valid.problems, []);
  assert.equal(valid.fileCount, 1);
  assert.equal(valid.rowCount, 2);
});

test('malformed default reports remain pinned with an explicit problem instead of silently dropping files', () => {
  for (const reports of [null, undefined, [], [null], [{ file_id: null }], [{ file_id: 7 }], [{ file_id: '' }], [report('first.csv'), null], [report('first.csv'), report('wrong.csv', 'acv')]]) {
    const broken = job(); broken.reports = reports;
    const good = job('acv-run', 'acv', [report('acv.xlsx', 'acv')]);
    const defaults = defaultExportChoices([broken, good]);
    assert.equal(defaults.rail.jobId, broken.id);
    assert.equal(typeof defaults.rail.unavailableReason, 'string');
    assert.ok(defaults.rail.fileIds.every(id => typeof id === 'string' && id));
    const result = plan(defaults, broken, good);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /saved file reports are invalid/);
    assert.deepEqual(result.selections, [{ job_id: 'acv-run', file_ids: ['acv.xlsx'] }]);
  }
});

test('explicitly removing an unavailable default choice allows valid selected results to export', () => {
  const broken = job(); broken.reports = null;
  const good = job('shm-run', 'shm', [report('zero.csv', 'shm', [{ file_id: 'zero.csv', prediction: 0 }])]);
  const defaults = defaultExportChoices([broken, good]);
  delete defaults.rail;
  const result = plan(defaults, broken, good);
  assert.deepEqual(result.problems, []);
  assert.equal(result.fileCount, 1);
});

test('corrupt runtime choices are reported instead of discarded or expanded', () => {
  for (const choiceValue of [null, {}, { jobId: '', fileIds: ['first.csv'] }, { jobId: 'rail-old', fileIds: [''] }, { jobId: 'rail-old', fileIds: [5] }]) {
    const result = plan({ rail: choiceValue }, job());
    assert.equal(result.problems.length, 1);
    assert.deepEqual(result.selections, []);
  }
  assert.equal(plan({ unknown: choice() }, job()).problems.length, 1);
});

test('mixed valid and invalid choices preserve problems so the caller can block the whole request', () => {
  const result = plan({ door: choice('missing', ['stream.csv']), rail: choice() }, job());
  assert.equal(result.problems.length, 1);
  assert.equal(result.selections.length, 1);
  assert.equal(result.outputs[0].subsystem, 'rail');
});

test('helpers do not mutate inputs or share mutable file selection arrays', () => {
  const saved = deepFreeze(job());
  const choices = deepFreeze({ rail: choice('rail-old', ['second.csv', 'first.csv']) });
  const before = JSON.stringify({ saved, choices });
  const result = plan(choices, saved);
  const defaults = defaultExportChoices([saved]);
  result.selections[0].file_ids.push('other.csv');
  defaults.rail.fileIds.pop();
  assert.equal(JSON.stringify({ saved, choices }), before);
});
