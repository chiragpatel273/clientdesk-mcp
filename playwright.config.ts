import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests: a real browser against the real server (AUTH_MODE=dev, in-memory database seeded with the
 * fictional firm, offline extractor and embeddings: no keys, no cost). `npx playwright test` builds the dashboard,
 * starts the server on :3399 and runs every spec in Chromium.
 */
const PORT = 3399;

// Explicit offline settings: real environment variables win over `.env`, which may hold real keys or S3 settings.
const serverEnv = {
  NODE_ENV: 'test',
  PORT: String(PORT),
  DATABASE_URL: 'pglite://memory',
  AUTH_MODE: 'dev',
  DEV_USER: 'maya@northbridge.example',
  DEMO_LOGIN: 'true',
  SEED_DEMO: '1',
  EXTRACTOR: 'rules',
  EMBEDDINGS: 'local',
  STORAGE: 'local',
  FILES_DIR: '.data/e2e-files',
  WORKER: '1',
  JOB_BACKOFF_MS: '0',
  PUBLIC_URL: '',
  ALLOWED_HOSTS: '',
  OAUTH_ISSUER: '',
  DASHBOARD_CLIENT_ID: '',
  DASHBOARD_CLIENT_SECRET: '',
  ANTHROPIC_API_KEY: '',
  GROQ_API_KEY: '',
  VOYAGE_API_KEY: '',
};

export default defineConfig({
  testDir: 'e2e',
  // One server and one database: specs run one at a time, in file order, so their data changes don't race.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dashboard:build && npx tsx src/main.ts',
    url: `http://localhost:${PORT}/health`,
    env: serverEnv,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
