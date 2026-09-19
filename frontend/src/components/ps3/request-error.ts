function messageText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Prefer the API's specific error; never display an HTML proxy response body. */
export async function errorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const error = body as { detail?: unknown; message?: unknown };
      const message = messageText(error.detail) ?? messageText(error.message);
      if (message) return message;
      if (Array.isArray(error.detail)) {
        const messages = error.detail.map(item => (
          item && typeof item === 'object' ? messageText(item.msg) : null
        )).filter((item): item is string => item !== null);
        if (messages.length) return messages.join('. ');
      }
    }
  } catch { /* Empty, malformed or non-JSON responses use the HTTP status below. */ }

  if (response.status === 413) {
    return 'The upload exceeds a server or hosting size limit (413). Try a smaller batch of complete files. If one intact file fails, ask the server administrator to check the upload limit.';
  }
  if ([500, 502, 503, 504].includes(response.status)) {
    return `The server or hosting proxy could not complete the request (${response.status}). Check saved analyses before retrying; if it keeps failing, check the service logs.`;
  }
  return `The request failed (${response.status}). Please retry or check the analysis service.`;
}
