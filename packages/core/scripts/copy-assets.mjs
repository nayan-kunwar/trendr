// Copies non-TS assets next to the tsup bundle. `token-bucket.ts` loads
// `token-bucket.lua` with `readFileSync(new URL(..., import.meta.url))`, and the
// bundle is a single file at `dist/index.js`, so in prod the script must sit at
// `dist/token-bucket.lua` (in `src` it resolves next to the module itself).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const assets = [['src/rate-limit/token-bucket.lua', 'dist/token-bucket.lua']];

for (const [from, to] of assets) {
  const target = join(packageRoot, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(packageRoot, from), target);
  console.log(`[copy-assets] ${from} -> ${to}`);
}
