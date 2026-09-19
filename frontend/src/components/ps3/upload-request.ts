import type { SubsystemId } from '@/lib/ps3-types';
import { errorMessage } from './request-error';

export type PreparationProgress = { phase: 'preparing'; fileIndex: number; fileCount: number; fileName: string };
export type UploadProgress = {
  phase: 'uploading' | 'waiting';
  loadedBytes: number;
  totalBytes: number | null;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
};
export type PreparedUpload = { body: FormData; originalBytes: number; payloadBytes: number; compressedFiles: number };
type PreparationOptions = { uploadEncodings?: readonly string[]; signal?: AbortSignal; onProgress?: (progress: PreparationProgress) => void };
type UploadOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  requestFactory?: () => XMLHttpRequest;
  now?: () => number;
};

function abortError() {
  return new DOMException('Upload cancelled. Check saved analyses before retrying if the transfer had already started.', 'AbortError');
}

function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

/** Lossless transport only: retain original files and compress one CSV at a time. */
export async function prepareUploadPayload(files: readonly File[], subsystem: SubsystemId, options: PreparationOptions = {}): Promise<PreparedUpload> {
  const { signal, onProgress, uploadEncodings } = options;
  checkAborted(signal);
  const supportsGzip = Array.isArray(uploadEncodings) && uploadEncodings.includes('gzip');
  const compress = supportsGzip && typeof CompressionStream === 'function';
  const body = new FormData();
  body.append('subsystem', subsystem);
  const encodings: ('identity' | 'gzip')[] = [];
  let originalBytes = 0, payloadBytes = 0, compressedFiles = 0;
  for (const [index, file] of files.entries()) {
    checkAborted(signal);
    onProgress?.({ phase: 'preparing', fileIndex: index + 1, fileCount: files.length, fileName: file.name });
    let payload = file;
    let encoding: 'identity' | 'gzip' = 'identity';
    if (compress && file.size >= 1024 ** 2 && file.name.toLowerCase().endsWith('.csv')) {
      try {
        const stream = file.stream().pipeThrough(new CompressionStream('gzip'), { signal });
        const compressed = await new Response(stream).blob();
        checkAborted(signal);
        if (compressed.size < file.size) {
          // An old backend rejects .csv.gz instead of interpreting compressed bytes as CSV.
          payload = new File([compressed], `${file.name}.gz`, { type: 'application/gzip', lastModified: file.lastModified });
          encoding = 'gzip';
          compressedFiles += 1;
        }
      } catch {
        checkAborted(signal);
        // Compression is optional. A browser that cannot complete it sends the original.
      }
    }
    checkAborted(signal);
    body.append('files', payload);
    encodings.push(encoding);
    originalBytes += file.size;
    payloadBytes += payload.size;
  }
  // Leave the legacy multipart contract intact when the server advertises no gzip support.
  if (supportsGzip) body.append('file_encodings', JSON.stringify(encodings));
  return { body, originalBytes, payloadBytes, compressedFiles };
}

/** Report real request-body transfer events; acceptance still requires a valid 202 response. */
export function uploadRecordings(body: FormData, options: UploadOptions = {}): Promise<string> {
  const { signal, onProgress, requestFactory = () => new XMLHttpRequest(), now = () => performance.now() } = options;
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const request = requestFactory();
    let settled = false;
    const started = now();
    let progress: UploadProgress = { phase: 'uploading', loadedBytes: 0, totalBytes: null, bytesPerSecond: null, etaSeconds: null };

    function cleanup() {
      signal?.removeEventListener('abort', cancel);
      request.upload.onprogress = null;
      request.upload.onload = null;
      request.onload = null;
      request.onerror = null;
      request.ontimeout = null;
      request.onabort = null;
    }
    function fail(cause: Error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cause);
    }
    function cancel() {
      request.abort();
      fail(abortError());
    }
    function report(event: ProgressEvent, phase: UploadProgress['phase']) {
      if (settled || signal?.aborted) return;
      const totalBytes = event.lengthComputable && Number.isFinite(event.total) && event.total > 0 ? event.total : progress.totalBytes;
      const reported = Number.isFinite(event.loaded) && event.loaded >= 0 ? event.loaded : progress.loadedBytes;
      const loadedBytes = totalBytes === null ? Math.max(progress.loadedBytes, reported) : Math.min(totalBytes, Math.max(progress.loadedBytes, reported));
      const elapsed = (now() - started) / 1000;
      const bytesPerSecond = elapsed >= 0.25 && loadedBytes > 0 ? loadedBytes / elapsed : null;
      const etaSeconds = phase === 'uploading' && totalBytes !== null && bytesPerSecond ? Math.max(0, (totalBytes - loadedBytes) / bytesPerSecond) : null;
      progress = { phase, loadedBytes, totalBytes, bytesPerSecond, etaSeconds };
      onProgress?.(progress);
    }

    // Attach upload handlers before open() for browsers that require that ordering.
    request.upload.onprogress = event => report(event, 'uploading');
    request.upload.onload = event => report(event, 'waiting');
    request.onabort = () => fail(abortError());
    request.onerror = () => fail(new Error('The upload connection was interrupted. Check saved analyses before retrying.'));
    request.ontimeout = () => fail(new Error('The upload confirmation did not arrive in time. Check saved analyses before retrying.'));
    request.onload = async () => {
      if (settled) return;
      if (request.status === 202) {
        try {
          const result: unknown = JSON.parse(request.responseText);
          const id = result && typeof result === 'object' && !Array.isArray(result) && 'id' in result ? result.id : null;
          if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid job identity');
          if (settled || signal?.aborted) return;
          settled = true;
          cleanup();
          resolve(id);
        } catch {
          fail(new Error('The server returned an invalid upload confirmation. Check saved analyses before retrying.'));
        }
        return;
      }
      if (request.status >= 200 && request.status < 300) {
        fail(new Error(`The server did not confirm that the upload was accepted (${request.status}). Check saved analyses before retrying.`));
        return;
      }
      try {
        const response = new Response(request.status === 304 ? null : request.responseText || null, { status: request.status });
        fail(new Error(await errorMessage(response)));
      } catch {
        fail(new Error('The upload confirmation could not be read. Check saved analyses before retrying.'));
      }
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      checkAborted(signal);
      request.open('POST', '/api/ps3/jobs');
      // Leave time for the hosting proxy's ten-minute deadline to return its error.
      request.timeout = 660_000;
      onProgress?.(progress);
      checkAborted(signal);
      request.send(body);
    } catch (cause) {
      fail(cause instanceof Error ? cause : new Error('The upload could not be started.'));
    }
  });
}
