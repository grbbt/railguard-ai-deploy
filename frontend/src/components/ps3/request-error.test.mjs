import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

async function actualModule(filename) {
  const source = readFileSync(new URL(filename, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}
const { errorMessage } = await actualModule('./request-error.ts');
const jsonResponse = (body, status = 422) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
const html = '<!DOCTYPE html><html><body>Private proxy diagnostic: upstream-42</body></html>';

test('specific backend JSON detail takes precedence over message and HTTP fallbacks', async () => {
  for (const status of [413, 422, 500, 502, 503, 504]) {
    assert.equal(await errorMessage(jsonResponse({ detail: 'Each file must be at most 64 MB.', message: 'Other message' }, status)), 'Each file must be at most 64 MB.');
  }
});

test('backend JSON message is retained when detail is absent, null or blank', async () => {
  for (const detail of [undefined, null, '', '  ', 12]) {
    assert.equal(await errorMessage(jsonResponse({ detail, message: 'This run no longer exists.' }, 404)), 'This run no longer exists.');
  }
});

test('backend validation error messages retain their order', async () => {
  const detail = [{ loc: ['body', 'files'], msg: 'At least one file is required' }, { loc: ['body', 'subsystem'], msg: 'Choose a supported subsystem' }];
  assert.equal(await errorMessage(jsonResponse({ detail })), 'At least one file is required. Choose a supported subsystem');
});

test('malformed validation entries do not hide valid messages or stringify objects', async () => {
  const detail = [null, false, 3, 'unexpected', {}, { msg: null }, { msg: { private: 'internal data' } }, { msg: '' }, { msg: '  ' }, { msg: 'The recording is empty' }];
  assert.equal(await errorMessage(jsonResponse({ detail })), 'The recording is empty');
});

test('null, primitive and array JSON bodies produce a nonempty HTTP fallback', async () => {
  for (const body of [null, false, 42, 'upstream diagnostic', [], ['unexpected']]) {
    const message = await errorMessage(jsonResponse(body, 502));
    assert.match(message, /server or hosting proxy/);
    assert.match(message, /502/);
    assert.doesNotMatch(message, /diagnostic|unexpected|local/i);
  }
});

test('empty or unusable JSON messages use the HTTP fallback', async () => {
  for (const body of [{}, { detail: '' }, { message: '  ' }, { detail: [] }, { detail: [null, {}] }, { detail: { msg: 'nested' } }]) {
    const message = await errorMessage(jsonResponse(body, 400));
    assert.match(message, /request failed \(400\)/);
    assert.doesNotMatch(message, /local|nested/);
  }
});

test('HTML or empty 413 responses explain hosting limits and suggest a smaller upload', async () => {
  for (const body of [html, '', null, '{"detail":']) {
    const message = await errorMessage(new Response(body, { status: 413 }));
    assert.match(message, /server or hosting size limit \(413\)/);
    assert.match(message, /smaller batch of complete files/);
    assert.match(message, /one intact file/);
    assert.doesNotMatch(message, /<|upstream-42|local/);
  }
});

test('non-JSON server errors identify the service or proxy without guessing the cause', async () => {
  for (const status of [500, 502, 503, 504]) {
    const message = await errorMessage(new Response(html, { status, headers: { 'Content-Type': 'text/html' } }));
    assert.match(message, /server or hosting proxy/);
    assert.ok(message.includes(`(${status})`));
    assert.match(message, /service logs/);
    assert.doesNotMatch(message, /<|upstream-42|local|memory|CORS|restart|timed out/i);
  }
});

test('empty, malformed and plain-text error bodies retain HTTP status without raw content', async () => {
  for (const body of [null, '', '{"detail":', 'Private proxy diagnostic']) {
    const message = await errorMessage(new Response(body, { status: 403 }));
    assert.match(message, /request failed \(403\)/);
    assert.doesNotMatch(message, /detail|Private|proxy diagnostic|local/);
  }
});

test('an unreadable response body still returns its HTTP status', async () => {
  const response = jsonResponse({ detail: 'Already consumed' }, 503);
  await response.text();
  const message = await errorMessage(response);
  assert.match(message, /server or hosting proxy/);
  assert.match(message, /503/);
});
