import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchControls, type LaunchedControls } from './launch';

const { version } = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8'));

// One launch for the whole file: launching is the slow, platform-sensitive part (cold starts on
// CI runners), and every assertion here reads the same running app.
test.describe.serial('desktop smoke', () => {
  let app: LaunchedControls | undefined;
  const running = (): LaunchedControls => {
    if (!app) throw new Error('app did not launch');
    return app;
  };

  test.beforeAll(async () => {
    app = await launchControls();
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('launches, serves app://, and renders the 3D viewport', async () => {
    const { window } = running();
    await expect(window).toHaveTitle('Controls');
    expect(window.url()).toBe('app://game/index.html');

    await expect(window.getByTestId('about-version')).toHaveText(version);
    await expect(window.getByTestId('about-platform')).toContainText('Electron 45');
    await expect(window.getByTestId('about-isolated')).toHaveText('yes'); // COOP/COEP from the app:// handler
    const csp = await window.evaluate(async () => (await fetch('/index.html')).headers.get('content-security-policy'));
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    await expect(window.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
    await expect(window.getByTestId('about-backend')).toHaveText(/^(webgpu|webgl2)$/);
    await window.screenshot({ path: test.info().outputPath('viewport.png') });
  });

  test('renderer is sandboxed with no Node access', async () => {
    const exposure = await running().window.evaluate(() => {
      const scope = globalThis as unknown as Record<string, unknown>;
      return {
        require: typeof scope['require'],
        process: typeof scope['process'],
        bridgeKeys: Object.keys((scope['controls'] as object | undefined) ?? {}),
      };
    });
    expect(exposure).toEqual({
      require: 'undefined',
      process: 'undefined',
      bridgeKeys: ['getAppInfo', 'getSettings', 'setSettings', 'quit'],
    });
  });

  test('settings:set refuses an invalid document without echoing it', async () => {
    const message = await running().window.evaluate(async () => {
      const bridge = (globalThis as unknown as { controls: { setSettings(s: unknown): Promise<void> } }).controls;
      return bridge.setSettings({ secret: 'do-not-echo' }).then(
        () => 'accepted',
        (error: Error) => error.message,
      );
    });
    expect(message).toContain('settings:set refused (invalid)');
    expect(message).not.toContain('do-not-echo');
  });

  // The shell (native <dialog>, design tokens, splitters) must work under the app:// CSP (ADR 0005).
  test('shell menu, dialogs and workspace work under the CSP', async () => {
    const { window } = running();
    await window.evaluate(() => {
      const scope = globalThis as unknown as { cspViolations: string[] };
      scope.cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) =>
        scope.cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`),
      );
    });
    const menu = window.getByRole('navigation', { name: 'Controls' });
    await expect(menu.getByRole('button', { name: 'Quit' })).toBeVisible(); // desktop can quit

    await menu.getByRole('button', { name: 'Settings' }).focus();
    await window.keyboard.press('Enter');
    const settings = window.getByRole('dialog', { name: 'Settings' });
    await expect(settings).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await expect(menu.getByRole('button', { name: 'Settings' })).toBeFocused();

    await menu.getByRole('button', { name: 'New sandbox' }).focus();
    await window.keyboard.press('Enter');
    // The new-game dialog (F1.9) offers a fresh seed; Enter starts the workshop with it.
    const seed = window.getByRole('dialog', { name: 'New sandbox' }).getByRole('textbox', { name: 'Seed' });
    await expect(seed).toBeFocused();
    await expect(seed).toHaveValue(/^\d+$/);
    await window.keyboard.press('Enter');
    await expect(window.getByRole('region', { name: 'Inspector' })).toBeVisible();
    await expect(window.locator('ctl-viewport canvas')).toBeFocused();
    await expect(window.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready');

    const violations = await window.evaluate(
      () => (globalThis as unknown as { cspViolations: string[] }).cspViolations,
    );
    expect(violations).toEqual([]);
  });

  // F1.5: CodeMirror 6 (a lazy chunk that injects its own <style> element) works under the real CSP.
  test('the dev console opens with backtick and runs a line under the CSP', async () => {
    const { window } = running();
    await window.evaluate(() => {
      (globalThis as unknown as { cspViolations: string[] }).cspViolations = [];
    });
    await expect(window.locator('ctl-viewport canvas')).toBeFocused(); // the workspace, from the test above
    await expect(window.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached({ timeout: 15_000 });
    await window.keyboard.press('Backquote');
    const input = window.getByRole('textbox', { name: 'Console input' });
    await expect(input).toBeFocused();

    // CodeMirror's styles applied: its base theme lays the editor out as flex, and ours sets the font.
    const styled = await window.locator('ctl-dev-console .cm-editor').evaluate((el) => ({
      display: getComputedStyle(el).display,
      font: getComputedStyle(el).fontFamily,
    }));
    expect(styled.display).toBe('flex');
    expect(styled.font).toContain('monospace');

    await window.keyboard.type('world.hash');
    await window.keyboard.press('Enter');
    const output = window.getByRole('log', { name: 'Console output' });
    await expect(output.locator('.entry').last()).toHaveText(/^[0-9a-f]{64}$/);
    await window.keyboard.press('Backquote');
    await expect(window.locator('ctl-viewport canvas')).toBeFocused();

    const violations = await window.evaluate(
      () => (globalThis as unknown as { cspViolations: string[] }).cspViolations,
    );
    expect(violations).toEqual([]);
  });
});
