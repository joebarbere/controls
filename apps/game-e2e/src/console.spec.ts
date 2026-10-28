import { expect, type Locator, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * F1.5 dev console, keyboard only: backtick opens it, a line places an object (with Tab
 * completion), a parse error points at its column, `edit.undo` undoes the place, ↑ recalls a line
 * from history (which survives a reload) and `world.hash` prints the hash. `run` runs a
 * console-line file.
 *
 * Hash cross-checks: CONSOLE_PLACE_UNDO_HASH is the literal `apps/sim-cli/src/console-place-undo.spec.ts` pins for
 * `apps/sim-cli/scenarios/console-place-undo.console` (the lines typed below),
 * and FOUR_SURFACE_HASH is `apps/sim-cli/src/four-surface.spec.ts`'s. Change them together.
 */
const CONSOLE_PLACE_UNDO_HASH = 'e5e9a9fcd6ab93f0ae928adfc86c01c20c83230a668775fa886e98351ef7a047';
const FOUR_SURFACE_HASH = 'a61268c711b69ba5bafaeeda6ba00d3340eba691322ca3a20255044b669560ee';

const PLACE =
  'entity.place --ref.id prop.crate --ref.version 1 --positionMm.x 100 --positionMm.y 0 --positionMm.z -200';

type Hooks = {
  __controlsSession?: {
    hash(): string;
    world(): { entities: readonly unknown[] };
    entries(): ReadonlyArray<{ id: string }>;
  };
};
const sessionHash = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__controlsSession?.hash());
const entityCount = (page: Page) =>
  page.evaluate(() => (window as unknown as Hooks).__controlsSession?.world().entities.length);
const loggedIds = (page: Page) =>
  page.evaluate(() => ((window as unknown as Hooks).__controlsSession?.entries() ?? []).map((e) => e.id));

async function startSandbox(page: Page) {
  await page.getByRole('navigation', { name: 'Controls' }).getByRole('button', { name: 'New sandbox' }).click();
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.locator('ctl-viewport canvas')).toBeFocused();
  // CodeMirror is a lazy chunk; it loads as soon as the console is available.
  await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
}

/** Opens the console with the backtick key and returns its input. */
async function openConsole(page: Page): Promise<Locator> {
  await page.keyboard.press('Backquote');
  const input = page.getByRole('textbox', { name: 'Console input' });
  await expect(input).toBeFocused();
  return input;
}

const lastOutput = (page: Page) => page.getByTestId('console-output').locator('.entry').last();

test('place an object, undo, recall a line from history and print the hash, keyboard only', async ({ page }) => {
  test.slow(); // the WebGL2 software renderer makes each key round-trip slow on CI runners
  await page.goto('/?e2e=1&renderer=webgl2');
  await startSandbox(page);
  const input = await openConsole(page);
  const log = page.getByRole('log', { name: 'Console output' });
  const hint = page.locator('#ctl-console-hint');

  // Visible focus on the CodeMirror input, like every other control.
  const outline = await input.evaluate((el) => ({
    visible: el.matches(':focus-visible'),
    width: parseFloat(getComputedStyle(el).outlineWidth),
  }));
  expect(outline.visible).toBe(true);
  expect(outline.width).toBeGreaterThanOrEqual(2);

  // Tab completes the id and a flag name from the registry.
  await page.keyboard.type('entity.pl');
  await page.keyboard.press('Tab');
  await expect(input).toHaveText('entity.place ');
  await page.keyboard.type('--ref.i');
  await page.keyboard.press('Tab');
  await expect(input).toHaveText('entity.place --ref.id ');
  await page.keyboard.insertText(PLACE.slice('entity.place --ref.id '.length));
  await expect(input).toHaveText(PLACE);
  await page.keyboard.press('Enter');
  await expect(lastOutput(page)).toHaveText(/entity\.place: ok/);
  await expect(input).toHaveText('');
  expect(await entityCount(page)).toBe(1);

  // A parse error points at its column and keeps the line for fixing.
  await page.keyboard.insertText('entity.place --idd 1');
  await page.keyboard.press('Enter');
  await expect(hint).toHaveText('Column 14: Unknown argument --idd');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(log).toContainText('Column 14: Unknown argument --idd');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await expect(input).toHaveText('');
  await expect(input).toHaveAttribute('aria-invalid', 'false');

  await page.keyboard.type('edit.undo');
  await page.keyboard.press('Enter');
  await expect(lastOutput(page)).toHaveText(/edit\.undo: ok/);
  expect(await entityCount(page)).toBe(0);

  // ↑ walks back through the history (newest first); ↓ past the newest gives back the draft.
  await page.keyboard.type('draft');
  await page.keyboard.press('ArrowUp');
  await expect(input).toHaveText('edit.undo');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(input).toHaveText(PLACE);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(input).toHaveText('draft');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');

  // world.hash is read-only and not logged; after place + undo it is the place-undo literal.
  const logged = await loggedIds(page);
  await page.keyboard.type('world.hash');
  await page.keyboard.press('Enter');
  await expect(lastOutput(page)).toHaveText(CONSOLE_PLACE_UNDO_HASH);
  expect(await sessionHash(page)).toBe(CONSOLE_PLACE_UNDO_HASH);
  expect(await loggedIds(page)).toEqual(logged);
  expect(logged.filter((id) => id.startsWith('entity.') || id.startsWith('edit.'))).toEqual([
    'entity.place',
    'edit.undo',
  ]);

  // `help <id>` is generated from the registry.
  await page.keyboard.insertText('help entity.move');
  await page.keyboard.press('Enter');
  await expect(log).toContainText('Usage: entity.move <id> --positionMm.x <-10000000..10000000>');

  // Backtick closes the console from inside it and focus goes back to the viewport.
  await page.keyboard.press('Backquote');
  await expect(page.getByRole('region', { name: 'Console' })).toBeHidden();
  await expect(page.locator('ctl-viewport canvas')).toBeFocused();

  // History is saved in settings and survives a reload. Settings writes are debounced, so wait for
  // the newest line to reach storage first.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('controls.settings') ?? ''))
    .toContain('help entity.move');
  await page.reload();
  await startSandbox(page);
  await openConsole(page);
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('textbox', { name: 'Console input' })).toHaveText('help entity.move');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('textbox', { name: 'Console input' })).toHaveText('world.hash');
});

test('run picks a console-line file and runs it (the four-surface scenario)', async ({ page }) => {
  await page.goto('/?e2e=1&renderer=webgl2');
  await startSandbox(page);
  await openConsole(page);
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.type('run');
  await page.keyboard.press('Enter');
  const text = readFileSync(join(__dirname, '../../sim-cli/scenarios/four-surface.console'));
  await (await chooser).setFiles({ name: 'four-surface.console', mimeType: 'text/plain', buffer: text });
  const log = page.getByRole('log', { name: 'Console output' });
  await expect(lastOutput(page)).toHaveText('Ran 10 commands from four-surface.console.');
  await expect(log).toContainText(FOUR_SURFACE_HASH);
  expect(await sessionHash(page)).toBe(FOUR_SURFACE_HASH);
});
