/** Stream multipart recordings; only the small job metadata response is buffered. */
export const MAX_UPLOAD_REQUEST_BYTES = 1501 * 1024 ** 2;
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEST_LIMIT_DETAIL = 'Uploads are limited to 1,500 MiB per batch. Split the batch into complete files and try again.';
const RESPONSE_HEADERS = { 'Cache-Control': 'no-store', 'X-RailGuard-Upload-Transport': 'stream-v1' };

type ProxyOptions = {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxRequestBytes?: number;
};

function failure(status: number, detail: string) {
  return Response.json({ detail }, { status, headers: RESPONSE_HEADERS });
}

export async function forwardPs3Jobs(request: Request, backendBase: string, options: ProxyOptions = {}): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return failure(405, 'Use GET to list analyses or POST to upload recordings.');
  }
  let upstream: URL;
  try {
    const base = new URL(backendBase);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid backend URL');
    upstream = new URL(`${base.href.replace(/\/+$/, '')}/api/ps3/jobs`);
    if (request.method === 'GET') upstream.search = new URL(request.url).search;
  } catch {
    return failure(503, 'The analysis service address is not configured correctly. Contact the server administrator.');
  }

  const maxRequestBytes = options.maxRequestBytes ?? MAX_UPLOAD_REQUEST_BYTES;
  const headers = new Headers({ Accept: 'application/json' });
  if (request.method === 'POST') {
    const contentType = request.headers.get('content-type') ?? '';
    if (!/^multipart\/form-data\s*;/i.test(contentType) || !/\bboundary=/i.test(contentType) || !request.body) {
      return failure(415, 'Upload recordings using multipart form data.');
    }
    const contentLength = request.headers.get('content-length');
    if (contentLength !== null) {
      if (!/^\d+$/.test(contentLength)) return failure(400, 'The upload has an invalid Content-Length.');
      if (Number(contentLength) > maxRequestBytes) return failure(413, REQUEST_LIMIT_DETAIL);
    }
    headers.set('Content-Type', contentType);
    // Let fetch frame the stream. Do not carry a potentially stale body length
    // or browser cookies/authorization to a separately configured API host.
  }

  const controller = new AbortController();
  let timedOut = false;
  let exceededLimit = false;
  const onDisconnect = () => controller.abort();
  request.signal.addEventListener('abort', onDisconnect, { once: true });
  if (request.signal.aborted) onDisconnect();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? (request.method === 'POST' ? UPLOAD_TIMEOUT_MS : 90_000));

  try {
    let bytes = 0;
    const body = request.method === 'POST' ? request.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, stream) {
        bytes += chunk.byteLength;
        if (bytes > maxRequestBytes) {
          exceededLimit = true;
          stream.error(new Error('Upload exceeds the request limit'));
          controller.abort();
          return;
        }
        stream.enqueue(chunk);
      },
    })) : undefined;
    const init: RequestInit & { duplex?: 'half' } = {
      method: request.method, headers, body, signal: controller.signal,
      cache: 'no-store', redirect: 'error', ...(body ? { duplex: 'half' as const } : {}),
    };
    const response = await (options.fetcher ?? fetch)(upstream, init);
    // Both methods return bounded job metadata, never uploaded recordings.
    const text = await response.text();
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      return failure(502, 'The analysis service returned an unexpected response. Check the server logs before retrying; the upload may already have been accepted.');
    }
    const responseHeaders = new Headers({ 'Content-Type': 'application/json', ...RESPONSE_HEADERS });
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) responseHeaders.set('Retry-After', retryAfter);
    return new Response(text, { status: response.status, headers: responseHeaders });
  } catch {
    if (exceededLimit) return failure(413, REQUEST_LIMIT_DETAIL);
    if (request.signal.aborted) return failure(499, 'The upload connection was closed. Check saved analyses before uploading again.');
    if (timedOut) return failure(504, 'The upload or analysis service took too long to respond. Check saved analyses before retrying; use fewer complete files per batch.');
    return failure(502, 'The upload could not reach the analysis service. Check saved analyses before retrying and ask the server administrator to check the API connection.');
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onDisconnect);
    controller.abort();
  }
}
