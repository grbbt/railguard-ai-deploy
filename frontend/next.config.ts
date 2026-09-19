import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  async rewrites() { return [{ source: '/api/:path*', destination: `${process.env.RAILGUARD_API_URL || 'http://127.0.0.1:8000'}/api/:path*` }]; },
  // PS3 supports 64 MB files and 1500 MB batches; the API validates both limits.
  // Let the bounded multi-step investigation return its own answer/fallback.
  experimental: { proxyClientMaxBodySize: '1536mb', proxyTimeout: 90_000 },
};
export default nextConfig;
