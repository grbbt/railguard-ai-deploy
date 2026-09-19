import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('./ps3-upload-proxy.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { forwardPs3Jobs, MAX_UPLOAD_REQUEST_BYTES } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const type = 'multipart/form-data; boundary=RailGuardTestBoundary';

function upload(body = 'recording', headers = {}, signal) {
  return new Request('http://frontend.test/api/ps3/jobs', {
    method: 'POST', body, duplex: 'half', signal,
    headers: { 'Content-Type': type, ...headers },
  });
}

async function server(t, listener) {
  const instance = createServer(listener);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return `http://127.0.0.1:${instance.address().port}`;
}

test('a complete multipart upload above 10 MiB reaches the API byte-for-byte', async t => {
  const body = Buffer.concat([
    Buffer.from('--RailGuardTestBoundary\r\nContent-Disposition: form-data; name="subsystem"\r\n\r\nrail\r\n--RailGuardTestBoundary\r\nContent-Disposition: form-data; name="files"; filename="Test1.csv"\r\nContent-Type: text/csv\r\n\r\n'),
    Buffer.alloc(17 * 1024 ** 2, '7'),
    Buffer.from('\r\n--RailGuardTestBoundary--\r\n'),
  ]);
  let received = 0;
  let seenHeaders;
  let seenPath;
  let digest;
  const base = await server(t, async (req, res) => {
    const hash = createHash('sha256');
    seenHeaders = req.headers;
    seenPath = req.url;
    for await (const chunk of req) { received += chunk.length; hash.update(chunk); }
    digest = hash.digest('hex');
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'accepted-once' }));
  });
  let position = 0;
  const stream = new ReadableStream({ pull(controller) {
    if (position === body.length) { controller.close(); return; }
    const end = Math.min(body.length, position + 64 * 1024);
    controller.enqueue(body.subarray(position, end)); position = end;
  } });
  const result = await forwardPs3Jobs(upload(stream, {
    'Content-Length': String(body.length), Cookie: 'private=do-not-forward',
    Authorization: 'Bearer do-not-forward', 'X-Forwarded-Host': 'untrusted.invalid',
  }), base);
  assert.equal(result.status, 202);
  assert.deepEqual(await result.json(), { id: 'accepted-once' });
  assert.equal(received, body.length);
  assert.equal(digest, createHash('sha256').update(body).digest('hex'));
  assert.equal(seenPath, '/api/ps3/jobs');
  assert.equal(seenHeaders['content-type'], type);
  assert.equal(seenHeaders.cookie, undefined);
  assert.equal(seenHeaders.authorization, undefined);
  assert.equal(seenHeaders['x-forwarded-host'], undefined);
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('listing saved analyses preserves query filters and a configured backend base path', async () => {
  let seen;
  const result = await forwardPs3Jobs(new Request('https://frontend.test/api/ps3/jobs?limit=40&subsystem=rail'), 'http://backend.test/prefix/', {
    fetcher: async (url, init) => { seen = { url: url.href, init }; return Response.json({ jobs: [] }); },
  });
  assert.equal(seen.url, 'http://backend.test/prefix/api/ps3/jobs?limit=40&subsystem=rail');
  assert.equal(seen.init.method, 'GET');
  assert.equal(seen.init.body, undefined);
  assert.equal(seen.init.cache, 'no-store');
  assert.deepEqual(await result.json(), { jobs: [] });
});

test('API validation, size and capacity errors retain their status and safe JSON details', async () => {
  for (const status of [409, 413, 422, 429, 503]) {
    const result = await forwardPs3Jobs(upload(), 'http://backend.test', {
      fetcher: async (_url, init) => {
        await new Response(init.body).text();
        return Response.json({ detail: `API message ${status}` }, { status, headers: { 'Retry-After': '10' } });
      },
    });
    assert.equal(result.status, status);
    assert.deepEqual(await result.json(), { detail: `API message ${status}` });
    assert.equal(result.headers.get('retry-after'), '10');
  }
});

test('oversized declared bodies and malformed lengths fail before contacting the API', async () => {
  assert.equal(MAX_UPLOAD_REQUEST_BYTES, 1501 * 1024 ** 2);
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error('Should not contact API'); };
  const oversized = await forwardPs3Jobs(upload('x', { 'Content-Length': String(MAX_UPLOAD_REQUEST_BYTES + 1) }), 'http://backend.test', { fetcher });
  assert.equal(oversized.status, 413);
  assert.match((await oversized.json()).detail, /complete files/);
  const invalid = await forwardPs3Jobs(upload('x', { 'Content-Length': 'not-a-number' }), 'http://backend.test', { fetcher });
  assert.equal(invalid.status, 400);
  assert.equal(calls, 0);
});

test('chunked uploads are counted and rejected when the declared length is missing or too small', async () => {
  for (const headers of [{}, { 'Content-Length': '1' }]) {
    let count = 0;
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(8)); if (++count === 4) controller.close(); } });
    const result = await forwardPs3Jobs(upload(body, headers), 'http://backend.test', {
      maxRequestBytes: 16,
      fetcher: async (_url, init) => { await new Response(init.body).arrayBuffer(); return Response.json({}); },
    });
    assert.equal(result.status, 413);
  }
});

test('a request exactly at the byte limit is forwarded without truncation', async () => {
  const result = await forwardPs3Jobs(upload('12345678'), 'http://backend.test', {
    maxRequestBytes: 8,
    fetcher: async (_url, init) => Response.json({ received: await new Response(init.body).text() }, { status: 202 }),
  });
  assert.equal(result.status, 202);
  assert.deepEqual(await result.json(), { received: '12345678' });
});

test('the deadline includes reading the API response body', async t => {
  const base = await server(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{'); // Keep the metadata response open until the proxy cancels it.
  });
  const result = await forwardPs3Jobs(new Request('http://frontend.test/api/ps3/jobs'), base, { timeoutMs: 50 });
  assert.equal(result.status, 504);
  assert.match((await result.json()).detail, /Check saved analyses before retrying/);
});

test('client disconnection cancels the upstream request without retrying', async () => {
  const client = new AbortController();
  let calls = 0;
  let upstreamAborted = false;
  const resultPromise = forwardPs3Jobs(upload('body', {}, client.signal), 'http://backend.test', {
    fetcher: (_url, init) => new Promise((_resolve, reject) => {
      calls++;
      init.signal.addEventListener('abort', () => { upstreamAborted = true; reject(new Error('Disconnected')); }, { once: true });
    }),
  });
  client.abort();
  const result = await resultPromise;
  assert.equal(result.status, 499);
  assert.equal(upstreamAborted, true);
  assert.equal(calls, 1);
});

test('network failures and unexpected upstream HTML do not expose internal diagnostics or retry POST', async () => {
  for (const fetcher of [async () => { throw new Error('private-backend:8000 secret'); }, async () => new Response('<html>secret stack trace</html>', { status: 500 })]) {
    let calls = 0;
    const result = await forwardPs3Jobs(upload(), 'http://private-backend:8000', { fetcher: (...args) => { calls++; return fetcher(...args); } });
    assert.equal(result.status, 502);
    assert.doesNotMatch(await result.text(), /secret|private-backend|stack trace/);
    assert.equal(calls, 1);
  }
});

test('upstream redirects cannot forward recording data to another destination', async t => {
  let redirected = 0;
  const base = await server(t, (req, res) => {
    if (req.url === '/redirect-target') { redirected++; res.end('unexpected'); return; }
    req.resume();
    res.writeHead(307, { Location: '/redirect-target' }); res.end();
  });
  const result = await forwardPs3Jobs(upload(), base);
  assert.equal(result.status, 502);
  assert.equal(redirected, 0);
});

test('only configured HTTP(S) backends and multipart upload requests are accepted', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({}); };
  for (const url of ['file:///etc/passwd', 'http://user:password@backend.test', 'invalid', 'http://backend.test?secret=x']) {
    const result = await forwardPs3Jobs(upload(), url, { fetcher });
    assert.equal(result.status, 503);
    assert.doesNotMatch(await result.text(), /password|secret=x|passwd/);
  }
  assert.equal((await forwardPs3Jobs(upload('body', { 'Content-Type': 'application/json' }), 'http://backend.test', { fetcher })).status, 415);
  assert.equal((await forwardPs3Jobs(new Request('http://frontend.test/api/ps3/jobs', { method: 'DELETE' }), 'http://backend.test', { fetcher })).status, 405);
  assert.equal(calls, 0);
});
