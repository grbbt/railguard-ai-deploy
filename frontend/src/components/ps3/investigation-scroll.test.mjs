import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./investigation-scroll.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { createQuestionScrollAnchor } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const question = top => ({ style: { minHeight: '' }, getBoundingClientRect: () => ({ top }) });
const viewport = () => ({ scrollTop: 75, clientTop: 2, clientHeight: 420, getBoundingClientRect: () => ({ top: 100 }) });

test('submission anchors the prompt inside its own scroll viewport, accounting for border and existing scroll', () => {
  const anchor = createQuestionScrollAnchor();
  const container = viewport();
  const prompt = question(700);
  anchor.request('new');
  assert.equal(anchor.apply('new', container, prompt), true);
  assert.equal(container.scrollTop, 673);
  assert.equal(prompt.style.minHeight, '420px');
  assert.equal(anchor.pendingId, null);
});

test('response completion, repeated renders and reopening cannot override manual scrolling', () => {
  const anchor = createQuestionScrollAnchor();
  const container = viewport();
  const prompt = question(700);
  anchor.request('new');
  anchor.apply('new', container, prompt);
  container.scrollTop = 230; // Reader moves while the response is running.
  for (let update = 0; update < 4; update++) assert.equal(anchor.apply('new', container, prompt), false);
  assert.equal(container.scrollTop, 230);
  assert.equal(prompt.style.minHeight, '420px', 'completion must not collapse the remaining room');
});

test('a loading answer gets enough room below it for the prompt to reach the top', () => {
  const anchor = createQuestionScrollAnchor();
  const prompt = question(500);
  let scrollTop = 0;
  const container = {
    clientTop: 0, clientHeight: 420, getBoundingClientRect: () => ({ top: 0 }),
    get scrollTop() { return scrollTop; },
    set scrollTop(value) { scrollTop = Math.min(value, 500 + Math.max(80, Number.parseFloat(prompt.style.minHeight) || 0) - 420); },
  };
  anchor.request('short');
  anchor.apply('short', container, prompt);
  assert.equal(scrollTop, 500, 'browser scroll bounds must allow full prompt alignment');
});

test('standalone conversation can reserve its capped height and the next submission releases old padding', () => {
  const anchor = createQuestionScrollAnchor();
  const first = question(400);
  const next = question(650);
  const container = viewport();
  anchor.request('first');
  anchor.apply('first', container, first, 760);
  assert.equal(first.style.minHeight, '760px');
  anchor.request('next');
  assert.equal(anchor.apply('first', container, first), false, 'a stale exchange cannot consume a new request');
  anchor.apply('next', container, next);
  assert.equal(first.style.minHeight, '');
  assert.equal(next.style.minHeight, '420px');
});

test('closing before a layout consumes the pending request so reopening cannot jump', () => {
  const anchor = createQuestionScrollAnchor();
  const container = viewport();
  anchor.request('pending');
  anchor.cancel();
  assert.equal(anchor.apply('pending', container, question(700)), false);
  assert.equal(container.scrollTop, 75);
});

test('a hidden viewport cannot consume an anchor and a missing CSS cap falls back to measured height', () => {
  const anchor = createQuestionScrollAnchor();
  const container = viewport();
  const prompt = question(20);
  anchor.request('pending');
  container.clientHeight = 0;
  assert.equal(anchor.apply('pending', container, prompt), false);
  assert.equal(anchor.pendingId, 'pending');
  container.clientHeight = 420;
  anchor.apply('pending', container, prompt, NaN);
  assert.equal(prompt.style.minHeight, '420px');
  assert.equal(container.scrollTop, 0);
});
