import { readFileSync } from 'node:fs';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// API tests run inside workerd against a real local D1, using the same
// migrations and seed file as local dev and production.
const migrations = await readD1Migrations('./migrations');
const seed = readFileSync('./db/seed.sql', 'utf8');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations, TEST_SEED: seed } },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
