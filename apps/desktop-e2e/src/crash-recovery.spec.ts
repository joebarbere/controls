import { expect, test } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashAfter, newSandbox, PLACE } from './game';
import { createProfile, launchControls, removeProfile, type LaunchedControls } from './launch';

// Crashes the renderer through main (`forcefullyCrashRenderer`) and stubs the native dialog, both
// over the Node inspector: dev build only (a packaged build's Fuses turn the inspector off).
test.skip(!!process.env['CONTROLS_E2E_EXECUTABLE'], 'crashes the renderer through the Node inspector (dev build only)');

/** The crash-loop limit in `apps/desktop/src/crash-recovery.ts` (CRASH_LOOP_LIMIT). */
const CRASH_LOOP_LIMIT = 3;

const RECOVERY_NOTICE = 'Controls stopped unexpectedly and was restarted. Continue resumes your latest autosave.';

/** Kills the window's renderer process from main, as a real crash would end it. */
const crashRenderer = (app: LaunchedControls) =>
  app.evaluateMain?.(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer());

/** Whether the window's renderer is dead (crashed and not reloaded). */
const isCrashed = async (app: LaunchedControls) =>
  (await app.evaluateMain?.(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.isCrashed())) ?? null;

/**
 * The reloaded page is driven from main. Playwright marks a page whose renderer crashed as dead for
 * good ("Target crashed"), even after main reloads the same `WebContents`, and a second DevTools
 * connection lists the target but never builds a page for it (Playwright 1.64). So after a crash the
 * test reads the DOM with `executeJavaScript` and types with `sendInputEvent` (real keyboard input).
 */
const inPage = <T>(app: LaunchedControls, script: string): Promise<T> =>
  app.evaluateMain?.(
    ({ BrowserWindow }, source) => BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript(source),
    script,
  ) as Promise<T>;

/** Presses a key (`Enter`, `` ` ``) and/or types text into the page. */
const keys = (app: LaunchedControls, input: { press?: string; text?: string }) =>
  app.evaluateMain?.(({ BrowserWindow }, { press, text }) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!contents) return;
    if (press !== undefined) {
      contents.sendInputEvent({ type: 'keyDown', keyCode: press });
      contents.sendInputEvent({ type: 'char', keyCode: press === 'Enter' ? '\r' : press });
      contents.sendInputEvent({ type: 'keyUp', keyCode: press });
    }
    for (const ch of text ?? '') contents.sendInputEvent({ type: 'char', keyCode: ch });
  }, input);

/**
 * Waits for main to reload the crashed window, then for the recovery notice with Continue focused and
 * described by it (and, with no saves, by the reason Continue is unavailable).
 */
async function expectRecoveryMenu(app: LaunchedControls, saves = true): Promise<void> {
  await expect.poll(() => isCrashed(app)).toBe(false);
  await expect
    .poll(() => app.evaluateMain?.(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getURL()))
    .toBe('app://game/index.html?recovered=renderer-crash');
  await expect
    .poll(() =>
      inPage(
        app,
        `(() => {
          const notice = document.querySelector('nav [role="alert"]#ctl-main-menu-recovery');
          const focused = document.activeElement;
          return {
            notice: notice?.textContent?.trim() ?? null,
            focused: focused?.textContent?.trim() ?? null,
            describedBy: focused?.getAttribute('aria-describedby') ?? null,
          };
        })()`,
      ),
    )
    .toEqual({
      notice: RECOVERY_NOTICE,
      focused: 'Continue',
      describedBy: saves ? 'ctl-main-menu-recovery' : 'ctl-main-menu-recovery ctl-main-menu-saves',
    });
}

test('a renderer crash reloads the window, and Continue resumes the latest autosave', async () => {
  const profile = createProfile();
  const app = await launchControls({ userDataDir: profile });
  try {
    await newSandbox(app.window, 0);
    const placed = await hashAfter(app.window, PLACE);
    await app.window.getByRole('button', { name: 'Menu' }).click(); // autosaves the change on the way
    const slot = join(profile, 'saves', 'autosave', 'slot-1.ctrl');
    // The autosave and the pointer to it are on disk: no quit flush runs for a crash.
    await expect.poll(() => existsSync(slot)).toBe(true);
    // This poll passes with or without the debounce; save-games.spec.ts pins the immediate write.
    const settingsFile = join(profile, 'settings.json');
    await expect
      .poll(() => existsSync(settingsFile) && JSON.parse(readFileSync(settingsFile, 'utf8')).saves?.lastPlayed)
      .toEqual({ kind: 'autosave', slot: 1 });
    const autosaved = readFileSync(slot);
    await app.window.getByRole('navigation', { name: 'Controls' }).getByRole('button', { name: 'Resume' }).click();
    await expect(app.window.locator('ctl-viewport canvas')).toBeFocused();

    await crashRenderer(app);
    await expectRecoveryMenu(app);
    expect(readFileSync(slot).equals(autosaved)).toBe(true); // the crash path wrote nothing

    await keys(app, { press: 'Enter' }); // Continue
    await expect.poll(() => inPage<string>(app, 'document.body.innerText')).toContain('Loaded “Autosave 1”.');
    await expect
      .poll(() => inPage(app, `document.activeElement === document.querySelector('ctl-viewport canvas')`))
      .toBe(true);
    // world.hash in the dev console: the game is the one autosaved before the crash.
    await keys(app, { press: '`' });
    await expect
      .poll(() => inPage(app, `!!document.activeElement?.closest('ctl-dev-console [data-editor="ready"]')`))
      .toBe(true);
    await keys(app, { text: 'world.hash' });
    await keys(app, { press: 'Enter' });
    await expect
      .poll(() =>
        inPage(app, `document.querySelector('[data-testid="console-output"] .entry:last-child')?.textContent ?? null`),
      )
      .toBe(placed);
    expect(readdirSync(join(profile, 'saves', 'autosave'))).toEqual(['slot-1.ctrl']);
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

test('a crash loop stops reloading at the limit and asks: Retry reloads, Quit quits', async () => {
  const profile = createProfile();
  const app = await launchControls({ userDataDir: profile });
  let quit = false;
  try {
    await expect(app.window.getByRole('navigation', { name: 'Controls' })).toBeVisible();
    // The crash-loop dialog: record what it asks and answer when the test says.
    await app.evaluateMain?.(({ dialog }) => {
      const g = globalThis as unknown as Record<string, unknown>;
      const asked: unknown[] = [];
      g['__crashDialogs'] = asked;
      (dialog as unknown as Record<string, unknown>)['showMessageBox'] = (
        _window: unknown,
        options: { type?: string; message: string; buttons?: string[] },
      ) =>
        new Promise((resolve) => {
          asked.push({ type: options.type, message: options.message, buttons: options.buttons });
          g['__answerCrashDialog'] = (response: number) => resolve({ response, checkboxChecked: false });
        });
    });
    const dialogs = () =>
      app.evaluateMain?.(() => (globalThis as unknown as Record<string, unknown[]>)['__crashDialogs']);
    const answer = (response: number) =>
      app.evaluateMain?.(
        (_electron, r) => (globalThis as unknown as Record<string, (r: number) => void>)['__answerCrashDialog']?.(r),
        response,
      );

    // Counts `render-process-gone` in main, so each crash is seen even if the reload is quick.
    await app.evaluateMain?.(({ BrowserWindow }) => {
      const g = globalThis as unknown as Record<string, number>;
      g['__gone'] = 0;
      BrowserWindow.getAllWindows()[0]?.webContents.on('render-process-gone', () => void g['__gone']++);
    });
    const gone = () => app.evaluateMain?.(() => (globalThis as unknown as Record<string, number>)['__gone']);
    let crashes = 0;

    /** Crashes as soon as each reload is running the game again, `CRASH_LOOP_LIMIT` times. */
    const crashLoop = async () => {
      for (let i = 0; i < CRASH_LOOP_LIMIT; i++) {
        await expect.poll(() => isCrashed(app)).toBe(false);
        await expect
          .poll(() =>
            inPage(
              app,
              "document.readyState === 'complete' && !!document.querySelector('nav[aria-labelledby=\"ctl-main-menu-title\"]')",
            ),
          )
          .toBe(true);
        await crashRenderer(app);
        await expect.poll(gone).toBe(++crashes);
      }
    };

    await crashLoop();
    const asked = { type: 'error', message: 'Controls keeps stopping unexpectedly.', buttons: ['Retry', 'Quit'] };
    await expect.poll(dialogs).toEqual([asked]);
    expect(await isCrashed(app)).toBe(true); // not reloaded while the player decides

    await answer(0); // Retry
    await expectRecoveryMenu(app, false); // a new profile: nothing to continue yet

    await crashLoop(); // Retry started a new count: the limit again, then the same question
    await expect.poll(dialogs).toEqual([asked, asked]);
    await answer(1); // Quit
    await app.exited;
    quit = true;
  } finally {
    if (!quit) await app.close();
    removeProfile(profile);
  }
});
