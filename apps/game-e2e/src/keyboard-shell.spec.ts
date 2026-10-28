import { expect, type Locator, type Page, test } from '@playwright/test';
import { expectVisibleFocus, tabTo } from './support/focus';
import { enterSeed } from './support/sandbox';

// F1.1 acceptance: the shell is fully operable without a mouse, focus is always visible, and
// focus returns to the opener after each dialog closes. Every step below uses the keyboard only.
// One flow per test, each from a fresh page: a single walk through every dialog took 28 s locally
// and hit the 30 s test timeout on Windows CI (support/focus.ts says why each step is slow).

interface MainMenu {
  menu: Locator;
  newSandbox: Locator;
  settings: Locator;
  about: Locator;
}

/** Loads the app and returns the main menu, which takes focus at boot (New sandbox). */
async function openMenu(page: Page): Promise<MainMenu> {
  await page.goto('/');
  const menu = page.getByRole('navigation', { name: 'Controls' });
  const m: MainMenu = {
    menu,
    newSandbox: menu.getByRole('button', { name: 'New sandbox' }),
    settings: menu.getByRole('button', { name: 'Settings' }),
    about: menu.getByRole('button', { name: 'About' }),
  };
  await expect(m.newSandbox).toBeFocused();
  return m;
}

/** From the main menu at boot: Enter on New sandbox, seed 0, and the canvas has visible focus. */
async function startSandboxByKeyboard(page: Page, m: MainMenu): Promise<Locator> {
  await page.keyboard.press('Enter');
  await enterSeed(page);
  await expect(m.menu).toBeHidden();
  // The canvas is the single viewport focus target (the region around it is a landmark only).
  const canvas = page.getByRole('region', { name: '3D viewport' }).locator('canvas');
  await expectVisibleFocus(page, canvas);
  return canvas;
}

test('the main menu at boot: New sandbox focused, Continue disabled with no saves, no Quit in a browser', async ({
  page,
}) => {
  const { menu } = await openMenu(page);
  // A fresh profile has no saves: Continue is present but disabled, with the reason; Load still works.
  await expect(menu.getByRole('button', { name: 'Continue' })).toHaveAttribute('aria-disabled', 'true');
  await expect(menu.getByRole('button', { name: 'Continue' })).toHaveAccessibleDescription('No saved games yet.');
  await expect(menu.getByRole('button', { name: 'Load' })).not.toHaveAttribute('aria-disabled');
  await expect(menu.getByRole('button', { name: 'Quit' })).toHaveCount(0); // a browser tab can't quit
});

test('settings: open, change the theme, focus is trapped, Back returns focus to Settings, keyboard only', async ({
  page,
}) => {
  const m = await openMenu(page);
  await tabTo(page, m.settings);
  await expectVisibleFocus(page, m.settings);
  await page.keyboard.press('Enter');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await expectVisibleFocus(page, settings.getByRole('radio', { name: 'Match system' }));

  // Change a setting with the keyboard: the theme radios.
  await page.keyboard.press('ArrowDown'); // Light
  await expect(settings.getByRole('radio', { name: 'Light' })).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // Focus stays trapped in the dialog: Shift+Tab from the first control wraps to Back.
  await page.keyboard.press('Shift+Tab');
  await expectVisibleFocus(page, settings.getByRole('button', { name: 'Back' }));

  // Back closes it and focus returns to Settings.
  await page.keyboard.press('Enter');
  await expect(settings).toBeHidden();
  await expectVisibleFocus(page, m.settings);
});

test('about: arrow keys reach it, it shows the build, Escape returns focus to About, keyboard only', async ({
  page,
}) => {
  const m = await openMenu(page);
  // The menu is also an arrow-key list: ArrowDown moves down it and Home goes back to the top.
  await tabTo(page, m.about, 15, 'ArrowDown');
  await expectVisibleFocus(page, m.about);
  await page.keyboard.press('Enter');
  const about = page.getByRole('dialog', { name: 'About Controls' });
  await expect(about).toBeVisible();
  await expect(about.getByTestId('about-platform')).toHaveText('web harness');
  await page.keyboard.press('Escape');
  await expect(about).toBeHidden();
  await expectVisibleFocus(page, m.about);

  await page.keyboard.press('Home');
  await expectVisibleFocus(page, m.newSandbox);
});

test('New sandbox: the seed dialog starts the workshop and focus lands on the viewport, keyboard only', async ({
  page,
}) => {
  const m = await openMenu(page);
  await expectVisibleFocus(page, m.newSandbox);
  await startSandboxByKeyboard(page, m);
  await expect(page.getByRole('region', { name: 'Status' })).toContainText('Work');
});

test('Escape in the workspace: clears a selection first, then opens the menu; Resume returns to the viewport', async ({
  page,
}) => {
  const m = await openMenu(page);
  const canvas = await startSandboxByKeyboard(page, m);
  const resume = m.menu.getByRole('button', { name: 'Resume' });

  // On the canvas, Escape clears a selection first; with nothing selected it opens the menu.
  await page.keyboard.press('BracketRight');
  await page.keyboard.press('Escape');
  await expect(m.menu).toBeHidden();
  await page.keyboard.press('Escape');
  await expectVisibleFocus(page, resume);
  await page.keyboard.press('Enter');
  await expectVisibleFocus(page, canvas);

  // From the toolbar, Escape also brings the menu back with Resume focused; Enter resumes.
  const menuButton = page.getByRole('button', { name: 'Menu' });
  await tabTo(page, menuButton, 10, 'Shift+Tab');
  await expectVisibleFocus(page, menuButton);
  await page.keyboard.press('Escape');
  await expectVisibleFocus(page, resume);
  await page.keyboard.press('Enter');
  await expectVisibleFocus(page, canvas);
});

test('the new-game dialog: fresh seed, Escape backs out, an invalid seed is refused, keyboard only', async ({
  page,
}) => {
  await page.goto('/?e2e=1');
  const menu = page.getByRole('navigation', { name: 'Controls' });
  const newSandbox = menu.getByRole('button', { name: 'New sandbox' });
  await expect(newSandbox).toBeFocused();
  await page.keyboard.press('Enter');
  const newGame = page.getByRole('dialog', { name: 'New sandbox' });
  const seed = newGame.getByRole('textbox', { name: 'Seed' });
  await expectVisibleFocus(page, seed);
  await expect(seed).toHaveValue(/^\d+$/); // a fresh seed
  await page.keyboard.press('Escape');
  await expect(newGame).toBeHidden();
  await expectVisibleFocus(page, newSandbox); // focus back on the opener

  await page.keyboard.press('Enter');
  await expectVisibleFocus(page, seed);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('4294967296'); // one past the largest seed
  await page.keyboard.press('Enter');
  await expect(seed).toHaveAttribute('aria-invalid', 'true');
  await expect(newGame.getByRole('alert')).toContainText('whole number from 0 to 4294967295');
  await expect(newGame).toBeVisible();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('12345');
  await page.keyboard.press('Enter');
  await expect(newGame).toBeHidden();
  await expect(menu).toBeHidden();
  await expect(page.locator('ctl-viewport canvas')).toBeFocused();
  const world = await page.evaluate(
    () => (window as unknown as { __controlsSession: { world(): { seed: number } } }).__controlsSession.world().seed,
  );
  expect(world).toBe(12345);
});

test('workspace panels resize, collapse and reset from the keyboard', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New sandbox' }).press('Enter');
  await enterSeed(page);
  const inspector = page.getByRole('region', { name: 'Inspector' });
  await expect(inspector).toBeVisible();
  const before = (await inspector.boundingBox())?.width ?? 0;

  const splitter = page.getByRole('separator', { name: 'Resize inspector' });
  await tabTo(page, splitter);
  await expectVisibleFocus(page, splitter);
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(splitter).toHaveAttribute('aria-valuenow', '384');
  await expect.poll(async () => (await inspector.boundingBox())?.width ?? 0).toBeGreaterThan(before);

  await page.keyboard.press('Enter'); // collapse
  await expect(inspector).toBeHidden();
  await page.keyboard.press('Enter'); // restore
  await expect(inspector).toBeVisible();

  const reset = page.getByRole('button', { name: 'Reset layout' });
  await tabTo(page, reset);
  await page.keyboard.press('Enter');
  await expect(splitter).toHaveAttribute('aria-valuenow', '320');
  const toast = page.getByRole('status').filter({ hasText: 'Layout reset.' });
  await expect(toast).toBeVisible();

  // Notifications are dismissable from the keyboard.
  const dismiss = page.getByRole('button', { name: 'Dismiss notification: Layout reset.' });
  await tabTo(page, dismiss, 30);
  await page.keyboard.press('Enter');
  await expect(dismiss).toHaveCount(0);
});
