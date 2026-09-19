import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./telemetry-chart.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { prepareTelemetry, telemetryDomain, telemetryNumber, nearestTelemetryPoint, traceCoordinate, telemetryPath, telemetryBridges, telemetrySignalKey, telemetrySignalIndex } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const trace = points => ({ name: 'Retained measured signal', x_label: 'Sample index', y_label: 'Raw units', points });

test('missing readings and invalid coordinates split runs without connecting over gaps', () => {
  const data = prepareTelemetry(trace([{ x: 0, y: 2 }, { x: 1, y: null }, { x: 2, y: 3 }, { x: 3, y: Infinity }, { x: '', y: 8 }, { x: '4', y: 4 }]));
  assert.deepEqual(data.runs.map(run => run.map(point => point.sourceIndex)), [[0], [2], [5]]);
  assert.equal(data.missing, 3);
  assert.deepEqual(data.stats, { min: 2, max: 4, mean: 3 });
});

test('envelope extrema retain source order and duplicate sample positions', () => {
  const data = prepareTelemetry(trace([{ x: 15, y: -8 }, { x: 19, y: 12 }, { x: 19, y: 4 }, { x: 17, y: 3 }]));
  assert.deepEqual(data.points.map(point => point.x), [15, 19, 19, 17]);
  assert.deepEqual(data.runs[0].map(point => point.y), [-8, 12, 4, 3]);
  assert.equal(nearestTelemetryPoint(data.points, 19, 4.1), 2);
});

test('numeric strings and supplied timestamp strings are accepted without treating empty text as zero', () => {
  assert.equal(traceCoordinate('0.125'), .125);
  assert.equal(traceCoordinate('2026-09-19T12:30:00Z'), Date.UTC(2026, 8, 19, 12, 30));
  assert.ok(Number.isNaN(traceCoordinate('')));
  assert.ok(Number.isNaN(traceCoordinate('   ')));
  assert.ok(Number.isNaN(traceCoordinate('sensor-1')));
});

test('empty input never fabricates zero readings or statistics', () => {
  const data = prepareTelemetry(trace([{ x: 0, y: null }]));
  assert.equal(data.stats, null);
  assert.equal(data.points.length, 0);
  assert.equal(nearestTelemetryPoint(data.points, 0), -1);
});

test('flat, all-negative and tiny domains stay finite, enclosing the actual data', () => {
  for (const [min, max] of [[0, 0], [32, 32], [-12, -4], [.00000013, .00000017], [-.0000000004, -.0000000004]]) {
    const domain = telemetryDomain(min, max);
    assert.ok(domain.min < min && domain.max > max, `${min} … ${max}`);
    assert.ok(domain.ticks.every(Number.isFinite));
    assert.ok(domain.step > 0);
    assert.equal(new Set(domain.ticks).size, domain.ticks.length);
    assert.ok(domain.ticks.length >= 2);
    assert.equal(new Set(domain.ticks.map(value => telemetryNumber(value, domain.step))).size, domain.ticks.length);
  }
});

test('keyboard point list includes only finite retained measurements and statistics use those points', () => {
  const data = prepareTelemetry(trace([{ x: 1, y: -4 }, { x: 2, y: null }, { x: 3, y: 8 }, { x: 5, y: 2 }]));
  assert.deepEqual(data.stats, { min: -4, max: 8, mean: 2 });
  assert.equal(nearestTelemetryPoint(data.points, 4.8), 2);
  assert.equal(nearestTelemetryPoint(data.points, -100), 0);
});

test('controller transitions are held steps while continuous measurements remain straight segments', () => {
  const points = prepareTelemetry(trace([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }])).points;
  assert.equal(telemetryPath(points, x => x, y => y, true), 'M0.00,0.00 L1.00,0.00 L1.00,1.00 L2.00,1.00 L2.00,0.00');
  assert.equal(telemetryPath(points, x => x, y => y), 'M0.00,0.00 L1.00,1.00 L2.00,0.00');
});

test('extreme finite engineering magnitudes do not overflow the axis domain', () => {
  for (const [min, max] of [[-1e308, 1e308], [1e-200, 2e-200], [Number.MIN_VALUE, Number.MIN_VALUE]]) {
    const domain = telemetryDomain(min, max);
    assert.ok(Number.isFinite(domain.min) && Number.isFinite(domain.max));
    assert.ok(domain.min < domain.max);
    assert.ok(domain.min <= min && domain.max >= max);
    assert.ok(domain.ticks.every(Number.isFinite));
    assert.ok(domain.step > 0 && Number.isFinite(domain.step));
  }
});

test('continuous-view bridges reference measured endpoints without adding readings or changing statistics', () => {
  const source = trace([{ x: 0, y: null }, { x: 1, y: 2 }, { x: 2, y: 3 }, { x: 3, y: null }, { x: 4, y: null }, { x: 5, y: 7 }, { x: 6, y: null }, { x: 7, y: 9 }, { x: 8, y: 10 }]);
  const before = JSON.stringify(source);
  const data = prepareTelemetry(source);
  const originalStats = { ...data.stats };
  data.points.forEach(Object.freeze);
  data.runs.forEach(Object.freeze);
  Object.freeze(data.points); Object.freeze(data.runs);
  const bridges = telemetryBridges(data.runs);
  assert.deepEqual(bridges.map(pair => pair.map(point => point.x)), [[2, 5], [5, 7]]);
  assert.equal(bridges[0][0], data.points[1]);
  assert.equal(bridges[0][1], data.points[2]);
  assert.equal(bridges[1][0], data.points[2]);
  assert.equal(data.points.length, 5);
  assert.deepEqual(data.stats, originalStats);
  assert.equal(JSON.stringify(source), before);
});

test('continuous display never extrapolates beyond measured runs or connects a single run', () => {
  const single = prepareTelemetry(trace([{ x: 0, y: null }, { x: 1, y: 2 }, { x: 2, y: 5 }, { x: 3, y: null }]));
  assert.deepEqual(telemetryBridges(single.runs), []);
  assert.deepEqual(telemetryBridges([]), []);
  assert.deepEqual(telemetryBridges([[], [{ x: 1, y: 2, sourceX: 1, sourceIndex: 0 }], []]), []);
});

test('preferred measurement remains selected across source cars and rail sides', () => {
  const named = name => ({ ...trace([]), name });
  const acv = [named('Car 02 cabin measurement'), named('Car 02 cooling target'), named('Car 02 cabin-minus-target residual')];
  assert.equal(telemetrySignalIndex(acv, telemetrySignalKey('Car 01 cooling target')), 1);
  const rail = [named('Side II: Car 08 position 6 vibration (largest RMS channel)'), named('Side II: Car 03 position 2 shock (largest RMS channel)')];
  assert.equal(telemetrySignalIndex(rail, telemetrySignalKey('Side I: Car 01 position 7 shock (largest RMS channel)')), 1);
  assert.equal(telemetrySignalIndex(acv, 'unavailable series'), 0);
  assert.equal(telemetrySignalIndex([], 'cooling target'), 0);
});
