import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hashAfter, newSandbox, PLACE } from './game';
import { createProfile, launchControls, removeProfile } from './launch';

// Two launches against one CONTROLS_USER_DATA_DIR, so dev build only (see settings-persistence.spec.ts).
test.skip(!!process.env['CONTROLS_E2E_EXECUTABLE'], 'relaunch is only tested against the dev build');

const profile = createProfile();
test.afterAll(() => removeProfile(profile));

/** `saves.lastPlayed` from the stored settings file, or null. */
const storedLastPlayed = (): unknown => {
  const file = join(profile, 'settings.json');
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { saves?: { lastPlayed?: unknown } }).saves?.lastPlayed
    : null;
};

// Loading X over unsaved changes autosaves the game being left, which is then the newest file;
// Continue in the next launch must still resume X (settings.saves.lastPlayed, ADR 0009).
test('Continue in the next launch resumes the game loaded last, not the autosave of the one it replaced', async () => {
  let x = '';
  const first = await launchControls({ userDataDir: profile });
  try {
    const { window } = first;
    const menu = window.getByRole('navigation', { name: 'Controls' });
    await newSandbox(window, 0);
    x = await hashAfter(window, PLACE);
    await window.getByRole('button', { name: 'Menu' }).click();
    await menu.getByRole('button', { name: 'Save game' }).click();
    await expect(window.getByRole('textbox', { name: 'Save name' })).toBeFocused();
    await window.keyboard.insertText('X');
    await window.keyboard.press('Enter');
    await expect(window.getByText('Saved “X”.')).toBeVisible();

    await newSandbox(window, 1);
    await hashAfter(window, PLACE); // game A, with unsaved changes
    await window.getByRole('button', { name: 'Menu' }).click(); // autosaves A on the way
    await menu.getByRole('button', { name: 'Load' }).click();
    await window.getByRole('dialog', { name: 'Load game' }).getByRole('button', { name: 'X', exact: true }).click();
    await expect(window.getByText('Loaded “X”.')).toBeVisible();
    // Slot 1: X, autosaved on the way to Save game. Slot 2: A, the newest save on disk.
    expect(readdirSync(join(profile, 'saves', 'autosave'))).toEqual(['slot-1.ctrl', 'slot-2.ctrl']);
  } finally {
    await first.close(); // quit without changing X
  }
  expect(storedLastPlayed()).toEqual({ kind: 'manual', name: 'X' });

  const second = await launchControls({ userDataDir: profile });
  try {
    const { window } = second;
    await window.getByRole('navigation', { name: 'Controls' }).getByRole('button', { name: 'Continue' }).click();
    await expect(window.getByText('Loaded “X”.')).toBeVisible();
    expect(await hashAfter(window)).toBe(x);
  } finally {
    await second.close();
  }
});
