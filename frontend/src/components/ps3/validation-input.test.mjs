import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

async function actualModule(filename) {
  const source = readFileSync(new URL(filename, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}
const { rankingSummary } = await actualModule('./ranking-metrics.ts');
const { prepareUploadFiles } = await actualModule('./upload-files.ts');
const limits = { file_mb: 64, batch_files: 100, batch_mb: 1500 };
const file = (name, size = 1024) => ({ name, size });

test('first-choice accuracy comes from correct-case counts, separately from rank-decay', () => {
  const summary = rankingSummary({ cases: 6, top1_correct: 4, top2_correct: 6, mean_rank: 8 / 6 });
  assert.equal(summary.top1.correct, 4);
  assert.equal(summary.top2.correct, 6);
  assert.equal(summary.top1.percent, 100 * 4 / 6);
  assert.equal(summary.top2.percent, 100);
  assert.equal(summary.meanRank, 8 / 6);
});

test('missing counts cannot be reconstructed from a high ranking score or folds', () => {
  assert.equal(rankingSummary(undefined), null);
  assert.equal(rankingSummary(null), null);
  assert.equal(rankingSummary({ score: .958333, folds: [{ true_car_rank: 1 }] }), null);
});

test('zero correct cases stays zero while contradictory or nonfinite counts are unavailable', () => {
  assert.equal(rankingSummary({ cases: 6, top1_correct: 0, top2_correct: 0 }).top1.percent, 0);
  for (const invalid of [
    { cases: 0, top1_correct: 0, top2_correct: 0 },
    { cases: 6, top1_correct: 5, top2_correct: 4 },
    { cases: 6, top1_correct: 4, top2_correct: 7 },
    { cases: 6, top1_correct: 4.5, top2_correct: 6 },
    { cases: Infinity, top1_correct: 4, top2_correct: 6 },
  ]) assert.equal(rankingSummary(invalid), null);
});

test('multiple ACV workbooks can be selected at once or added across selections', () => {
  const first = file('case01.xlsx'), second = file('case02.xlsx');
  assert.deepEqual(prepareUploadFiles('acv', [], [first, second], limits), { files: [first, second], error: '' });
  assert.deepEqual(prepareUploadFiles('acv', [first], [second], limits), { files: [first, second], error: '' });
});

test('ACV duplicate names and CSV inputs do not replace a valid workbook selection', () => {
  const first = file('case01.xlsx');
  const duplicate = prepareUploadFiles('acv', [first], [file('CASE01.XLSX')], limits);
  assert.match(duplicate.error, /duplicate/);
  assert.deepEqual(duplicate.files, [first]);
  const csv = prepareUploadFiles('acv', [first], [file('Train.csv')], limits);
  assert.match(csv.error, /CSV files are not ACV workbooks/);
  assert.deepEqual(csv.files, [first]);
});

test('Door remains a single continuous stream and selecting a new stream replaces the old selection', () => {
  const first = file('first.csv'), second = file('second.csv');
  assert.match(prepareUploadFiles('door', [], [first, second], limits).error, /one continuous Door stream/);
  assert.deepEqual(prepareUploadFiles('door', [first], [second], limits), { files: [second], error: '' });
});

test('ACV batch counts, file sizes and combined size retain their existing limits', () => {
  assert.match(prepareUploadFiles('acv', [], [file('one.xlsx'), file('two.xlsx')], { ...limits, batch_files: 1 }).error, /file limit/);
  assert.match(prepareUploadFiles('acv', [], [file('empty.xlsx', 0)], limits).error, /Empty/);
  assert.match(prepareUploadFiles('acv', [], [file('large.xlsx', 65 * 1024 ** 2)], limits).error, /64 MB limit/);
  assert.match(prepareUploadFiles('acv', [], [file('one.xlsx', 1024 ** 2), file('two.xlsx', 1024 ** 2)], { ...limits, batch_mb: 1 }).error, /total limit/);
});
