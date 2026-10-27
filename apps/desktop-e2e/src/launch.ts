import { _electron as electron, chromium, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const workspaceRoot = join(__dirname, '../../..');

export interface LaunchedControls {
  readonly window: Page;
  close(): Promise<void>;
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

/** Child environment: the parent's (minus unset entries) with auto-update disabled. */
const env = (): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
  CONTROLS_DISABLE_UPDATES: '1',
});

/**
 * Launches Controls the way a player would, minus auto-update.
 * - Default: the assembled app dir via Playwright `_electron` (dev Electron, no fuses).
 * - CONTROLS_E2E_EXECUTABLE=<packaged binary>: the release fuses disable Node's --inspect, which
 *   `_electron` needs, so we start the binary ourselves and attach over Chromium's DevTools protocol.
 */
export async function launchControls(): Promise<LaunchedControls> {
  const executable = process.env['CONTROLS_E2E_EXECUTABLE'];
  if (!executable) {
    const app = await electron.launch({
      args: [join(workspaceRoot, 'dist/apps/desktop'), ...chromiumArgs()],
      env: env(),
    });
    return { window: captureConsole(await app.firstWindow()), close: () => app.close() };
  }

  const port = 9300 + Math.floor(Math.random() * 500);
  const child = spawn(executable, [`--remote-debugging-port=${port}`, ...chromiumArgs()], {
    env: env(),
    stdio: 'ignore',
  });
  const browser = await connectWithRetry(`http://127.0.0.1:${port}`);
  const window = captureConsole(await findAppPage(browser.contexts()));
  return {
    window,
    close: async () => {
      await browser.close().catch(() => undefined);
      child.kill();
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
