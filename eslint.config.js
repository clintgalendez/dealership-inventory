import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['dist', '.wrangler', 'playwright-report', 'test-results', 'worker-configuration.d.ts']),
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['src/client/**/*.tsx'],
    extends: [reactHooks.configs.flat['recommended-latest'], reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },
]);
