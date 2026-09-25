import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: process.env.TEST_BASE_URL ?? 'http://localhost:8088',
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : undefined,
  },
  projects: [
    { name: 'chromium' },
    // Safari handles dragging differently, so the editor's drag and drop is also checked in WebKit.
    { name: 'webkit', use: { browserName: 'webkit' }, testMatch: /toolbox-drag\.spec\.ts/ },
  ],
  reporter: [['list']],
  outputDir: 'test-results/browser',
});
