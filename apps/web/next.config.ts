import type { NextConfig } from 'next';

// The Docker image (spec §17) consumes the traced standalone server bundle.
// Producing it needs symlink privileges (Windows: Developer Mode), so it is
// opt-in locally and enabled via NEXT_STANDALONE=true in the web Dockerfile.
const nextConfig: NextConfig = {
  output: process.env.NEXT_STANDALONE === 'true' ? 'standalone' : undefined,
};

export default nextConfig;
