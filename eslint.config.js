import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Dependency direction (spec §4): config ← logger ← core ← db ← sources ← apps.
// A package may only import from layers to its left; `core` must never import `db`.
// eslint-plugin-boundaries has no stable ESLint 9 flat-config release, so the
// direction is enforced with the core `no-restricted-imports` rule instead.
const LAYER_RESTRICTIONS = [
  { layer: 'config', forbidden: ['logger', 'core', 'db', 'sources'] },
  { layer: 'logger', forbidden: ['core', 'db', 'sources'] },
  { layer: 'core', forbidden: ['db', 'sources'] },
  { layer: 'db', forbidden: ['sources'] },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/next-env.d.ts',
    ],
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
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // Ports, status codes, and counts are idiomatic in template literals.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  ...LAYER_RESTRICTIONS.map(({ layer, forbidden }) => ({
    files: [`packages/${layer}/**/*.{ts,tsx,mts,cts}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: forbidden.flatMap((name) => [`@trendr/${name}`, `@trendr/${name}/*`]),
              message: `@trendr/${layer} may only import from layers to its left (spec §4).`,
            },
          ],
        },
      ],
    },
  })),
  prettier,
);
