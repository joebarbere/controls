import { expect, test } from '@playwright/test';
import { launchControls, type LaunchedControls } from './launch';

// Plan §4.11: window.open is denied outright and nothing reaches shell.openExternal (an external link
// would need an explicit, allow-listed IPC call), and navigation off app://game/ is refused.
//
// Its own launch: Playwright sees the refused navigation start and then waits forever for it to
// commit, so every later locator on this page stalls ("waiting for navigation to finish...").
test.describe.serial('window opening and navigation', () => {
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

  test('window.open, target=_blank and navigation to an external URL open nothing', async () => {
    const { window, evaluateMain } = running();
    await expect(window.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
    // Dev build: record any shell.openExternal call in main (packaged builds have no inspector).
    await evaluateMain?.(({ shell }) => {
      const scope = globalThis as unknown as { openedExternally: string[] };
      scope.openedExternally = [];
      (shell as unknown as Record<string, unknown>)['openExternal'] = async (url: string) => {
        scope.openedExternally.push(url);
      };
    });
    const pagesBefore = window.context().pages().length;

    const result = await window.evaluate(async () => {
      const opened = globalThis.open('https://example.com/');
      const link = document.createElement('a');
      link.href = 'https://example.com/blank';
      link.target = '_blank';
      document.body.append(link);
      link.click();
      link.remove();
      // A navigation that went through would destroy this context and fail the evaluate.
      location.href = 'https://example.com/navigate';
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return { opened: opened === null ? 'null' : 'a window', href: location.href };
    });
    expect(result).toEqual({ opened: 'null', href: 'app://game/index.html' });
    expect(window.context().pages()).toHaveLength(pagesBefore);
  });

  test('main opened no window and called shell.openExternal for none of them', async () => {
    const { evaluateMain } = running();
    test.skip(!evaluateMain, 'reads main through the Node inspector (dev build only)');
    const main = await evaluateMain?.(({ BrowserWindow }) => ({
      windows: BrowserWindow.getAllWindows().length,
      url: BrowserWindow.getAllWindows()[0]?.webContents.getURL(),
      openedExternally: (globalThis as unknown as { openedExternally: string[] }).openedExternally,
    }));
    expect(main).toEqual({ windows: 1, url: 'app://game/index.html', openedExternally: [] });
  });
});
