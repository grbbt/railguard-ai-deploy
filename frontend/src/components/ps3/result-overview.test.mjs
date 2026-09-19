import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

async function loadHelper(filename) {
  const source = readFileSync(new URL(filename, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}
const { summarizePrediction } = await loadHelper('./prediction-comparison.ts');
const { describePrediction } = await loadHelper('./result-overview.ts');
const report = (subsystem, prediction_rows = [], extra = {}) => ({ subsystem, file_id: 'source.csv', model_name: 'frozen model', summary: 'A stale or untrusted prose summary', prediction_rows, evidence: [], warnings: [], ...extra });
const overview = (input) => describePrediction(summarizePrediction(input));

test('Door headline counts action predictions across all rows rather than telemetry or prose counts', () => {
  const rows = Array.from({ length: 38 }, (_, index) => ({ prediction: index < 9 ? 'Abnormal resistance' : 'Normal' }));
  const result = overview(report('door', rows, { evidence: [{ id: 'rows', value: 6254 }] }));
  assert.equal(result.value, '9 of 38');
  assert.deepEqual(result.facts, [
    { label: 'Candidate actions', value: '38' },
    { label: 'Normal classification', value: '29' },
    { label: 'Unclassified', value: '0' },
  ]);
  assert.match(result.limit, /movement intervals/);
  assert.doesNotMatch(JSON.stringify(result), /6254|critical|confidence/i);
});

test('Door unknown labels are visibly unclassified and never counted as normal', () => {
  const result = overview(report('door', [{ prediction: 'Normal' }, { prediction: null }]));
  assert.equal(result.value, '0 of 2');
  assert.equal(result.facts.find(item => item.label === 'Normal classification').value, '1');
  assert.equal(result.facts.find(item => item.label === 'Unclassified').value, '1');
  assert.match(result.description, /No classified action/);
  assert.doesNotMatch(result.description, /all.*normal|healthy|safe/i);
});

test('ACV unavailable first-car evidence prevents an unsupported first-inspection recommendation', () => {
  const rows = [{ ranked_cars: '13|11|12|18|16|14|15|17' }];
  const available = overview(report('acv', rows, { entities: [{ id: '13', status: 'ranked' }] }));
  assert.equal(available.value, 'Car 13');
  assert.equal(available.label, 'First car to inspect');
  const missing = overview(report('acv', rows, { entities: [{ id: '13', status: 'unavailable' }] }));
  assert.equal(missing.value, 'Car 13');
  assert.match(missing.label, /evidence unavailable/);
  assert.match(missing.description, /Check the source data/);
  assert.match(missing.limit, /not a confirmed leak/);
});

test('ACV missing entity metadata preserves the exact ranking without claiming usable evidence', () => {
  const ranking = ['13', '11', '12', '18', '16', '14', '15', '17'];
  const rows = [{ ranked_cars: ranking.join('|') }];
  const summary = summarizePrediction(report('acv', rows));
  const result = describePrediction(summary);
  assert.deepEqual(summary.ranking, ranking);
  assert.deepEqual(summary.unknownEvidenceCars, ranking);
  assert.deepEqual(summary.unavailableCars, []);
  assert.equal(summary.hasPrediction, true);
  assert.equal(result.value, 'Car 13');
  assert.match(result.label, /evidence not recorded/);
  assert.match(result.description, /evidence availability was not recorded/);
  assert.doesNotMatch(result.label, /First car to inspect/);
  assert.equal(rows[0].ranked_cars, ranking.join('|'));
});

test('ACV partial metadata distinguishes an unknown first car from explicitly unavailable cars', () => {
  const ranking = ['13', '11', '12', '18', '16', '14', '15', '17'];
  const summary = summarizePrediction(report('acv', [{ ranked_cars: ranking.join('|') }], {
    entities: ranking.map(car => ({ id: car, status: car === '13' ? 'legacy_status' : car === '18' ? 'unavailable' : 'ranked' })),
    evidence: [{ id: 'acv-car-13', value: 2 }],
  }));
  const result = describePrediction(summary);
  assert.deepEqual(summary.ranking, ranking);
  assert.deepEqual(summary.unknownEvidenceCars, ['13']);
  assert.deepEqual(summary.unavailableCars, ['18']);
  assert.equal(result.value, 'Car 13');
  assert.match(result.label, /evidence not recorded/);
  assert.match(result.description, /Check the source data/);
  assert.doesNotMatch(result.label, /First car to inspect|evidence unavailable/);
});

test('Rail output describes the recording class without adding axle localisation or severity', () => {
  for (const prediction of ['Normal', 'Side I', 'Side II']) {
    const result = overview(report('rail', [{ prediction }]));
    assert.equal(result.value, prediction);
    assert.equal(result.facts[0].value, 'Whole recording');
    assert.match(result.limit, /does not identify a faulty axle/);
    assert.doesNotMatch(result.description, /critical|severe|healthy|safe|confirmed/i);
  }
});

test('SHM preserves tiny estimates and zero without inventing a risk class or threshold', () => {
  for (const prediction of [0, 1e-15, 0.03226951331565569, 1.4]) {
    const result = overview(report('shm', [{ prediction }]));
    assert.equal(result.value, prediction.toPrecision(6));
    assert.equal(result.label, 'Estimated cumulative fatigue damage');
    assert.doesNotMatch(result.value, /%|safe|critical/i);
    assert.match(result.limit, /No validated safety threshold/);
  }
});

test('Empty and malformed output stays unavailable even if report prose claims a result', () => {
  const inputs = [
    report('door'), report('acv'), report('rail'), report('shm'),
    report('acv', [{ ranked_cars: '01|02' }]),
    report('rail', [{ prediction: 'Side III' }]),
    report('shm', [{ prediction: '0.03' }]),
    report('shm', [{ prediction: -1 }]),
    report('door', [{ prediction: 'Unknown' }]),
  ];
  for (const input of inputs) {
    const result = overview({ ...input, summary: 'Healthy, confirmed normal result' });
    assert.equal(result.value, 'No usable prediction');
    assert.deepEqual(result.facts, []);
    assert.match(result.limit, /does not mean the component is normal/);
  }
});
