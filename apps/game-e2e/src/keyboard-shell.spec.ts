import { expect, type Locator, type Page, test } from '@playwright/test';

// F1.1 acceptance: the shell is fully operable without a mouse, focus is always visible, and
// focus returns to the opener after each dialog closes. Every step below uses the keyboard only.

/**
 * The element has keyboard focus and a visible focus indicator: :focus-visible plus either an
 * outline of at least 2 px or a ring overlay (`::after` box-shadow, used where a canvas would
 * paint over an outline).
 */
async function expectVisibleFocus(locator: Locator): Promise<void> {
  await expect(locator).toBeFocused();
  const indicator = await locator.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      focusVisible: el.matches(':focus-visible'),
      outline: style.outlineStyle === 'none' ? 0 : parseFloat(style.outlineWidth),
      ring: getComputedStyle(el, '::after').boxShadow,
    };
  });
  expect(indicator.focusVisible).toBe(true);
  expect(indicator.outline >= 2 || indicator.ring !== 'none').toBe(true);
}

async function tabTo(page: Page, target: Locator, maxPresses = 15): Promise<void> {
  for (let i = 0; i < maxPresses; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

test('menu → settings → back → about → New sandbox, keyboard only', async ({ page }) => {
  await page.goto('/');
  const menu = page.getByRole('navigation', { name: 'Controls' });
  const newSandbox = menu.getByRole('button', { name: 'New sandbox' });
  const settingsButton = menu.getByRole('button', { name: 'Settings' });
  const aboutButton = menu.getByRole('button', { name: 'About' });

  // The menu takes focus at boot. Continue and Load are present but disabled until saves land.
  await expect(newSandbox).toBeFocused();
  await expect(menu.getByRole('button', { name: 'Continue' })).toHaveAttribute('aria-disabled', 'true');
  await expect(menu.getByRole('button', { name: 'Load' })).toHaveAttribute('aria-disabled', 'true');
  await expect(menu.getByRole('button', { name: 'Quit' })).toHaveCount(0); // a browser tab can't quit

  // Menu → Settings.
  await tabTo(page, settingsButton);
  await expectVisibleFocus(settingsButton);
  await page.keyboard.press('Enter');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  const matchSystem = settings.getByRole('radio', { name: 'Match system' });
  await expectVisibleFocus(matchSystem);

  // Change a setting with the keyboard: the theme radios.
  await page.keyboard.press('ArrowDown'); // Light
  await expect(settings.getByRole('radio', { name: 'Light' })).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // Focus stays trapped in the dialog: Shift+Tab from the first control wraps to Back.
  await page.keyboard.press('Shift+Tab');
  const back = settings.getByRole('button', { name: 'Back' });
  await expectVisibleFocus(back);

  // Back closes it and focus returns to Settings.
  await page.keyboard.press('Enter');
  await expect(settings).toBeHidden();
  await expectVisibleFocus(settingsButton);

  // About opens with the build details and Escape returns focus to About.
  await page.keyboard.press('ArrowDown');
  await expectVisibleFocus(aboutButton);
  await page.keyboard.press('Enter');
  const about = page.getByRole('dialog', { name: 'About Controls' });
  await expect(about).toBeVisible();
  await expect(about.getByTestId('about-platform')).toHaveText('web harness');
  await page.keyboard.press('Escape');
  await expect(about).toBeHidden();
  await expectVisibleFocus(aboutButton);

  // New sandbox: the menu goes and focus lands on the viewport.
  await page.keyboard.press('Home');
  await expectVisibleFocus(newSandbox);
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  const viewport = page.getByRole('region', { name: '3D viewport' });
  await expectVisibleFocus(viewport);
  await expect(page.getByRole('region', { name: 'Status' })).toContainText('Work');

  // Escape brings the menu back with Resume focused; Enter resumes.
  await page.keyboard.press('Escape');
  const resume = menu.getByRole('button', { name: 'Resume' });
  await expectVisibleFocus(resume);
  await page.keyboard.press('Enter');
  await expectVisibleFocus(viewport);
});

test('workspace panels resize, collapse and reset from the keyboard', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New sandbox' }).press('Enter');
  const inspector = page.getByRole('region', { name: 'Inspector' });
  await expect(inspector).toBeVisible();
  const before = (await inspector.boundingBox())?.width ?? 0;

  const splitter = page.getByRole('separator', { name: 'Resize inspector' });
  await tabTo(page, splitter);
  await expectVisibleFocus(splitter);
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
