import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;

// End-to-end tests run the production build in the local Workers runtime (vite preview)
// against a freshly migrated and seeded local D1 database.
export default defineConfig({
  testDir: 'e2e',
  // One worker: the tests share the seeded database and edit different vehicles.
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run db:reset:local && npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
