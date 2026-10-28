import { expect, test, type Page } from '@playwright/test';
import { startSandbox as startWorkshop } from './support/sandbox';

/**
 * F1.4 keybindings: rebind a command and an input action from the keyboard in Settings → Key
 * bindings, use the new keys, and check the change survives a reload (settings in localStorage).
 * The tool-belt keys run `toolbelt.select {slot}`, a logged view command; the walk keys are input
 * actions and never reach the replay log.
 */

const KEY = 'controls.settings';

// The hooks are typed in viewport.spec.ts and world-hash.spec.ts (global Window augmentations);
// this file reads them through a local cast so the declarations don't clash.
type Hooks = {
  __controlsSession?: { entries(): ReadonlyArray<{ id: string; args: Record<string, unknown> }> };
  __controlsViewport?: { cameraPositionMm(): { z: number } | undefined; afterFrames(count: number): Promise<void> };
};

const entries = (page: Page) =>
  page.evaluate(() =>
    ((window as unknown as Hooks).__controlsSession?.entries() ?? []).map((e) => ({ id: e.id, args: e.args })),
  );
const cameraZ = (page: Page) =>
  page.evaluate(() => (window as unknown as Hooks).__controlsViewport?.cameraPositionMm()?.z ?? NaN);
const stored = (page: Page) => page.evaluate((key) => localStorage.getItem(key) ?? '', KEY);

async function openKeyBindings(page: Page) {
  const menu = page.getByRole('navigation', { name: 'Controls' });
  await menu.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const opener = settings.getByRole('button', { name: 'Key bindings…' });
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Key bindings' });
  await expect(dialog).toBeVisible();
  return { settings, opener, dialog };
}

/** Focuses a binding's Change button, presses Enter to capture, then presses `key`. */
async function rebind(page: Page, dialog: ReturnType<Page['getByRole']>, title: string, key: string) {
  await dialog.getByRole('button', { name: `Change ${title}` }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('button', { name: `Press new keys for ${title}` })).toBeFocused();
  await page.keyboard.press(key);
  await expect(dialog.getByRole('button', { name: `Change ${title}` })).toBeFocused();
}

async function startSandbox(page: Page) {
  await startWorkshop(page);
  const viewport = page.locator('ctl-viewport');
  await expect(viewport).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.locator('ctl-viewport canvas')).toBeFocused();
}

/**
 * Resolves after the viewport has drawn `count` more frames (requesting them if nothing else does).
 * The renderer draws on demand and applies held movement keys once per drawn frame, so browser
 * animation frames alone prove nothing: a bound key would be walked on each of these.
 */
const frames = (page: Page, count: number) =>
  page.evaluate((n) => (window as unknown as Hooks).__controlsViewport?.afterFrames(n), count);

/** In Key bindings: tool-belt slot 2 → Q (a command) and walk forward → I (an input action). */
async function rebindSlot2AndWalkForward(page: Page, dialog: ReturnType<Page['getByRole']>) {
  await rebind(page, dialog, 'Tool-belt slot 2', 'KeyQ');
  await expect(dialog.getByTestId('keys-toolbelt.select.slot2')).toHaveText('Q');
  await rebind(page, dialog, 'Walk forward', 'KeyI');
  await expect(dialog.getByTestId('keys-input.moveForward')).toHaveText('I');
}

/** Closes Key bindings, then Settings, with Escape, and waits for the debounced save. */
async function closeAndSave(page: Page, keyBindings: Awaited<ReturnType<typeof openKeyBindings>>) {
  // Escape closes the rebinding dialog only and returns focus to Key bindings…; again closes settings.
  await page.keyboard.press('Escape');
  await expect(keyBindings.dialog).toBeHidden();
  await expect(keyBindings.opener).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(keyBindings.settings).toBeHidden();
  await expect.poll(() => stored(page)).toContain('"toolbelt.select.slot2": "Q"');
  expect(await stored(page)).toContain('"input.moveForward": "I"');
}

// One flow per test, each from a fresh page (and so fresh localStorage): as a single test this ran
// to the 30 s timeout on a loaded machine (before on-demand rendering every step cost a frame; see support/focus.ts).

test('a conflicting rebind is shown on both bindings, and Escape while capturing cancels only the capture', async ({
  page,
}) => {
  await page.goto('/?e2e=1&renderer=webgl2');
  const { dialog } = await openKeyBindings(page);

  // A conflict is shown on both bindings, never silently shadowed; Reset clears it.
  await rebind(page, dialog, 'Tool-belt slot 3', 'KeyW');
  await expect(dialog.getByTestId('keybinding-conflicts')).toContainText('1 conflict');
  await expect(dialog.getByRole('row', { name: /^Walk forward/ })).toContainText(
    'Conflicts with Tool-belt slot 3 on W',
  );
  await dialog.getByRole('button', { name: 'Reset Tool-belt slot 3' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByTestId('keybinding-conflicts')).toHaveText('No conflicts.');

  // Escape while capturing cancels the capture only.
  await dialog.getByRole('button', { name: 'Change Undo' }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('keys-edit.undo')).toHaveText(/Ctrl\+Z/);
});

test('a rebound command runs on its new key, and the old key does nothing', async ({ page }) => {
  await page.goto('/?e2e=1&renderer=webgl2');
  const keyBindings = await openKeyBindings(page);
  await rebindSlot2AndWalkForward(page, keyBindings.dialog);
  await closeAndSave(page, keyBindings);

  await startSandbox(page);
  const tool = page.getByTestId('hud-tool');
  await page.keyboard.press('Digit2'); // no longer bound
  await page.keyboard.press('KeyQ');
  await expect(tool).toHaveText('2: Crate');
  expect(await entries(page)).toEqual([{ id: 'toolbelt.select', args: { slot: 2 } }]);
});

test('rebinds survive a reload: the command, and an input action that never reaches the log; Reset all restores them', async ({
  page,
}) => {
  await page.goto('/?e2e=1&renderer=webgl2');
  const keyBindings = await openKeyBindings(page);
  await rebindSlot2AndWalkForward(page, keyBindings.dialog);
  await closeAndSave(page, keyBindings);

  // After a reload the new keys still work: the command…
  await page.reload();
  await startSandbox(page);
  const tool = page.getByTestId('hud-tool');
  await expect(tool).toHaveText('None');
  await page.keyboard.press('KeyQ');
  await expect(tool).toHaveText('2: Crate');

  // …V is the view.mode command (logged, F1.7)…
  await page.keyboard.press('KeyV');
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-mode', 'walk');
  const logged = [
    { id: 'toolbelt.select', args: { slot: 2 } },
    { id: 'view.mode', args: { mode: 'walk' } },
  ];
  expect(await entries(page)).toEqual(logged);
  // …and the rebound input action moves the camera without touching the replay log. Movement is
  // applied per frame, so holding a key for a few frames is enough to show whether it is bound.
  const start = await cameraZ(page);
  await page.keyboard.down('KeyW'); // no longer bound
  await frames(page, 5);
  await page.keyboard.up('KeyW');
  expect(await cameraZ(page)).toBe(start);
  await page.keyboard.down('KeyI');
  await expect.poll(() => cameraZ(page)).toBeLessThan(start);
  await page.keyboard.up('KeyI');
  expect(await entries(page)).toEqual(logged);

  // And the rebinding screen still shows them; Reset all restores the defaults. The crate is still
  // the active tool, so the first Escape puts it away (F1.7: cancel placement, then the menu).
  await page.keyboard.press('Escape');
  await expect(tool).toHaveText('None');
  expect(await entries(page)).toEqual(logged); // cancelling placement is not a command
  await page.keyboard.press('Escape');
  const again = await openKeyBindings(page);
  await expect(again.dialog.getByTestId('keys-toolbelt.select.slot2')).toHaveText('Q');
  await again.dialog.getByRole('button', { name: 'Reset all bindings' }).focus();
  await page.keyboard.press('Enter');
  await expect(again.dialog.getByTestId('keys-toolbelt.select.slot2')).toHaveText('2');
  await expect.poll(() => stored(page)).toContain('"keybindings": {}');
});
