import { forwardPs3Jobs } from '@/lib/ps3-upload-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handle(request: Request) {
  // A Docker build may supply its API address only at build time. Keep that
  // fallback, while allowing a runtime address to override it on the server.
  const backend = process.env.RAILGUARD_API_URL || process.env.RAILGUARD_BUILD_API_URL || 'http://127.0.0.1:8000';
  return forwardPs3Jobs(request, backend);
}

export { handle as GET, handle as POST };
