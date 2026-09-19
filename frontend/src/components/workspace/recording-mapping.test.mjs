import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./recording-mapping.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const { makeRecordingMapping, recordingSelection, finiteTraceRuns, recordingCarTarget, recordingAttention } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const report = (subsystem, extra = {}) => ({ subsystem, file_id: 'source.csv', model_name: 'frozen model', summary: '', prediction_rows: [], evidence: [], warnings: [], series: [], entities: [], ...extra });

test('no report means no inferred car identity, score, fault, or action', () => {
  const acv = makeRecordingMapping(null, 'acv');
  assert.equal(acv.hasReport, false);
  assert.equal(acv.cars.length, 8);
  assert.ok(acv.cars.every(car => car.sourceId === null && car.tone === 'unknown'));
  assert.ok(acv.targets.every(target => target.rank === undefined && target.evidence.length === 0));
  const rail = makeRecordingMapping(null, 'rail');
  assert.ok(rail.primary.every(side => side.tone === 'unknown'));
  assert.equal(makeRecordingMapping(null, 'door').targets.length, 0);
  const shm = makeRecordingMapping(null, 'shm');
  assert.equal(shm.targets[0].status, 'Estimate unavailable');
  assert.equal(shm.targets[0].tone, 'unknown');
});

test('a report for another subsystem cannot color or populate the selected view', () => {
  const model = makeRecordingMapping(report('rail', { prediction_rows: [{ prediction: 'Side I' }] }), 'acv');
  assert.equal(model.hasReport, false);
  assert.ok(model.cars.every(car => car.tone === 'unknown'));
});

test('ACV preserves actual IDs and separates ranking from unavailable evidence', () => {
  const ids = ['11', '12', '13', '14', '15', '16', '17', '18'];
  const ranking = ['13', '11', '12', '14', '15', '16', '17', '18'];
  const model = makeRecordingMapping(report('acv', {
    prediction_rows: [{ ranked_cars: ranking.join('|') }],
    entities: ids.map(id => ({ id, label: `Car ${id}`, status: id === '18' ? 'unavailable' : 'ranked', value: null, detail: 'Source case measurement' })),
    evidence: [{ id: 'acv-car-13', label: 'Residual', value: 3 }, { id: 'acv-above_target_fraction-13', label: 'Fraction', value: 75 }, { id: 'acv-car-11', label: 'Residual', value: 1 }],
    series: [{ name: 'Car 13 cabin measurement', x_label: 'Hours', y_label: 'Raw', points: [{ x: 0, y: 24 }] }],
  }), 'acv');
  assert.deepEqual(model.cars.map(car => car.sourceId), ids);
  const first = recordingSelection(model, 'car-13');
  assert.equal(first.rank, 1);
  assert.equal(first.tone, 'priority');
  assert.equal(first.evidence.length, 2);
  assert.equal(first.traces.length, 1);
  const unknown = recordingSelection(model, 'car-18');
  assert.equal(unknown.tone, 'unknown');
  assert.equal(unknown.rank, undefined);
  assert.match(unknown.status, /unavailable/i);
  assert.equal(recordingSelection(model, 'stale-id').id, 'car-13');
});

test('ACV ordering without car evidence does not become measured fault evidence', () => {
  const model = makeRecordingMapping(report('acv', { prediction_rows: [{ ranked_cars: '01|02|03|04|05|06|07|08' }] }), 'acv');
  assert.ok(model.targets.every(car => car.tone === 'unknown' && car.rank === undefined));
});

test('Rail has 64 neutral sensor positions and shades only the predicted side', () => {
  const model = makeRecordingMapping(report('rail', {
    prediction_rows: [{ prediction: 'Side II' }],
    evidence: [{ id: 'rail-side-1-vibration', label: 'Side I RMS', value: 2 }, { id: 'rail-side-2-vibration', label: 'Side II RMS', value: 7 }],
    series: [{ name: 'Side II: Car 03 position 2 vibration (largest RMS channel)', x_label: 'Seconds', y_label: 'Acceleration', points: [{ x: 0, y: 7 }] }],
  }), 'rail');
  assert.equal(model.cars.length, 8);
  assert.equal(model.targets.filter(target => target.position !== undefined).length, 64);
  assert.deepEqual(model.targets.filter(target => target.tone === 'flagged').map(target => target.id), ['side-2']);
  for (const target of model.targets.filter(item => item.position !== undefined)) {
    assert.equal(target.side, target.position % 2 ? 1 : 2);
    assert.equal(target.tone, 'context');
    assert.match(target.status, /no individual prediction/);
  }
  const sensor = recordingSelection(model, 'sensor-8-6');
  assert.equal(sensor.side, 2);
  assert.equal(sensor.evidence[0].value, 7);
  assert.match(sensor.detail, /evidence and traces below describe that rail side/);
  assert.match(sensor.traces[0].name, /Car 03 position 2/);
});

test('Normal Rail output does not assign healthy scores to sensors', () => {
  const model = makeRecordingMapping(report('rail', { prediction_rows: [{ prediction: 'Normal' }] }), 'rail');
  assert.equal(model.targets.filter(target => target.tone === 'flagged').length, 0);
  assert.ok(model.targets.every(target => !/healthy|100%/i.test(target.status)));
});

test('Door uses returned action labels and times without invented car IDs or measurements', () => {
  const rows = [
    { start_time: '2023-7-5-0-0-0-0', end_time: '2023-7-5-0-0-1-0', prediction: 'Normal' },
    { start_time: '2023-7-5-0-0-5-0', end_time: '2023-7-5-0-0-6-0', prediction: 'Abnormal resistance' },
  ];
  const model = makeRecordingMapping(report('door', { prediction_rows: rows, evidence: [{ id: 'door-action-2-current', label: 'Peak', value: null }, { id: 'door-action-20-current', label: 'Other action', value: 90 }] }), 'door');
  const action = recordingSelection(model, 'action-2');
  assert.equal(model.cars.length, 0);
  assert.equal(action.tone, 'flagged');
  assert.equal(action.evidence.length, 1);
  assert.equal(action.evidence[0].value, null);
  assert.match(action.detail, /2023-7-5-0-0-5-0/);
  assert.equal(action.carId, undefined);
});

test('SHM retains raw recording-level damage without mapping it to a percentage or location', () => {
  const model = makeRecordingMapping(report('shm', { prediction_rows: [{ file_id: 'stress.csv', prediction: 1.24 }] }), 'shm');
  const target = model.targets[0];
  assert.equal(model.targets.length, 1);
  assert.match(target.status, /1\.2400/);
  assert.doesNotMatch(target.status, /%/);
  assert.match(target.detail, /complete stress recording/);
  assert.match(model.note, /not a damage percentage/);
  assert.equal(target.position, undefined);
  assert.equal(target.carId, undefined);
});

test('SHM rejects nonfinite or missing estimate as unavailable', () => {
  for (const prediction of [null, Infinity, NaN, '0.4']) {
    const model = makeRecordingMapping(report('shm', { prediction_rows: [{ prediction }] }), 'shm');
    assert.equal(model.targets[0].tone, 'unknown');
  }
});

test('trace previews preserve null/nonfinite gaps and do not manufacture points', () => {
  const runs = finiteTraceRuns({ name: 'Measured', points: [{ x: 0, y: 2 }, { x: 1, y: null }, { x: 2, y: 4 }, { x: 3, y: Infinity }, { x: '4', y: 5 }, { x: 'bad', y: 8 }] });
  assert.deepEqual(runs, [[{ x: 0, y: 2 }], [{ x: 2, y: 4 }], [{ x: 4, y: 5 }]]);
});

test('changing Rail cars preserves Side II and explicit sensor position', () => {
  const mapping = makeRecordingMapping(report('rail', { prediction_rows: [{ prediction: 'Side II' }] }), 'rail');
  assert.equal(recordingCarTarget(mapping, recordingSelection(mapping, 'side-2'), 4), 'sensor-5-2');
  assert.equal(recordingCarTarget(mapping, recordingSelection(mapping, 'sensor-2-6'), 6), 'sensor-7-6');
  assert.equal(recordingCarTarget(mapping, recordingSelection(mapping, 'side-1'), 1), 'sensor-2-1');
});

test('attention includes every flagged Door action and never a normal action', () => {
  const mapping = makeRecordingMapping(report('door', { prediction_rows: Array.from({length: 38}, (_, i) => ({ prediction: i % 4 === 0 ? 'Abnormal resistance' : 'Normal' })) }), 'door');
  const attention = recordingAttention(mapping);
  assert.equal(attention.targets.length, 10);
  assert.match(attention.headline, /10 of 38/);
  assert.ok(attention.targets.every(target => target.tone === 'flagged'));
  assert.match(attention.note, /does not identify a faulty part/);
});

test('malformed single-output predictions cannot become 3D highlights or damage', () => {
  const acv = makeRecordingMapping(report('acv', { prediction_rows: [{ranked_cars:'01|01'}], entities: [{id:'01',status:'ranked'}] }), 'acv');
  assert.equal(recordingAttention(acv).flagged, false);
  const rail = makeRecordingMapping(report('rail', { prediction_rows: [{prediction:'Side I'}, {prediction:'Side II'}] }), 'rail');
  assert.equal(recordingAttention(rail).flagged, false);
  assert.match(recordingAttention(rail).headline, /unavailable/);
  for (const rows of [[{prediction:-1}], [{prediction:0.4},{prediction:0.8}]]) {
    assert.equal(makeRecordingMapping(report('shm', {prediction_rows:rows}), 'shm').primary[0].tone, 'unknown');
  }
});

test('normal Rail and SHM estimates do not create critical or localized findings', () => {
  for (const [task, prediction] of [['rail','Normal'],['shm',0.52]]) {
    const attention = recordingAttention(makeRecordingMapping(report(task,{prediction_rows:[{prediction}]}),task));
    assert.equal(attention.targets.length, 0);
    assert.equal(attention.flagged, false);
    assert.doesNotMatch(attention.headline, /critical|fault|%/i);
  }
});
