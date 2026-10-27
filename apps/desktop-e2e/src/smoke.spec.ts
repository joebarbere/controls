import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchControls } from './launch';

const { version } = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8'));

test('launches, serves app://, and renders the 3D viewport', async () => {
  const app = await launchControls();
  try {
    const { window } = app;
    await expect(window).toHaveTitle('Controls');
    expect(window.url()).toBe('app://game/index.html');

    await expect(window.getByTestId('about-version')).toHaveText(version);
    await expect(window.getByTestId('about-platform')).toContainText('Electron 45');
    await expect(window.getByTestId('about-isolated')).toHaveText('yes'); // COOP/COEP from the app:// handler
    const csp = await window.evaluate(async () => (await fetch('/index.html')).headers.get('content-security-policy'));
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    await expect(window.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
    await expect(window.getByTestId('about-backend')).toHaveText(/^(webgpu|webgl2)$/);
    await window.screenshot({ path: test.info().outputPath('viewport.png') });
  } finally {
    await app.close();
  }
});

test('renderer is sandboxed with no Node access', async () => {
  const app = await launchControls();
  try {
    const { window } = app;
    const exposure = await window.evaluate(() => {
      const scope = globalThis as unknown as Record<string, unknown>;
      return {
        require: typeof scope['require'],
        process: typeof scope['process'],
        bridgeKeys: Object.keys((scope['controls'] as object | undefined) ?? {}),
      };
    });
    expect(exposure).toEqual({ require: 'undefined', process: 'undefined', bridgeKeys: ['getAppInfo'] });
  } finally {
    await app.close();
  }
});
