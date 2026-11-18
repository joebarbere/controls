import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { enterSeed, startSandbox } from './support/sandbox';

/**
 * F1.8b part 3: saving and loading through the UI, in the web harness (saves in OPFS). Each test is
 * one short flow from a fresh page (docs/caveats/ui.md: a round trip can cost a frame here). World
 * changes go through the session hook to keep the flows short; saving and loading go through the UI.
 */

interface Hooks {
  __controlsSession: { exec(id: string, args?: unknown): { ok: boolean }; hash(): Promise<string> };
  __controlsPlatform: {
    files: { list(): Promise<{ handle: string; name: string }[]>; read(h: string): Promise<Uint8Array> };
  };
}

const PLACE = { ref: { id: 'prop.crate', version: 1 }, positionMm: { x: 100, y: 0, z: -200 } };

async function open(page: Page): Promise<void> {
  await page.goto('/?e2e=1');
  await page.waitForFunction(() => '__controlsSession' in globalThis && '__controlsPlatform' in globalThis);
}

/** Places a crate through the session hook and returns the new world hash. */
function placeCrate(page: Page): Promise<string> {
  return page.evaluate((args) => {
    const { __controlsSession: session } = globalThis as unknown as Hooks;
    if (!session.exec('entity.place', args).ok) throw new Error('entity.place refused');
    return session.hash();
  }, PLACE);
}

const hash = (page: Page) => page.evaluate(() => (globalThis as unknown as Hooks).__controlsSession.hash());
const menu = (page: Page) => page.getByRole('navigation', { name: 'Controls' });

test('a game saved from the menu survives a reload, and Continue reaches the same world hash', async ({ page }) => {
  await open(page);
  await expect(menu(page).getByRole('button', { name: 'Continue' })).toHaveAttribute('aria-disabled', 'true');
  await startSandbox(page);
  const saved = await placeCrate(page);

  await page.getByRole('button', { name: 'Menu' }).click();
  await menu(page).getByRole('button', { name: 'Save game' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save game' });
  await expect(dialog.getByRole('textbox', { name: 'Save name' })).toBeFocused();
  await page.keyboard.insertText('E2E shop'); // the suggested name is selected, so typing replaces it
  await page.keyboard.press('Enter');
  await expect(page.getByText('Saved “E2E shop”.')).toBeVisible();

  // The save carries a PNG of the viewport (thumbnail.png in the ZIP's directory).
  const hasThumbnail = await page.evaluate(async () => {
    const { files } = (globalThis as unknown as Hooks).__controlsPlatform;
    const entry = (await files.list()).find((e) => e.name === 'E2E shop');
    const bytes = await files.read(entry?.handle ?? '');
    return new TextDecoder('latin1').decode(bytes).includes('thumbnail.png');
  });
  expect(hasThumbnail).toBe(true);

  await page.reload();
  await open(page);
  expect(await hash(page)).not.toBe(saved); // the menu backdrop is the bare level
  await menu(page).getByRole('button', { name: 'Continue' }).click();
  await expect(menu(page)).toBeHidden();
  await expect(page.locator('ctl-viewport canvas')).toBeFocused();
  expect(await hash(page)).toBe(saved);
});

// Mod is Ctrl here on every host OS: the project emulates Desktop Chrome, whose user agent is Windows,
// so the app's key platform is 'other' even on a macOS runner. `ControlOrMeta` would press Cmd there.
test('keyboard only: Mod+S names a save, Mod+L lists it, Enter loads it back', async ({ page }) => {
  await open(page);
  await startSandbox(page);
  const saved = await placeCrate(page);

  await page.keyboard.press('Control+S');
  const saveDialog = page.getByRole('dialog', { name: 'Save game' });
  await expect(saveDialog.getByRole('textbox', { name: 'Save name' })).toHaveValue('Sandbox 0');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Saved “Sandbox 0”.')).toBeVisible();
  await expect(page.locator('ctl-viewport canvas')).toBeFocused(); // focus went back to the opener

  // A different game: New sandbox from the menu with another seed.
  await page.keyboard.press('Escape');
  await menu(page).getByRole('button', { name: 'New sandbox' }).focus();
  await page.keyboard.press('Enter');
  await enterSeed(page, 1);
  expect(await hash(page)).not.toBe(saved);

  await page.keyboard.press('Control+L');
  const loadDialog = page.getByRole('dialog', { name: 'Load game' });
  await expect(loadDialog.getByRole('button', { name: 'Sandbox 0', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(loadDialog).toBeHidden();
  await expect(page.getByText('Loaded “Sandbox 0”.')).toBeVisible();
  expect(await hash(page)).toBe(saved);
});

// The bug Continue had at F1.8b part 3: loading X over unsaved changes autosaves the game being left,
// and that autosave is then the newest file. Continue must still resume X (settings.saves.lastPlayed).
test('Continue resumes the game loaded last, not the newer autosave of the game it replaced', async ({ page }) => {
  await open(page);
  await startSandbox(page);
  const x = await placeCrate(page);
  await page.keyboard.press('Control+S');
  await expect(page.getByRole('textbox', { name: 'Save name' })).toHaveValue('Sandbox 0');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Saved “Sandbox 0”.')).toBeVisible();

  await page.keyboard.press('Escape');
  await menu(page).getByRole('button', { name: 'New sandbox' }).click();
  await enterSeed(page, 1);
  await placeCrate(page); // game A, with unsaved changes

  await page.keyboard.press('Control+L');
  await page.getByRole('dialog', { name: 'Load game' }).getByRole('button', { name: 'Sandbox 0', exact: true }).click();
  await expect(page.getByText('Loaded “Sandbox 0”.')).toBeVisible();
  const names = await page.evaluate(async () =>
    (await (globalThis as unknown as Hooks).__controlsPlatform.files.list()).map((e) => e.name),
  );
  expect(names).toEqual(['Autosave 1', 'Sandbox 0']); // A was autosaved, and is the newest save

  await page.reload(); // quit without changing X
  await open(page);
  await menu(page).getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Loaded “Sandbox 0”.')).toBeVisible();
  expect(await hash(page)).toBe(x);
});

test('Save to a file downloads the save, and Open file uploads it back to the same hash', async ({ page }) => {
  await open(page);
  await startSandbox(page);
  const saved = await placeCrate(page);

  const downloading = page.waitForEvent('download');
  await page.keyboard.press('Control+Shift+S');
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('Sandbox 0.ctrl');
  const bytes = await readFile((await download.path()) ?? '');

  await page.keyboard.press('Escape');
  await menu(page).getByRole('button', { name: 'New sandbox' }).click();
  await enterSeed(page, 1);
  expect(await hash(page)).not.toBe(saved);

  const choosing = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+O');
  const chooser = await choosing;
  await chooser.setFiles({ name: 'Sandbox 0.ctrl', mimeType: 'application/octet-stream', buffer: bytes });
  await expect(page.getByText('Loaded “Sandbox 0.ctrl”.')).toBeVisible();
  expect(await hash(page)).toBe(saved);
});

/**
 * Saves the game as `name` through the Save game dialog: opened with Mod+S (a game without a name
 * yet: it asks) or from the open menu's Save game (it always asks).
 */
async function saveAs(page: Page, name: string, via: 'keys' | 'menu'): Promise<void> {
  if (via === 'menu') await menu(page).getByRole('button', { name: 'Save game' }).click();
  else await page.keyboard.press('Control+S');
  await expect(page.getByRole('textbox', { name: 'Save name' })).toBeFocused();
  await page.keyboard.insertText(name); // replaces the selected suggestion
  await page.keyboard.press('Enter');
  await expect(page.getByText(`Saved “${name}”.`)).toBeVisible();
}

// P4 Saves: the Load list shows each save's thumbnail (read on its own from the ZIP) and deletes a
// save after a confirmation, all from the keyboard, with focus never falling to the page.
test('the Load list shows thumbnails and deletes a save after a confirmation from the keyboard', async ({ page }) => {
  await open(page);
  await startSandbox(page);
  await placeCrate(page);
  // Saved before the menu opens, so returning to it has nothing unsaved to autosave into the list.
  await saveAs(page, 'Keep me', 'keys');
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(menu(page)).toBeVisible();
  await saveAs(page, 'Delete me', 'menu');

  await menu(page).getByRole('button', { name: 'Load' }).click();
  const dialog = page.getByRole('dialog', { name: 'Load game' });
  await expect(dialog.getByRole('button', { name: 'Delete me', exact: true })).toBeFocused();
  // Both saves carry a viewport PNG (at most 320 × 180, the viewport's aspect), decoded and drawn.
  const thumbnails = dialog.getByTestId('load-thumbnail');
  await expect(thumbnails).toHaveCount(2);
  await expect
    .poll(() =>
      thumbnails.evaluateAll((images) =>
        images.map((img) => {
          const { naturalWidth: w, naturalHeight: h } = img as HTMLImageElement;
          return w > 0 && w <= 320 && h > 0 && h <= 180;
        }),
      ),
    )
    .toEqual([true, true]);
  expect(await thumbnails.first().getAttribute('src')).toMatch(/^blob:/);

  // Delete asks, with focus on Keep; Escape goes back to the row's Delete button and the dialog stays.
  await page.keyboard.press('Delete');
  const question = dialog.getByRole('group', { name: 'Delete “Delete me”? This can’t be undone.' });
  await expect(question.getByRole('button', { name: 'Keep' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Delete Delete me' })).toBeFocused();

  await page.keyboard.press('Enter'); // the row's Delete button asks again
  await expect(question.getByRole('button', { name: 'Keep' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(question.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Deleted “Delete me”.')).toBeVisible();
  await expect(dialog.getByTestId('load-entry')).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Keep me', exact: true })).toBeFocused();
  const names = await page.evaluate(async () =>
    (await (globalThis as unknown as Hooks).__controlsPlatform.files.list()).map((e) => e.name),
  );
  expect(names).toEqual(['Keep me']);
});
