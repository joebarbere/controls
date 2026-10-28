import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { getReadyUrl, workspaceRoot } from '@nx/devkit';

const isCI = !!process.env['CI'];
// For CI, you may want to set BASE_URL to the deployed application.
// getReadyUrl moves the address to the port the dev server task reported.
const baseURL = process.env['BASE_URL'] || getReadyUrl('http://localhost:4200');

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// import 'dotenv/config';

/**
 * See https://playwright.dev/docs/test-configuration.
 *
 * Generated as a .mts file so Node forces ESM regardless of workspace
 * `type`. Playwright routes `.mts` through its ESM loader (dynamic import,
 * bypassing the pirates CJS-compile path), and Nx's native TS strip loads
 * `.mts` directly. Playwright's configLoader auto-discovers
 * `playwright.config.mts` via its extension list
 * (.ts/.js/.mts/.mjs/.cts/.cjs).
 */
export default defineConfig({
  ...nxE2EPreset(import.meta.dirname, { testDir: './src' }),
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    baseURL,
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },
  webServer: {
    // CI serves the production build through the Angular dev server: unlike @nx/web:file-server it
    // honours the COOP/COEP `headers` option that cross-origin isolation (SharedArrayBuffer) needs.
    command: isCI ? 'pnpm exec nx run game:serve:production' : 'pnpm exec nx run game:serve',
    url: getReadyUrl('http://localhost:4200'),
    reuseExistingServer: true,
    cwd: workspaceRoot,
  },
  // Chromium only: Electron is Chromium, so other engines add CI time without covering the product.
  // 960 × 540, not Desktop Chrome's 1280 × 720: the viewport renders every frame, behind the menu
  // too, and SwiftShader's cost scales with pixels (median frame 133 ms at 1280 × 720 against 33 ms
  // at 640 × 360, measured on a loaded dev machine). Every protocol round trip waits for a frame, so
  // the UI suites run about twice as fast. Specs where the 3D image or pixel aim is the contract pin
  // 1280 × 720 themselves (harness, viewport, placement, workshop).
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 960, height: 540 } } }],
});
