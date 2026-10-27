import { defineConfig } from '@playwright/test';

/**
 * Electron smoke tests (Playwright `_electron`). Runs against the assembled app directory
 * (dist/apps/desktop) by default, or a packaged binary via CONTROLS_E2E_EXECUTABLE.
 * Linux CI runs under xvfb; locally set CONTROLS_E2E_HEADLESS=1 to avoid a window.
 */
export default defineConfig({
  testDir: './src',
  outputDir: '../../dist/.playwright/apps/desktop-e2e/test-output',
  reporter: [['list'], ['html', { outputFolder: '../../dist/.playwright/apps/desktop-e2e/report', open: 'never' }]],
  timeout: 90_000,
  expect: { timeout: 15_000 }, // CI cold starts (e.g. Windows Defender first-run scans) are slow
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  use: { trace: 'retain-on-failure' },
});
