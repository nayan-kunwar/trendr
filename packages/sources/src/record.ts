/**
 * Spec §16 — `pnpm fixtures:record --source {source}` dispatcher. `RECORD=1`
 * is required because every recorder calls the live upstream API; each
 * per-source recorder loads `.env` itself only when it needs credentials.
 */

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

const USAGE = 'usage: RECORD=1 pnpm fixtures:record --source {github|npm}';

async function main(): Promise<void> {
  const source = argValue('--source');
  if (process.env.RECORD !== '1') {
    throw new Error(`${USAGE} (RECORD=1 confirms the live API calls)`);
  }
  switch (source) {
    case 'github': {
      const { recordGitHubFixtures } = await import('./github/record.js');
      await recordGitHubFixtures();
      return;
    }
    case 'npm': {
      const { recordNpmFixtures } = await import('./npm/record.js');
      await recordNpmFixtures();
      return;
    }
    default:
      throw new Error(USAGE);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
