import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./prediction-comparison.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const { summarizePrediction, selectComparisonRows } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const report = (subsystem, extra = {}) => ({ subsystem, file_id: 'source.csv', model_name: 'frozen model', summary: '', prediction_rows: [], evidence: [], warnings: [], ...extra });

test('Door comparison counts every returned action beyond the displayed page or evidence subset', () => {
  const predictions = Array.from({ length: 103 }, (_, index) => ({ start_time: String(index), end_time: String(index + 1), prediction: index < 71 ? 'Normal' : 'Abnormal resistance' }));
  const summary = summarizePrediction(report('door', { prediction_rows: predictions, summary: 'Stale summary with 8 actions', evidence: [{ id: 'door-actions', label: 'Stale count', value: 8 }] }));
  assert.equal(summary.totalActions, 103);
  assert.equal(summary.normalActions, 71);
  assert.equal(summary.abnormalActions, 32);
  assert.equal(summary.unknownActions, 0);
  assert.equal(summary.sortValue, 32);
  assert.equal(summary.hasPrediction, true);
  assert.match(summary.result, /32 abnormal \/ 103 candidate actions/);
});

test('Unrecognised Door labels remain unclassified, never treated as normal', () => {
  const summary = summarizePrediction(report('door', { prediction_rows: [{ prediction: 'Normal' }, { prediction: null }, { prediction: 'abnormal' }, { prediction: 1 }] }));
  assert.equal(summary.totalActions, 4);
  assert.equal(summary.normalActions, 1);
  assert.equal(summary.abnormalActions, 0);
  assert.equal(summary.unknownActions, 3);
  assert.match(summary.result, /3 unclassified/);
  const unknown = summarizePrediction(report('door', { prediction_rows: [{ prediction: 'unknown' }] }));
  assert.equal(unknown.hasPrediction, false);
  assert.equal(unknown.sortValue, null);
});

test('Empty prediction sets do not become a healthy result or a zero damage estimate', () => {
  for (const subsystem of ['door', 'acv', 'rail', 'shm']) {
    const summary = summarizePrediction(report(subsystem));
    assert.equal(summary.hasPrediction, false);
    assert.equal(summary.result, 'Prediction unavailable');
    assert.equal(summary.sortValue, null);
    assert.equal(summary.damage, null);
    assert.equal(summary.railClass, null);
  }
});

test('ACV retains exact source ranking and flags unavailable evidence only from matching entities', () => {
  const ranking = ['13', '11', '12', '18', '16', '14', '15', '17'];
  const summary = summarizePrediction(report('acv', {
    prediction_rows: [{ ranked_cars: ranking.join('|') }],
    entities: [{ id: '18', status: 'unavailable' }, { id: '18', status: 'unavailable' }, { id: '13', status: 'ranked' }, { id: '99', status: 'unavailable' }],
  }));
  assert.deepEqual(summary.ranking, ranking);
  assert.deepEqual(summary.unavailableCars, ['18']);
  assert.equal(summary.hasPrediction, true);
  assert.equal(summary.sortValue, null);
  assert.doesNotMatch(summary.result, /probability|%|healthy|verified|fault/i);
  const withoutEntities = summarizePrediction(report('acv', { prediction_rows: [{ ranked_cars: ranking.join('|') }] }));
  assert.deepEqual(withoutEntities.unavailableCars, []);
});

test('Malformed ACV output cannot silently supply a first car or inferred car identities', () => {
  for (const ranked_cars of ['01|02', '01|02|03|04|05|06|07|07', '1|2|3|4|5|6|7|8', '01|02|03|04|05|06|07| 08', null, 1]) {
    const summary = summarizePrediction(report('acv', { prediction_rows: [{ ranked_cars }] }));
    assert.deepEqual(summary.ranking, []);
    assert.equal(summary.hasPrediction, false);
  }
});

test('Rail preserves the exact official class and does not invent an ordinal severity', () => {
  for (const prediction of ['Normal', 'Side I', 'Side II']) {
    const summary = summarizePrediction(report('rail', { prediction_rows: [{ prediction }] }));
    assert.equal(summary.railClass, prediction);
    assert.equal(summary.result, prediction);
    assert.equal(summary.hasPrediction, true);
    assert.equal(summary.sortValue, null);
  }
  for (const prediction of [0, 1, 2, 'normal', 'Side III', null]) {
    assert.equal(summarizePrediction(report('rail', { prediction_rows: [{ prediction }] })).railClass, null);
  }
});

test('SHM preserves zero and small finite nonnegative estimates but rejects coercion and invalid values', () => {
  for (const prediction of [0, 0.03226951331565569, 1e-15, 1.4]) {
    const summary = summarizePrediction(report('shm', { prediction_rows: [{ prediction }] }));
    assert.equal(summary.damage, prediction);
    assert.equal(summary.sortValue, prediction);
    assert.equal(summary.hasPrediction, true);
    assert.doesNotMatch(summary.result, /%|probability|life/i);
  }
  for (const prediction of ['0.03', '', null, true, -1, NaN, Infinity, -Infinity]) {
    const summary = summarizePrediction(report('shm', { prediction_rows: [{ prediction }] }));
    assert.equal(summary.damage, null);
    assert.equal(summary.hasPrediction, false);
  }
});

test('Single-output tasks do not silently select a first result from an invalid multirow report', () => {
  for (const [subsystem, row] of [['acv', { ranked_cars: '01|02|03|04|05|06|07|08' }], ['rail', { prediction: 'Normal' }], ['shm', { prediction: 0.2 }]]) {
    assert.equal(summarizePrediction(report(subsystem, { prediction_rows: [row, row] })).hasPrediction, false);
  }
});

test('Comparison search covers filenames and exact returned results without mutating source order', () => {
  const rows = ['Test10.csv', 'Test2.csv', 'Test1.csv'].map((file_id, index) => summarizePrediction(report('rail', { file_id, prediction_rows: [{ prediction: index === 1 ? 'Side II' : 'Normal' }] })));
  assert.deepEqual(selectComparisonRows(rows).map(row => row.fileId), ['Test1.csv', 'Test2.csv', 'Test10.csv']);
  assert.deepEqual(rows.map(row => row.fileId), ['Test10.csv', 'Test2.csv', 'Test1.csv']);
  assert.deepEqual(selectComparisonRows(rows, { query: '  side ii ' }).map(row => row.fileId), ['Test2.csv']);
  assert.deepEqual(selectComparisonRows(rows, { query: 'TEST10' }).map(row => row.fileId), ['Test10.csv']);
  assert.equal(selectComparisonRows(rows, { query: 'not present' }).length, 0);
});

test('Numeric sorts retain zero, place unavailable values last in both directions, and resolve ties by filename', () => {
  const rows = [['Test10.csv', 0.4], ['Test2.csv', 0.4], ['Test1.csv', null], ['Test3.csv', 0]].map(([file_id, prediction]) => summarizePrediction(report('shm', { file_id, prediction_rows: [{ prediction }] })));
  assert.deepEqual(selectComparisonRows(rows, { sort: 'value-desc' }).map(row => row.fileId), ['Test2.csv', 'Test10.csv', 'Test3.csv', 'Test1.csv']);
  assert.deepEqual(selectComparisonRows(rows, { sort: 'value-asc' }).map(row => row.fileId), ['Test3.csv', 'Test2.csv', 'Test10.csv', 'Test1.csv']);
});

test('Warning and result sorts remain transparent and keep unavailable classifications last', () => {
  const rows = [['Test10.csv', 'Side II', 4], ['Test2.csv', 'Side I', 4], ['Test1.csv', null, 0], ['Test3.csv', 'Normal', 1]].map(([file_id, prediction, count]) => summarizePrediction(report('rail', { file_id, prediction_rows: [{ prediction }], warnings: Array(count).fill('Saved report limitation'), evidence: [{ id: 'source', label: 'Measurement', value: null }] })));
  assert.equal(rows[0].warnings, 4);
  assert.equal(rows[0].evidenceCount, 1);
  assert.deepEqual(selectComparisonRows(rows, { sort: 'warnings-desc' }).map(row => row.fileId), ['Test2.csv', 'Test10.csv', 'Test3.csv', 'Test1.csv']);
  assert.deepEqual(selectComparisonRows(rows, { sort: 'result' }).map(row => row.fileId), ['Test3.csv', 'Test2.csv', 'Test10.csv', 'Test1.csv']);
});
