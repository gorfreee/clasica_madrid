import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://localhost:4321';

/**
 * Smoke tests against the production preview (`dist/`).
 * Run `npm run build` first (CI already does). CI uses the Google Chrome
 * bundled with GitHub's Ubuntu runner; local runs keep Playwright Chromium.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: process.env.CI ? 'chrome' : undefined,
      },
    },
  ],
  webServer: {
    command: 'npm run preview -- --host localhost --port 4321',
    url: `${baseURL}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
