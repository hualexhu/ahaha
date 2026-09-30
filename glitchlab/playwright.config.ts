import { defineConfig, devices } from '@playwright/test';

const port = 4318;
// E2E_DEV=1 runs the suite against the Vite dev server instead of the production build
const dev = !!process.env.E2E_DEV;

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  // by default e2e runs against the production build, like the deployed static site
  webServer: {
    command: dev
      ? `npx vite --port ${port} --strictPort --host 127.0.0.1`
      : `npx vite build && npx vite preview --port ${port} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
