import { expect, test, type Page } from '@playwright/test';
import { startSandbox } from './support/sandbox';

// F1.1: settings persist across a reload in the web harness (localStorage), and an unreadable
// stored document falls back to defaults with a warning.

const KEY = 'controls.settings';
const stored = (page: Page) => page.evaluate((key) => localStorage.getItem(key), KEY);

// One reload per test, each from a fresh page: settings and the panel layout together, with two
// New sandbox starts, ran to the 30 s timeout on a loaded machine.

test('a settings change survives a reload', async ({ page }) => {
  await page.goto('/');
  const menu = page.getByRole('navigation', { name: 'Controls' });
  await menu.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('radio', { name: 'Dark' }).check();
  await settings.getByRole('radio', { name: 'Metric (mm, m, mm²)' }).check();
  await settings.getByRole('combobox', { name: 'Default for new games' }).selectOption('Realistic');
  await settings.getByRole('button', { name: 'Back' }).click();

  // Saves are debounced; wait for the write rather than a fixed delay.
  await expect.poll(() => stored(page)).toContain('"defaultDifficulty": "realistic"');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await menu.getByRole('button', { name: 'Settings' }).click();
  await expect(settings.getByRole('radio', { name: 'Dark' })).toBeChecked();
  await expect(settings.getByRole('radio', { name: 'Metric (mm, m, mm²)' })).toBeChecked();
  await expect(settings.getByRole('combobox', { name: 'Default for new games' })).toHaveValue('realistic');
});

test('the panel layout survives a reload', async ({ page }) => {
  await page.goto('/');
  await startSandbox(page);
  const splitter = page.getByRole('separator', { name: 'Resize inspector' });
  await splitter.focus();
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(splitter).toHaveAttribute('aria-valuenow', '384');

  // Saves are debounced; wait for the write rather than a fixed delay.
  await expect.poll(() => stored(page)).toContain('"inspector": {\n        "size": 384');

  await page.reload();
  await startSandbox(page);
  await expect(splitter).toHaveAttribute('aria-valuenow', '384');
});

// Flush before quit, web harness: a change still inside the save debounce is written on `pagehide`.
test('a settings change made just before a reload is not lost', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Controls' }).getByRole('button', { name: 'Settings' }).click();
  const light = page.getByRole('dialog', { name: 'Settings' }).getByRole('radio', { name: 'Light' });
  await expect(light).toBeVisible();
  // Change and reload in one task, so the 300 ms debounce can't have fired before the page goes.
  const loaded = page.waitForEvent('load');
  await light
    .evaluate((radio: HTMLInputElement) => {
      radio.click();
      location.reload();
    })
    .catch(() => undefined); // the reload may tear down the evaluation's context
  await loaded;
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await stored(page)).toContain('"theme": "light"');
});

test('an unreadable stored document falls back to defaults with a warning', async ({ page }) => {
  await page.addInitScript((key) => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem(key, JSON.stringify({ settingsVersion: 99 })); // from a newer build
      sessionStorage.setItem('seeded', '1');
    }
  }, KEY);
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('could not be read');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  // Nothing is written back until the player changes something, so the newer file isn't clobbered.
  expect(await stored(page)).toBe(JSON.stringify({ settingsVersion: 99 }));
});
