import path from 'node:path';

import type { NextConfig } from 'next';

// The Docker image (spec §17) consumes the traced standalone server bundle.
// Producing it needs symlink privileges (Windows: Developer Mode), so it is
// opt-in locally and enabled via NEXT_STANDALONE=true in the web Dockerfile.
const standalone = process.env.NEXT_STANDALONE === 'true';

const nextConfig: NextConfig = {
  output: standalone ? 'standalone' : undefined,
  // Trace from the repo root so the bundle lands at standalone/apps/web/server.js,
  // the path the web Dockerfile copies. Next tasks run with apps/web as cwd.
  outputFileTracingRoot: standalone ? path.resolve(process.cwd(), '../..') : undefined,
};

export default nextConfig;
