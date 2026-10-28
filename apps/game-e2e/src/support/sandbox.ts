import { expect, type Page } from '@playwright/test';

/*
 * New sandbox (F1.9) opens the new-game dialog, which offers a fresh random seed. The golden hashes
 * in these suites start from seed 0: the workshop level exactly as `content/levels/workshop.json`
 * has it, which is what the sim-cli scenarios start from (`--world content/levels/workshop.json`).
 */

/** The seed the e2e scenarios type, so New sandbox gives `content/levels/workshop.json` unchanged. */
export const E2E_SEED = 0;

/** In the open new-game dialog, replaces the fresh seed with `seed` and starts, keyboard only. */
export async function enterSeed(page: Page, seed: number = E2E_SEED): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'New sandbox' });
  const field = dialog.getByRole('textbox', { name: 'Seed' });
  await expect(field).toBeFocused(); // the first control: focused when the dialog opens
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(String(seed));
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
}

/** Clicks New sandbox in the main menu and starts with `seed`. */
export async function startSandbox(page: Page, seed: number = E2E_SEED): Promise<void> {
  await page.getByRole('navigation', { name: 'Controls' }).getByRole('button', { name: 'New sandbox' }).click();
  await enterSeed(page, seed);
}
