/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // Vercel: frontend is static/dynamic-less; server API lives elsewhere (Render/VPS)
  async rewrites() {
    // When NEXT_PUBLIC_API_URL is NOT set, proxy /api/* to local backend (dev convenience)
    if (!process.env.NEXT_PUBLIC_API_URL) {
      return [
        { source: '/api/:path*', destination: 'http://localhost:4010/api/:path*' },
        { source: '/health', destination: 'http://localhost:4010/health' },
      ];
    }
    return [];
  },
};

export default nextConfig;