// Used by `npm run lint` here and, because ESLint 10 looks up the nearest config per file, by the root `eslint .`
// for files under dashboard/. Only packages the root also has are imported, so root lint works without a
// dashboard install (Node resolves them from the parent node_modules).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'public/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['*.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
