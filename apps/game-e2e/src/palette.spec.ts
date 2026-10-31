import { workspaceRoot } from '@nx/devkit';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectVisibleFocus } from './support/focus';
import { enterSeed } from './support/sandbox';

/**
 * F1.3 acceptance: place an object, then undo it, using only the command palette and the keyboard
 * (arrows, Enter, Escape and typing; no Tab, no mouse). The final `world.hash` must equal
 * PALETTE_PLACE_UNDO_HASH, the literal `apps/sim-cli/src/palette-place-undo.spec.ts` gets from
 * `sim run scenarios/palette-place-undo.console`, and the replay log must hold the command ids of
 * that file, so the palette path is checked against the console-line path. Change them together.
 * The session is the workshop level with seed 0 (F1.9), typed into the new-game dialog.
 */
const PALETTE_PLACE_UNDO_HASH = '34a83dc825c1e6b934132ca1f766a36f895c173ecfbc73274d197058b21ba780';

const SCENARIO = join(workspaceRoot, 'apps/sim-cli/scenarios/palette-place-undo.console');

// The hooks are typed in viewport.spec.ts and world-hash.spec.ts (global Window augmentations);
// this file reads them through a local cast so the declarations don't clash.
type Hooks = {
  __controlsSession?: {
    hash(): Promise<string>;
    entries(): ReadonlyArray<{ id: string }>;
    busWorld(): { entities: ReadonlyArray<{ ref: { id: string } }> };
  };
};

const props = (page: Page) =>
  page.evaluate(() => ((window as unknown as Hooks).__controlsSession?.busWorld().entities ?? []).map((e) => e.ref.id));
const hash = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__controlsSession?.hash() ?? '');
const loggedIds = (page: Page) =>
  page.evaluate(() => ((window as unknown as Hooks).__controlsSession?.entries() ?? []).map((e) => e.id));

/** Command ids of a console-line file, in order (comments, blank lines and `world.hash` dropped). */
function scenarioIds(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '' && line !== 'world.hash')
    .map((line) => line.split(/\s+/)[0]);
}

/** Fills the focused field, then ArrowDown to the next one. */
async function fill(page: Page, form: Locator, label: string, value: string) {
  await expect(form.getByRole('textbox', { name: label, exact: true })).toBeFocused();
  await page.keyboard.type(value);
  await page.keyboard.press('ArrowDown');
}

test('place an object, then undo it, using only the palette and the keyboard', async ({ page }) => {
  await page.goto('/?e2e=1&renderer=webgl2');
  const menu = page.getByRole('navigation', { name: 'Controls' });
  await expect(menu.getByRole('button', { name: 'New sandbox' })).toBeFocused();
  await page.keyboard.press('Enter');
  await enterSeed(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  const canvas = page.locator('ctl-viewport canvas');
  await expect(canvas).toBeFocused();

  const palette = page.getByRole('dialog', { name: 'Command palette' });
  const search = palette.getByRole('combobox', { name: 'Search commands' });

  // Ctrl+K opens it on the search field; Escape closes it and focus returns to the canvas.
  await page.keyboard.press('Control+K');
  await expectVisibleFocus(page, search);
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  await expect(canvas).toBeFocused();

  // Ctrl+Shift+P, search, Enter: the generated form for entity.place.
  await page.keyboard.press('Control+Shift+P');
  await expectVisibleFocus(page, search);
  await page.keyboard.type('place');
  await expect(search).toHaveAttribute('aria-activedescendant', /option-0$/);
  await expect(palette.getByRole('option').first()).toHaveAttribute('data-command', 'entity.place');
  await page.keyboard.press('Enter');
  const form = palette.getByRole('form', { name: 'Arguments for Place object' });
  await expect(form).toBeVisible();

  // Running it empty shows the schema's errors inline and keeps focus on the first invalid field.
  await page.keyboard.press('Enter');
  await expect(form.getByText('Required').first()).toBeVisible();
  await expect(form.getByRole('textbox', { name: 'ID' })).toHaveAttribute('aria-invalid', 'true');
  await expect(form.getByRole('textbox', { name: 'ID' })).toBeFocused();

  for (const [label, value] of [
    ['ID', 'prop.crate'],
    ['Version', '1'],
    ['X', '100'],
    ['Y', '0'],
    ['Z', '-200'],
  ] as const) {
    await fill(page, form, label, value);
  }
  await expect(form.getByRole('textbox', { name: 'Yaw' })).toHaveValue('0'); // the schema default
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(canvas).toBeFocused();
  expect(await props(page)).toEqual(['prop.crate']);

  // Recent commands come first: Ctrl+K, Enter reopens Place object without typing.
  await page.keyboard.press('Control+K');
  const first = palette.getByRole('option').first();
  await expect(first).toHaveAttribute('data-command', 'entity.place');
  await expect(first).toContainText('Recent');
  await page.keyboard.press('Enter');
  await expect(form).toBeVisible();
  for (const [label, value] of [
    ['ID', 'prop.spool'],
    ['Version', '1'],
    ['X', '400'],
    ['Y', '0'],
    ['Z', '-200'],
  ] as const) {
    await fill(page, form, label, value);
  }
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  expect(await props(page)).toEqual(['prop.crate', 'prop.spool']);

  // Undo through the palette. With nothing typed it is listed (enabled now) below the recent
  // Place object; the arrow keys move the active option, and typing narrows the list.
  await page.keyboard.press('Control+K');
  const undo = palette.getByRole('option', { name: /^Undo/ });
  await expect(undo).not.toHaveAttribute('aria-disabled', 'true');
  await expect(undo).toHaveAttribute('aria-selected', 'false');
  await page.keyboard.press('ArrowUp'); // wraps to the last option
  await expect(palette.getByRole('option').last()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown'); // and back to the first
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.type('undo');
  await expect(palette.getByRole('option')).toHaveCount(1);
  await expect(undo).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(canvas).toBeFocused();

  expect(await props(page)).toEqual(['prop.crate']);
  expect(await hash(page)).toBe(PALETTE_PLACE_UNDO_HASH);
  expect(await loggedIds(page)).toEqual(scenarioIds(SCENARIO));
});
