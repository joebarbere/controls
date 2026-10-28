import { expect, type Page } from '@playwright/test';

/** Places a crate at a fixed spot, as a console line (the desktop app has no test hook). */
export const PLACE =
  'entity.place --ref.id prop.crate --ref.version 1 --positionMm.x 100 --positionMm.y 0 --positionMm.z -200';

/** New sandbox from the main menu with `seed`, keyboard only once the dialog is open. */
export async function newSandbox(window: Page, seed: number): Promise<void> {
  await window.getByRole('navigation', { name: 'Controls' }).getByRole('button', { name: 'New sandbox' }).click();
  await expect(window.getByRole('textbox', { name: 'Seed' })).toBeFocused();
  await window.keyboard.press('ControlOrMeta+A');
  await window.keyboard.insertText(String(seed));
  await window.keyboard.press('Enter');
  await expect(window.locator('ctl-viewport canvas')).toBeFocused();
}

/**
 * Runs console lines and returns `world.hash` after them. The console is the way into the world here:
 * the desktop app has no test hook. Leaves focus in the console.
 */
export async function hashAfter(window: Page, ...lines: string[]): Promise<string> {
  await expect(window.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  const input = window.getByRole('textbox', { name: 'Console input' });
  if (!(await input.evaluate((el) => el.contains(el.ownerDocument.activeElement)))) {
    await window.keyboard.press('Backquote');
  }
  await expect(input).toBeFocused();
  const entries = window.getByTestId('console-output').locator('.entry');
  for (const line of lines) {
    await window.keyboard.insertText(line);
    await window.keyboard.press('Enter');
  }
  const before = await entries.count();
  await window.keyboard.insertText('world.hash');
  await window.keyboard.press('Enter');
  await expect.poll(() => entries.count()).toBeGreaterThan(before);
  await expect(entries.last()).toHaveText(/^[0-9a-f]{64}$/);
  return (await entries.last().textContent()) ?? '';
}
