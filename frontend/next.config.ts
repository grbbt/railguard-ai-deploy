import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  // Referenced only by the server upload route; retain Docker build-time routing.
  env: { RAILGUARD_BUILD_API_URL: process.env.RAILGUARD_API_URL || 'http://127.0.0.1:8000' },
  async rewrites() { return [{ source: '/api/:path*', destination: `${process.env.RAILGUARD_API_URL || 'http://127.0.0.1:8000'}/api/:path*` }]; },
  // /api/ps3/jobs has an explicit streaming route before these rewrites.
  // Keep the configured limits for any remaining proxied requests.
  // Let the bounded multi-step investigation return its own answer/fallback.
  experimental: { proxyClientMaxBodySize: '1536mb', proxyTimeout: 90_000 },
};
export default nextConfig;
