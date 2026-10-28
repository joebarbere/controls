import { _electron as electron, chromium, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspaceRoot = join(__dirname, '../../..');

export interface LaunchedControls {
  readonly window: Page;
  /** Quits the app (`app.quit()` on the dev build, a signal on a packaged one) and waits for it to exit. */
  close(): Promise<void>;
  /**
   * Closes the window the way the title-bar button does (`BrowserWindow.close()` in main). Dev build
   * only: a packaged build has no Node inspector to run it through, so this is undefined there.
   */
  readonly closeWindow?: () => Promise<void>;
  /**
   * Runs a function in main with the `electron` module (Playwright's `ElectronApplication.evaluate`),
   * e.g. to stub `dialog`. Dev build only, like {@link closeWindow}.
   */
  readonly evaluateMain?: ElectronApplication['evaluate'];
}

function chromiumArgs(): string[] {
  const args: string[] = [];
  if (process.env['CONTROLS_E2E_HEADLESS'] === '1') args.push('--ozone-platform=headless');
  if (process.platform === 'linux' && process.env['CI']) {
    args.push('--no-sandbox'); // CI runners lack the SUID sandbox helper
    args.push('--enable-unsafe-swiftshader'); // GPU-less runners: allow Chromium's software WebGL (tests only)
  }
  return args;
}

/** Child environment: the parent's (minus unset entries), auto-update off, a fresh profile. */
const env = (userDataDir: string): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
  CONTROLS_DISABLE_UPDATES: '1',
  CONTROLS_USER_DATA_DIR: userDataDir, // per-launch profile: no shared single-instance lock or profile files
});

export const removeProfile = (dir: string) =>
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

export interface LaunchOptions {
  /**
   * Reuse this profile directory (e.g. to relaunch and check persistence). The caller owns it and
   * removes it; by default every launch gets a fresh directory that is removed on close.
   */
  readonly userDataDir?: string;
}

/** A fresh profile directory for {@link LaunchOptions.userDataDir}; remove it with {@link removeProfile}. */
export const createProfile = (): string => mkdtempSync(join(tmpdir(), 'controls-e2e-'));

/**
 * Launches Controls the way a player would, minus auto-update.
 * - Default: the assembled app dir via Playwright `_electron` (dev Electron, no fuses).
 * - CONTROLS_E2E_EXECUTABLE=<packaged binary>: the release fuses disable Node's --inspect, which
 *   `_electron` needs, so we start the binary ourselves and attach over Chromium's DevTools protocol.
 */
export async function launchControls(options: LaunchOptions = {}): Promise<LaunchedControls> {
  const executable = process.env['CONTROLS_E2E_EXECUTABLE'];
  const userDataDir = options.userDataDir ?? createProfile();
  const cleanUp = () => {
    if (!options.userDataDir) removeProfile(userDataDir);
  };
  if (!executable) {
    const app = await electron.launch({
      args: [join(workspaceRoot, 'dist/apps/desktop'), ...chromiumArgs()],
      env: env(userDataDir),
    });
    return {
      window: captureConsole(await app.firstWindow()),
      close: async () => {
        await app.close();
        cleanUp();
      },
      closeWindow: () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()),
      evaluateMain: app.evaluate.bind(app) as ElectronApplication['evaluate'],
    };
  }

  const port = 9300 + Math.floor(Math.random() * 500);
  const child = spawn(executable, [`--remote-debugging-port=${port}`, ...chromiumArgs()], {
    env: env(userDataDir),
    stdio: 'ignore',
  });
  const browser = await connectWithRetry(`http://127.0.0.1:${port}`);
  const window = captureConsole(await findAppPage(browser.contexts()));
  return {
    window,
    close: async () => {
      await browser.close().catch(() => undefined);
      await terminate(child);
      cleanUp();
    },
  };
}

async function connectWithRetry(endpoint: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await chromium.connectOverCDP(endpoint);
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function findAppPage(contexts: ReturnType<Awaited<ReturnType<typeof chromium.connectOverCDP>>['contexts']>) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const page = contexts.flatMap((c) => c.pages()).find((p) => p.url().startsWith('app://game/'));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Controls window never appeared');
}

/** Mirrors renderer console errors/warnings to the test log, so CI failures (e.g. no WebGL) explain themselves. */
function captureConsole(page: Page): Page {
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning')
      console.log(`[renderer ${message.type()}] ${message.text()}`);
  });
  page.on('pageerror', (error) => console.log(`[renderer pageerror] ${error.message}`));
  return page;
}

/**
 * Waits for the app to really exit. The app holds a single-instance lock, so launching the next
 * test while the previous process is still shutting down (seen on macOS) makes the new one quit.
 */
async function terminate(child: ChildProcess, graceMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill();
  const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
  await exited;
  clearTimeout(timer);
}
