import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests: a real browser against the real server (AUTH_MODE=dev, in-memory database seeded with the
 * fictional firm, offline extractor and embeddings: no keys, no cost). `npx playwright test` builds the dashboard,
 * starts the server on :3399 and runs every spec in Chromium.
 */
const PORT = 3399;
/** The same server in AUTH_MODE=oauth, and its fake sign-in provider (e2e/oauth-server.ts). */
const OAUTH_PORT = 3400;
const ISSUER_PORT = 3401;

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

const oauthEnv = {
  ...serverEnv,
  PORT: String(OAUTH_PORT),
  AUTH_MODE: 'oauth',
  PUBLIC_URL: `http://localhost:${OAUTH_PORT}`,
  OAUTH_ISSUER: `http://localhost:${ISSUER_PORT}`,
  DASHBOARD_CLIENT_ID: 'e2e-dashboard',
  DASHBOARD_CLIENT_SECRET: 'e2e-dashboard-secret',
  FILES_DIR: '.data/e2e-files-oauth',
  E2E_ISSUER_PORT: String(ISSUER_PORT),
  E2E_WAIT_FOR: `http://localhost:${PORT}/health`,
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
  projects: [
    { name: 'chromium', testIgnore: /sign-in/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'oauth',
      testMatch: /sign-in/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${OAUTH_PORT}` },
    },
  ],
  webServer: [
    {
      command: 'npm run dashboard:build && npx tsx src/main.ts',
      url: `http://localhost:${PORT}/health`,
      env: serverEnv,
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'npx tsx e2e/oauth-server.ts',
      url: `http://localhost:${OAUTH_PORT}/health`,
      env: oauthEnv,
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
