import { expect, type Page, test, type Worker } from '@playwright/test';
import { newSandbox } from './game';
import { launchControls, type LaunchedControls } from './launch';

/*
 * F2.3b, ADR 0011 "desktop-e2e tests": the sim worker under app://. It runs as a module worker from
 * 'self', cross-origin isolated in its own scope (so SharedArrayBuffer is the transport), with no Node,
 * and without a CSP violation; a crash, a hang (the watchdog) and a CSP violation inside it each stop
 * the sim with the Restart simulation toast, and Restart starts a new worker. One launch for the
 * file; each failure is followed by a restart, so the next test has a worker again. The isolation,
 * no-Node and violation checks also run on the packaged (CDP) path.
 */

test.describe.serial('the sim worker under app://', () => {
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

  /** The newest live worker of the page (a restart adds one; terminated ones drop out). */
  const latestWorker = async (window: Page): Promise<Worker> => {
    await expect.poll(() => window.workers().length).toBeGreaterThan(0);
    return window.workers().at(-1) as Worker;
  };

  /** Waits for the crash toast, checks its code, and restarts the sim from it. */
  async function crashedAndRestarted(window: Page, code: RegExp): Promise<void> {
    const toast = window.getByRole('alert').filter({ hasText: 'The simulation stopped' });
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await expect(toast).toContainText(code);
    const before = window.workers().length;
    await toast.getByRole('button', { name: 'Restart simulation' }).click();
    await expect(window.getByTestId('sim-controls')).toHaveAttribute('data-status', 'paused', { timeout: 15_000 });
    await expect.poll(() => window.workers().length).toBeGreaterThanOrEqual(before);
  }

  test('a New sandbox starts a module worker that is cross-origin isolated in its own scope, with no Node', async () => {
    const { window } = running();
    await expect(window.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
    expect(window.workers()).toEqual([]); // the menu backdrop has no worker
    const started = window.waitForEvent('worker');
    await newSandbox(window, 0);
    const worker = await started;
    expect(worker.url()).toMatch(/^app:\/\/game\/worker-[A-Z0-9]+\.js$/); // bundled, served from 'self', never blob:
    expect(
      await worker.evaluate(() => ({
        isolated: self.crossOriginIsolated,
        shared: typeof SharedArrayBuffer,
        require: typeof (self as unknown as Record<string, unknown>)['require'],
        process: typeof (self as unknown as Record<string, unknown>)['process'],
      })),
    ).toEqual({ isolated: true, shared: 'function', require: 'undefined', process: 'undefined' });
    await expect(window.getByTestId('sim-controls')).toHaveAttribute('data-status', 'paused');
    await expect(window.getByTestId('about-sim-transport')).toHaveText('sab'); // ready.transport (the about box)
  });

  test('time passes in the worker, and the page saw no securitypolicyviolation from it', async () => {
    const { window } = running();
    await window.locator('ctl-viewport canvas').focus();
    await window.keyboard.press('Shift+Digit2'); // 10×
    await expect(window.getByTestId('sim-controls')).toHaveAttribute('data-status', 'running');
    await expect.poll(async () => window.getByTestId('sim-time').textContent()).not.toBe('0:00:00.000');
    await window.keyboard.press('KeyP');
    await expect(window.getByTestId('sim-controls')).toHaveAttribute('data-status', 'paused');
    // The worker's own listener would have reported a violation as a crash; there is none.
    await expect(window.getByRole('alert').filter({ hasText: 'The simulation stopped' })).toHaveCount(0);
  });

  test('a CSP violation inside the worker is forwarded and stops the sim (csp-violation)', async () => {
    const { window } = running();
    const worker = await latestWorker(window);
    // `connect-src 'self'` blocks another origin before any request is made, in the worker's own scope.
    // (An eval can't be the probe: DevTools evaluation is exempt from the CSP's eval check.)
    await worker.evaluate(() => {
      void fetch('https://example.invalid/').catch(() => undefined);
    });
    await crashedAndRestarted(window, /csp-violation/);
  });

  test('an uncaught error in the worker stops the sim and Restart starts a new one', async () => {
    test.skip(Boolean(process.env['CONTROLS_E2E_EXECUTABLE']), 'checked on the dev build');
    const { window } = running();
    const worker = await latestWorker(window);
    await worker.evaluate(() => {
      setTimeout(() => {
        throw new Error('e2e');
      });
    });
    await crashedAndRestarted(window, /engine-threw|worker-error/);
  });

  test('a hung worker is caught by the watchdog', async () => {
    test.skip(Boolean(process.env['CONTROLS_E2E_EXECUTABLE']), 'checked on the dev build');
    const { window } = running();
    await window.locator('ctl-viewport canvas').focus();
    await window.keyboard.press('Shift+Digit1'); // running, so the commanded tick moves ahead of the worker
    await expect(window.getByTestId('sim-controls')).toHaveAttribute('data-status', 'running');
    const worker = await latestWorker(window);
    await worker.evaluate(() => {
      setTimeout(() => {
        for (;;) {
          // spin: the worker never publishes again
        }
      });
    });
    await crashedAndRestarted(window, /watchdog/);
  });

  test('a hidden (minimised) window suspends the sim, and showing it resumes', async () => {
    test.skip(Boolean(process.env['CONTROLS_E2E_EXECUTABLE']), 'needs main (dev build)');
    const { window, evaluateMain } = running();
    if (!evaluateMain) throw new Error('dev build only');
    await window.locator('ctl-viewport canvas').focus();
    await window.keyboard.press('Shift+Digit1');
    await expect(window.getByTestId('sim-controls')).toHaveAttribute('data-status', 'running');
    await evaluateMain(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize());
    // Whether a minimised window reports `hidden` depends on the window system (xvfb and headless
    // ozone may not); the visibility state the page sees is what the host follows.
    const hidden = await window.evaluate(() => document.visibilityState === 'hidden');
    if (hidden) await expect(window.getByTestId('sim-controls')).toHaveAttribute('data-status', 'suspended');
    await evaluateMain(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.restore());
    await expect(window.getByTestId('sim-controls')).toHaveAttribute('data-status', 'running', { timeout: 15_000 });
  });
});
