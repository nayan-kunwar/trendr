import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import boundaries from 'eslint-plugin-boundaries';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/coverage/**', '**/.turbo/**'],
  },
  eslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Dependency direction (spec §4): config ← logger ← core ← db ← sources ← apps.
    // `core` must not import `db`.
    files: ['packages/**/*.{ts,tsx,mts,cts}', 'apps/**/*.{ts,tsx,mts,cts}'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'config', pattern: 'packages/config/src/**' },
        { type: 'logger', pattern: 'packages/logger/src/**' },
        { type: 'core', pattern: 'packages/core/src/**' },
        { type: 'db', pattern: 'packages/db/src/**' },
        { type: 'sources', pattern: 'packages/sources/src/**' },
        { type: 'apps', pattern: 'apps/*/src/**' },
      ],
      'boundaries/ignore': ['**/*.test.ts', '**/*.test.tsx', '**/*.config.ts'],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'logger', allow: ['config'] },
            { from: 'core', allow: ['config', 'logger'] },
            { from: 'db', allow: ['config', 'logger', 'core'] },
            { from: 'sources', allow: ['config', 'logger', 'core'] },
            { from: 'apps', allow: ['config', 'logger', 'core', 'db', 'sources'] },
          ],
        },
      ],
    },
  },
  prettier,
);
