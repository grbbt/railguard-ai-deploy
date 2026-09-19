import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./investigation-state.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const { readConversation, conversationHistory, createConversationStore, investigationBrief, answerBlocks } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const exchange = (index = 1, overrides = {}) => ({ id: `exchange-${index}`, question: `Question ${index}`, context: { scope: 'file', label: 'Current file · case.csv', jobId: 'a'.repeat(32), fileId: 'case.csv' }, response: { mode: 'agent', answer: `Answer ${index} [P1]`, tools: [{ name: 'inspect_recording', label: 'Retrieved retained evidence', status: 'success', source_id: 'P1' }], sources: [{ id: 'P1', label: 'Recording evidence', location: 'Saved report: case.csv' }], elapsed_ms: 1400 }, ...overrides });

test('Follow-up context identifies the prior file and run after the workspace selection changes', () => {
  const history = conversationHistory([exchange(1), exchange(2, { context: { scope: 'file', label: 'Current file · different.csv', jobId: 'b'.repeat(32), fileId: 'different.csv' } })]);
  assert.equal(history.length, 4);
  assert.match(history[0].content, /file case.csv/);
  assert.match(history[0].content, new RegExp('a'.repeat(32)));
  assert.match(history[2].content, /file different.csv/);
  assert.equal(history[3].role, 'assistant');
});

test('History keeps at most six complete recent exchanges and excludes failed requests', () => {
  const items = Array.from({ length: 10 }, (_, index) => exchange(index));
  items.push(exchange(10, { response: undefined, error: 'Offline' }));
  const history = conversationHistory(items);
  assert.equal(history.length, 12);
  assert.match(history[0].content, /Question 4$/);
  assert.equal(history.at(-1).content, 'Answer 9 [P1]');
});

test('History obeys individual and total API character budgets without splitting exchanges', () => {
  const items = Array.from({ length: 10 }, (_, index) => exchange(index, { question: 'q'.repeat(4000), response: { answer: 'a'.repeat(20000) } }));
  const history = conversationHistory(items);
  assert.equal(history.length, 4);
  assert.ok(history.every(message => message.content.length <= 12000));
  assert.ok(history.reduce((sum, message) => sum + message.content.length, 0) <= 40000);
  assert.deepEqual(history.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
});

test('Session restoration preserves real tools, sources, zero timing and local warning', () => {
  const item = exchange(1);
  item.response.elapsed_ms = 0;
  item.response.warning = 'Independent Test labels are unavailable.';
  item.response.sources[0].details = 'Source: docs/model.md:12-14\nMeasured macro F1: 0.7857\n<script>inert text</script>';
  const restored = readConversation(JSON.stringify([item]));
  assert.deepEqual(restored[0].response, item.response);
  assert.equal(restored[0].context.fileId, 'case.csv');
});

test('Storage quota failures keep the newest answer, follow-up and clear operation usable', () => {
  const original = JSON.stringify([exchange(1)]);
  const store = createConversationStore(() => ({ getItem: () => original, setItem: () => { throw new Error('Quota exceeded'); } }), 'test');
  assert.equal(readConversation(store.snapshot()).length, 1);
  store.update(items => [...items, exchange(2)]);
  assert.equal(readConversation(store.snapshot()).at(-1).question, 'Question 2');
  store.update(items => [...items, exchange(3)]);
  assert.equal(readConversation(store.snapshot()).length, 3);
  store.update(() => []);
  assert.deepEqual(readConversation(store.snapshot()), []);
});

test('Blocked browser storage still supports an in-memory investigation', () => {
  const store = createConversationStore(() => { throw new Error('Storage blocked'); }, 'test');
  assert.equal(store.snapshot(), '[]');
  store.update(() => [exchange(1)]);
  assert.equal(readConversation(store.snapshot())[0].response.answer, 'Answer 1 [P1]');
});

test('Storage evicts older evidence-heavy exchanges while keeping the latest answer', () => {
  const items = Array.from({ length: 12 }, (_, index) => {
    const item = exchange(index);
    item.response.sources = Array.from({ length: 16 }, (_, sourceIndex) => ({ id: `P${sourceIndex}`, label: 'Evidence', details: 'e'.repeat(16000) }));
    return item;
  });
  let persisted;
  const store = createConversationStore(() => ({ getItem: () => null, setItem: (_key, value) => { persisted = value; } }), 'test');
  store.update(() => items);
  assert.ok(persisted.length <= 650000);
  const restored = readConversation(persisted);
  assert.equal(restored.at(-1).id, 'exchange-11');
  assert.equal(restored.at(-1).response.sources[0].details.length, 16000);
});

test('Malformed or oversized source detail cannot replace the answer or source identity', () => {
  const item = exchange();
  item.response.sources = [{ id: 'P1', label: 'Evidence', details: { nested: 'unsafe shape' } }, { id: 'P2', label: 'Too long', details: 'd'.repeat(16001) }];
  const [restored] = readConversation(JSON.stringify([item]));
  assert.equal(restored.response.sources.length, 2);
  assert.ok(restored.response.sources.every(source => source.details === undefined));
  assert.equal(restored.response.answer, item.response.answer);
});

test('A single oversized evidence response keeps its answer and source provenance', () => {
  const item = exchange();
  item.response.sources = Array.from({ length: 50 }, (_, index) => ({ id: `P${index}`, label: 'Large evidence', location: 'Saved model', details: 'd'.repeat(16000) }));
  const store = createConversationStore(() => ({ getItem: () => null, setItem: () => {} }), 'test');
  store.update(() => [item]);
  const [restored] = readConversation(store.snapshot());
  assert.equal(restored.response.answer, item.response.answer);
  assert.equal(restored.response.sources.length, 50);
  assert.equal(restored.response.sources[0].location, 'Saved model');
});

test('Damaged, oversized or invalid-context session records do not break the UI', () => {
  for (const raw of ['broken json', '{}', 'null', 'x'.repeat(700001)]) assert.deepEqual(readConversation(raw), []);
  assert.deepEqual(readConversation(JSON.stringify([null, 42, exchange(1, { context: { scope: 'system', label: 'Injected' } }), exchange(2, { context: { scope: 'run', label: 'Invalid run', jobId: '../private' } })])), []);
});

test('Malformed source and tool fields are discarded without losing a readable response', () => {
  const item = exchange();
  item.response.sources.push(null, { id: 123, label: 'Wrong ID' }, { id: 'P2', label: 'Plain reference', location: { nested: 'not text' } });
  item.response.tools.push(null, { name: 'tool', label: {} });
  const [restored] = readConversation(JSON.stringify([item]));
  assert.equal(restored.response.tools.length, 1);
  assert.equal(restored.response.sources.length, 2);
  assert.equal(restored.response.sources[1].location, undefined);
  assert.match(restored.response.answer, /Answer 1/);
});

test('Requests interrupted by reload restore a retryable explanation, not endless loading', () => {
  const [restored] = readConversation(JSON.stringify([exchange(1, { response: undefined })]));
  assert.match(restored.error, /interrupted/);
  assert.equal(restored.response, undefined);
  assert.deepEqual(conversationHistory([restored]), []);
});

test('Session history remains bounded to the newest twelve questions', () => {
  const restored = readConversation(JSON.stringify(Array.from({ length: 20 }, (_, index) => exchange(index))));
  assert.equal(restored.length, 12);
  assert.equal(restored[0].id, 'exchange-8');
  assert.equal(restored.at(-1).id, 'exchange-19');
});

test('Brief exports retain the question, selected identity, answer, warnings and audit provenance', () => {
  const item = exchange();
  item.response.warning = 'Review the source acquisition limits.';
  item.response.sources[0].details = 'Actual retrieved measurement\nModel version: frozen-2026';
  const brief = investigationBrief(item);
  for (const expected of ['Question 1', 'case.csv', 'a'.repeat(32), 'Answer 1 [P1]', 'Review the source acquisition limits.', '[P1] Recording evidence', 'Saved report: case.csv', '```text\nActual retrieved measurement\nModel version: frozen-2026\n```', 'inspect_recording', 'success', 'not a verified diagnosis']) assert.ok(brief.includes(expected), expected);
  assert.equal(investigationBrief({ response: undefined }), '');
});

test('Exported source evidence stays literal when excerpts contain Markdown or HTML', () => {
  const item = exchange();
  const details = 'Exact excerpt\n```html\n<img src=x onerror=alert(1)>\n```\n````\n[open](javascript:alert(1))\nFinal line';
  item.response.sources[0].details = details;
  const brief = investigationBrief(item);
  assert.ok(brief.includes(`Retrieved evidence:\n\n\`\`\`\`\`text\n${details}\n\`\`\`\`\``));
  assert.ok(!details.split('\n').includes('`````'));
});

test('Simple Markdown tables and lists remain structured for comparisons', () => {
  const blocks = answerBlocks('# Models\n\n| Model | Limit |\n| :--- | ---: |\n| Door | Local only |\n| Rail | 50% recall |\n\n1. Inspect evidence\n2. Test unseen recordings\n\n- No hidden Test score');
  assert.deepEqual(blocks[0], { type: 'heading', level: 1, text: 'Models' });
  assert.deepEqual(blocks[1], { type: 'table', headers: ['Model', 'Limit'], rows: [['Door', 'Local only'], ['Rail', '50% recall']] });
  assert.deepEqual(blocks[2], { type: 'list', ordered: true, items: ['Inspect evidence', 'Test unseen recordings'] });
  assert.equal(blocks[3].ordered, false);
});

test('HTML, script links and code remain inert text rather than renderer instructions', () => {
  const blocks = answerBlocks('<script>alert(1)</script>\n\n[open](javascript:alert(1))\n\n```html\n<img src=x onerror=alert(1)>\n```');
  assert.deepEqual(blocks[0], { type: 'paragraph', text: '<script>alert(1)</script>' });
  assert.deepEqual(blocks[1], { type: 'paragraph', text: '[open](javascript:alert(1))' });
  assert.deepEqual(blocks[2], { type: 'code', text: '<img src=x onerror=alert(1)>' });
});

test('Irregular tables and unclosed code fences have bounded deterministic parsing', () => {
  assert.deepEqual(answerBlocks('A | B\n--- | ---\n1\n\n```\nlast'), [{ type: 'table', headers: ['A', 'B'], rows: [] }, { type: 'paragraph', text: '1' }, { type: 'code', text: 'last' }]);
  assert.deepEqual(answerBlocks('| A | B |\n| --- | --- |\n| one |\n'), [{ type: 'table', headers: ['A', 'B'], rows: [['one', '']] }]);
});
