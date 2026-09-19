import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import ts from 'typescript';

function moduleUrl(filename) {
  const source = readFileSync(new URL(filename, import.meta.url), 'utf8');
  let compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
  if (filename === './upload-request.ts') compiled = compiled.replace("'./request-error'", JSON.stringify(moduleUrl('./request-error.ts')));
  return `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
}
const { prepareUploadPayload, uploadRecordings } = await import(moduleUrl('./upload-request.ts'));
const gzip = { uploadEncodings: ['identity', 'gzip'] };
const csvBytes = () => new TextEncoder().encode('1,2,3,4\r\n'.repeat(140_000));
const csv = (name = 'recording.csv') => new File([csvBytes()], name, { type: 'text/csv', lastModified: 1234 });
const bytes = async file => new Uint8Array(await file.arrayBuffer());

test('servers without gzip capability retain the legacy multipart fields and original CSV bytes', async () => {
  for (const uploadEncodings of [undefined, [], ['identity']]) {
    const original = csv();
    const prepared = await prepareUploadPayload([original], 'rail', { uploadEncodings });
    assert.deepEqual([...prepared.body.keys()], ['subsystem', 'files']);
    assert.equal(prepared.body.get('subsystem'), 'rail');
    assert.equal(prepared.body.get('files').name, original.name);
    assert.deepEqual(await bytes(prepared.body.get('files')), await bytes(original));
    assert.equal(prepared.compressedFiles, 0);
    assert.equal(prepared.originalBytes, prepared.payloadBytes);
  }
});

test('a browser without CompressionStream sends identity even when the server supports gzip', async () => {
  const constructor = globalThis.CompressionStream;
  try {
    globalThis.CompressionStream = undefined;
    const original = csv();
    const prepared = await prepareUploadPayload([original], 'door', gzip);
    assert.equal(prepared.body.get('file_encodings'), '["identity"]');
    assert.equal(prepared.body.get('files').name, original.name);
    assert.equal(prepared.payloadBytes, original.size);
  } finally { globalThis.CompressionStream = constructor; }
});

test('small CSV and already compressed XLSX are unchanged', async () => {
  const originals = [new File(['a,b\n1,2\n'], 'small.csv'), new File([csvBytes()], 'complete-case.xlsx')];
  const prepared = await prepareUploadPayload(originals, 'acv', gzip);
  assert.equal(prepared.body.get('file_encodings'), '["identity","identity"]');
  assert.equal(prepared.compressedFiles, 0);
  for (const [index, file] of prepared.body.getAll('files').entries()) {
    assert.equal(file.name, originals[index].name);
    assert.deepEqual(await bytes(file), await bytes(originals[index]));
  }
});

test('gzip transport has an explicit suffix, aligned encodings and exact byte-for-byte decompression', async () => {
  const large = csv('Case.CSV');
  const small = new File(['3,4\n'], 'small.csv');
  const originalBytes = await bytes(large);
  const prepared = await prepareUploadPayload([large, small], 'rail', gzip);
  const [compressed, identity] = prepared.body.getAll('files');
  assert.equal(compressed.name, 'Case.CSV.gz');
  assert.equal(compressed.type, 'application/gzip');
  assert.equal(identity.name, 'small.csv');
  assert.deepEqual(JSON.parse(prepared.body.get('file_encodings')), ['gzip', 'identity']);
  const restored = await new Response(compressed.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  assert.deepEqual(new Uint8Array(restored), originalBytes);
  assert.deepEqual(await bytes(large), originalBytes);
  assert.equal(large.name, 'Case.CSV');
  assert.equal(large.lastModified, 1234);
  assert.equal(prepared.originalBytes, large.size + small.size);
  assert.equal(prepared.payloadBytes, compressed.size + identity.size);
  assert.ok(prepared.payloadBytes < prepared.originalBytes);
  assert.equal(prepared.compressedFiles, 1);
});

test('incompressible CSV falls back to original identity rather than increasing transfer size', async () => {
  const original = new File([randomBytes(1024 ** 2)], 'uncompressible.csv');
  const prepared = await prepareUploadPayload([original], 'shm', gzip);
  assert.equal(prepared.body.get('file_encodings'), '["identity"]');
  assert.equal(prepared.body.get('files').name, original.name);
  assert.equal(prepared.payloadBytes, original.size);
  assert.equal(prepared.compressedFiles, 0);
  assert.deepEqual(await bytes(prepared.body.get('files')), await bytes(original));
});

test('CSV preparation is sequential and reports the current filename and count', async () => {
  const events = [];
  class ObservedFile extends File {
    stream() {
      events.push(`start ${this.name}`);
      const name = this.name;
      return super.stream().pipeThrough(new TransformStream({ flush() { events.push(`end ${name}`); } }));
    }
  }
  const files = ['first.csv', 'second.csv'].map(name => new ObservedFile([csvBytes()], name));
  await prepareUploadPayload(files, 'rail', { ...gzip, onProgress: progress => {
    assert.equal(progress.phase, 'preparing');
    assert.equal(progress.fileCount, 2);
    events.push(`prepare ${progress.fileIndex} ${progress.fileName}`);
  } });
  assert.deepEqual(events, ['prepare 1 first.csv', 'start first.csv', 'end first.csv', 'prepare 2 second.csv', 'start second.csv', 'end second.csv']);
});

test('optional compression failures safely retain the original file', async () => {
  const constructor = globalThis.CompressionStream;
  try {
    globalThis.CompressionStream = class { constructor() { throw new Error('gzip unavailable'); } };
    const original = csv();
    const prepared = await prepareUploadPayload([original], 'rail', gzip);
    assert.equal(prepared.body.get('file_encodings'), '["identity"]');
    assert.deepEqual(await bytes(prepared.body.get('files')), await bytes(original));
  } finally { globalThis.CompressionStream = constructor; }
});

test('cancelled preparation stops an active stream and does not continue to the next file', async () => {
  const abort = new AbortController();
  let cancelled = false;
  class SlowFile extends File {
    stream() {
      return new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); }, cancel() { cancelled = true; } });
    }
  }
  const preparedNames = [];
  const pending = prepareUploadPayload([new SlowFile([csvBytes()], 'slow.csv'), csv('next.csv')], 'rail', {
    ...gzip, signal: abort.signal, onProgress: progress => preparedNames.push(progress.fileName),
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  await rejected;
  assert.equal(cancelled, true);
  assert.deepEqual(preparedNames, ['slow.csv']);
});

class FakeRequest {
  upload = {};
  status = 0;
  responseText = '';
  timeout = 0;
  sends = [];
  aborts = 0;
  open(method, url) { this.opened = { method, url }; }
  send(body) { this.sends.push(body); }
  abort() { this.aborts += 1; this.onabort?.(); }
  progress(loaded, total, lengthComputable = true) { this.upload.onprogress?.({ loaded, total, lengthComputable }); }
  sent(loaded, total, lengthComputable = true) { this.upload.onload?.({ loaded, total, lengthComputable }); }
  respond(status, body) { this.status = status; this.responseText = body; this.onload?.(); }
}
function uploadFixture(options = {}) {
  const request = new FakeRequest();
  const progress = [];
  let time = 0, factories = 0;
  const body = new FormData();
  const pending = uploadRecordings(body, {
    requestFactory: () => { factories += 1; return request; },
    now: () => time, onProgress: value => progress.push(value), ...options,
  });
  return { request, progress, pending, body, time: value => { time = value; }, factories: () => factories };
}

test('actual multipart bytes drive progress, measured rate and ETA; all bytes sent is not acceptance', async () => {
  const fixture = uploadFixture();
  assert.deepEqual(fixture.request.opened, { method: 'POST', url: '/api/ps3/jobs' });
  assert.equal(fixture.request.timeout, 660_000);
  assert.equal(fixture.request.sends[0], fixture.body);
  assert.deepEqual(fixture.progress[0], { phase: 'uploading', loadedBytes: 0, totalBytes: null, bytesPerSecond: null, etaSeconds: null });
  fixture.time(1000);
  fixture.request.progress(500, 1000);
  assert.deepEqual(fixture.progress.at(-1), { phase: 'uploading', loadedBytes: 500, totalBytes: 1000, bytesPerSecond: 500, etaSeconds: 1 });
  fixture.time(2000);
  fixture.request.sent(1000, 1000);
  assert.equal(fixture.progress.at(-1).phase, 'waiting');
  assert.equal(fixture.progress.at(-1).loadedBytes, 1000);
  let accepted = false;
  fixture.pending.then(() => { accepted = true; });
  await Promise.resolve();
  assert.equal(accepted, false);
  fixture.request.respond(202, '{"id":"accepted-job_1"}');
  assert.equal(await fixture.pending, 'accepted-job_1');
  assert.equal(fixture.request.onload, null);
  assert.equal(fixture.request.upload.onprogress, null);
  assert.equal(fixture.request.sends.length, 1);
});

test('unknown transfer length does not invent a total or ETA, and brief samples do not invent a rate', async () => {
  const fixture = uploadFixture();
  fixture.time(10);
  fixture.request.progress(100, 500, false);
  assert.equal(fixture.progress.at(-1).totalBytes, null);
  assert.equal(fixture.progress.at(-1).bytesPerSecond, null);
  assert.equal(fixture.progress.at(-1).etaSeconds, null);
  fixture.time(1000);
  fixture.request.progress(400, 1000, false);
  assert.equal(fixture.progress.at(-1).loadedBytes, 400);
  assert.equal(fixture.progress.at(-1).totalBytes, null);
  assert.equal(fixture.progress.at(-1).bytesPerSecond, 400);
  assert.equal(fixture.progress.at(-1).etaSeconds, null);
  fixture.request.respond(202, '{"id":"ok"}');
  await fixture.pending;
});

test('only 202 with a safe nonempty job identity confirms acceptance', async () => {
  for (const [status, body] of [[200, '{"id":"exists"}'], [204, ''], [202, 'null'], [202, '{}'], [202, '{"id":""}'], [202, '{"id":"../bad"}'], [202, '<html>private</html>']]) {
    const fixture = uploadFixture();
    const rejected = assert.rejects(fixture.pending, error => {
      assert.match(error.message, /confirm|confirmation/);
      assert.match(error.message, /Check saved analyses before retrying/);
      assert.doesNotMatch(error.message, /private|<html>/);
      return true;
    });
    fixture.request.respond(status, body);
    await rejected;
    assert.equal(fixture.factories(), 1);
    assert.equal(fixture.request.sends.length, 1);
  }
});

test('API validation details and safe HTML error fallbacks survive XHR without a second POST', async () => {
  for (const [status, body, expected] of [[422, '{"detail":"Keep every car in the workbook."}', /Keep every car/], [413, '<html>private trace</html>', /server or hosting size limit/], [502, '<html>private trace</html>', /server or hosting proxy/]]) {
    const fixture = uploadFixture();
    const rejected = assert.rejects(fixture.pending, error => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /private trace|<html>/);
      return true;
    });
    fixture.request.respond(status, body);
    await rejected;
    assert.equal(fixture.factories(), 1);
    assert.equal(fixture.request.sends.length, 1);
  }
});

test('network loss and timeout warn about uncertain acceptance without retrying the POST', async () => {
  for (const event of ['onerror', 'ontimeout']) {
    const fixture = uploadFixture();
    const rejected = assert.rejects(fixture.pending, /Check saved analyses before retrying/);
    fixture.request[event]();
    await rejected;
    assert.equal(fixture.request.sends.length, 1);
    assert.equal(fixture.factories(), 1);
  }
});

test('an already aborted operation neither prepares files nor constructs an XHR', async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(prepareUploadPayload([csv()], 'rail', { ...gzip, signal: abort.signal }), { name: 'AbortError' });
  const fixture = uploadFixture({ signal: abort.signal });
  await assert.rejects(fixture.pending, { name: 'AbortError' });
  assert.equal(fixture.factories(), 0);
  assert.equal(fixture.request.sends.length, 0);
});

test('in-flight cancellation aborts once, cleans listeners and never confirms a late response', async () => {
  const abort = new AbortController();
  const fixture = uploadFixture({ signal: abort.signal });
  const rejected = assert.rejects(fixture.pending, error => error.name === 'AbortError' && /saved analyses/.test(error.message));
  fixture.request.sent(1000, 1000);
  abort.abort();
  await rejected;
  fixture.request.respond(202, '{"id":"late"}');
  assert.equal(fixture.request.aborts, 1);
  assert.equal(fixture.request.onload, null);
  assert.equal(fixture.request.upload.onload, null);
  assert.equal(fixture.request.sends.length, 1);
});

test('cancellation during the initial progress callback cannot send a POST afterwards', async () => {
  const abort = new AbortController();
  const fixture = uploadFixture({ signal: abort.signal, onProgress: () => abort.abort() });
  await assert.rejects(fixture.pending, { name: 'AbortError' });
  assert.equal(fixture.request.sends.length, 0);
});

test('a completed upload removes its signal listener so later cancellation cannot affect it', async () => {
  const abort = new AbortController();
  const fixture = uploadFixture({ signal: abort.signal });
  fixture.request.respond(202, '{"id":"finished"}');
  assert.equal(await fixture.pending, 'finished');
  abort.abort();
  assert.equal(fixture.request.aborts, 0);
});
