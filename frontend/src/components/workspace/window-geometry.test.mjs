import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./window-geometry.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { initialWindowRect, clampWindowRect, resizeWindowRect, maximizedWindowRect } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const viewport = Object.freeze({ width: 1200, height: 900 });
const original = Object.freeze({ left: 200, top: 140, width: 430, height: 500 });
const right = rect => rect.left + rect.width;
const bottom = rect => rect.top + rect.height;

test('initial window uses desktop dimensions and clearances while fitting mobile width', () => {
  assert.deepEqual(initialWindowRect({ width: 1440, height: 1000 }), { left: 986, top: 236, width: 430, height: 680 });
  assert.deepEqual(initialWindowRect({ width: 390, height: 844 }), { left: 12, top: 80, width: 366, height: 680 });
  assert.deepEqual(initialWindowRect({ width: 600, height: 900 }), { left: 158, top: 136, width: 430, height: 680 });
  assert.deepEqual(initialWindowRect({ width: 601, height: 900 }), { left: 147, top: 136, width: 430, height: 680 });
});

test('clamping fits size before position and preserves minimum width and height', () => {
  assert.deepEqual(clampWindowRect({ left: -90, top: -20, width: 4000, height: 5000 }, viewport), { left: 12, top: 12, width: 1176, height: 876 });
  assert.deepEqual(clampWindowRect({ left: 1200, top: 900, width: 30, height: 20 }, viewport), { left: 848, top: 528, width: 340, height: 360 });
});

test('all edge and corner resizes leave every unrequested edge pinned', () => {
  for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    const result = resizeWindowRect(original, edge, 47, -38, viewport);
    if (!edge.includes('w')) assert.equal(result.left, original.left, `${edge}: left`);
    if (!edge.includes('e')) assert.equal(right(result), right(original), `${edge}: right`);
    if (!edge.includes('n')) assert.equal(result.top, original.top, `${edge}: top`);
    if (!edge.includes('s')) assert.equal(bottom(result), bottom(original), `${edge}: bottom`);
    assert.ok(result.width >= 340 && result.height >= 360);
  }
});

test('northwest growth stops at viewport margins without moving southeast anchor', () => {
  const result = resizeWindowRect(original, 'nw', -1e9, -1e9, viewport);
  assert.deepEqual(result, { left: 12, top: 12, width: 618, height: 628 });
  assert.equal(right(result), right(original));
  assert.equal(bottom(result), bottom(original));
});

test('southeast growth reaches the twelve-pixel margin without moving northwest anchor', () => {
  assert.deepEqual(resizeWindowRect(original, 'se', 1e9, 1e9, viewport), { left: 200, top: 140, width: 988, height: 748 });
});

test('huge inward overdrags hit minimum size without flipping or wandering', () => {
  assert.deepEqual(resizeWindowRect(original, 'nw', 1e9, 1e9, viewport), { left: 290, top: 280, width: 340, height: 360 });
  assert.deepEqual(resizeWindowRect(original, 'se', -1e9, -1e9, viewport), { left: 200, top: 140, width: 340, height: 360 });
  const grown = resizeWindowRect(original, 'e', 1e9, 0, viewport);
  const shrunk = resizeWindowRect(grown, 'e', -1e9, 0, viewport);
  assert.equal(shrunk.left, original.left);
  assert.equal(shrunk.width, 340);
});

test('small viewport reduces minimums to available space and preserves all margins', () => {
  const small = { width: 220, height: 200 };
  const expected = { left: 12, top: 12, width: 196, height: 176 };
  assert.deepEqual(initialWindowRect(small), expected);
  assert.deepEqual(maximizedWindowRect(small), expected);
  for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    assert.deepEqual(resizeWindowRect(expected, edge, 1e9, -1e9, small), expected);
  }
});

test('maximizing respects twelve-pixel margins on all four sides', () => {
  const result = maximizedWindowRect(viewport);
  assert.deepEqual(result, { left: 12, top: 12, width: 1176, height: 876 });
  assert.equal(viewport.height - bottom(result), 12);
  assert.deepEqual(clampWindowRect(result, viewport), result);
});

test('initial height shrinks above its preferred bottom inset while resizing can use that space', () => {
  const short = { width: 1200, height: 768 };
  const initial = initialWindowRect(short);
  assert.equal(initial.top, 12);
  assert.equal(initial.height, 672);
  assert.equal(short.height - bottom(initial), 84);
  const expanded = resizeWindowRect(initial, 's', 1000, 1000, short);
  assert.equal(expanded.top, 12);
  assert.equal(expanded.height, 744);
  assert.equal(short.height - bottom(expanded), 12);
});

test('nonfinite deltas do not resize, and invalid rectangles use finite defaults', () => {
  assert.deepEqual(resizeWindowRect(original, 'se', NaN, Infinity, viewport), original);
  assert.deepEqual(clampWindowRect({ left: NaN, top: Infinity, width: NaN, height: -Infinity }, viewport), { left: 12, top: 12, width: 430, height: 680 });
  assert.deepEqual(resizeWindowRect(original, 'invalid', 100, 100, viewport), original);
});

test('impossibly small or invalid viewports retain a finite nonnegative one-pixel region', () => {
  for (const size of [{ width: 10, height: 30 }, { width: 0, height: 0 }, { width: -1, height: -1 }, { width: NaN, height: Infinity }]) {
    const rect = initialWindowRect(size);
    assert.ok(Object.values(rect).every(Number.isFinite));
    assert.ok(rect.left >= 0 && rect.top >= 0);
    assert.ok(rect.width >= 1 && rect.height >= 1);
    if (size.width > 0 && Number.isFinite(size.width)) assert.ok(right(rect) <= size.width);
    if (size.height > 0 && Number.isFinite(size.height)) assert.ok(bottom(rect) <= size.height);
    assert.deepEqual(clampWindowRect(rect, size), rect);
  }
});
