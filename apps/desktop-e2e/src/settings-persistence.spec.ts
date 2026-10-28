import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProfile, launchControls, removeProfile } from './launch';

// Two launches against one CONTROLS_USER_DATA_DIR. Packaged builds get one launch per file (a
// second launch never comes up on macOS/Windows CI; see docs/caveats/release.md), so this runs only
// against the dev build path.
test.skip(!!process.env['CONTROLS_E2E_EXECUTABLE'], 'relaunch is only tested against the dev build');

test.describe.serial('settings persist across relaunches', () => {
  const profile = createProfile();
  const settingsFile = join(profile, 'settings.json');

  /** `display` from the stored file (written atomically, so it is never half a document), or null. */
  const storedDisplay = (): unknown =>
    existsSync(settingsFile) ? (JSON.parse(readFileSync(settingsFile, 'utf8')) as { display?: unknown }).display : null;

  test.afterAll(() => removeProfile(profile));

  test('a setting changed in one launch is there in the next', async () => {
    const first = await launchControls({ userDataDir: profile });
    try {
      const menu = first.window.getByRole('navigation', { name: 'Controls' });
      await menu.getByRole('button', { name: 'Settings' }).click();
      const settings = first.window.getByRole('dialog', { name: 'Settings' });
      await settings.getByRole('radio', { name: 'Metric (mm, m, mm²)' }).check();
      await settings.getByRole('radio', { name: 'Dark' }).check();
      await settings.getByRole('button', { name: 'Back' }).click();
      // Written atomically by main after the save debounce. Wait for both changes: on a slow runner
      // the Metric change can be saved on its own before Dark is checked, and a poll for "metric"
      // alone would then pass on a partial file.
      await expect.poll(storedDisplay).toMatchObject({ units: 'metric', theme: 'dark' });
    } finally {
      await first.close();
    }

    const second = await launchControls({ userDataDir: profile });
    try {
      await expect(second.window.locator('html')).toHaveAttribute('data-theme', 'dark');
      await second.window
        .getByRole('navigation', { name: 'Controls' })
        .getByRole('button', { name: 'Settings' })
        .click();
      const settings = second.window.getByRole('dialog', { name: 'Settings' });
      await expect(settings.getByRole('radio', { name: 'Metric (mm, m, mm²)' })).toBeChecked();
      await expect(settings.getByRole('radio', { name: 'Dark' })).toBeChecked();
    } finally {
      await second.close();
    }
  });

  // Regression: saves are debounced (SAVE_DEBOUNCE_MS), and before the flush-before-quit handshake
  // a change made just before quitting was still pending when the app exited, so it was lost.
  test('a setting changed just before quitting is saved before the app exits', async () => {
    const first = await launchControls({ userDataDir: profile });
    try {
      await expect(first.window.locator('html')).toHaveAttribute('data-theme', 'dark'); // from the test above
      const menu = first.window.getByRole('navigation', { name: 'Controls' });
      await menu.getByRole('button', { name: 'Settings' }).click();
      const settings = first.window.getByRole('dialog', { name: 'Settings' });
      await settings.getByRole('radio', { name: 'Light' }).check();
      await expect(first.window.locator('html')).toHaveAttribute('data-theme', 'light');
    } finally {
      await first.close(); // app.quit() at once, well inside the save debounce
    }
    expect(storedDisplay()).toMatchObject({ units: 'metric', theme: 'light' });

    const second = await launchControls({ userDataDir: profile });
    try {
      await expect(second.window.locator('html')).toHaveAttribute('data-theme', 'light');
    } finally {
      await second.close();
    }
  });

  test('a setting changed just before closing the window is saved before it closes', async () => {
    const app = await launchControls({ userDataDir: profile });
    try {
      await expect(app.window.locator('html')).toHaveAttribute('data-theme', 'light'); // from the test above
      const menu = app.window.getByRole('navigation', { name: 'Controls' });
      await menu.getByRole('button', { name: 'Settings' }).click();
      await app.window.getByRole('dialog', { name: 'Settings' }).getByRole('radio', { name: 'Dark' }).check();
      const closed = app.window.waitForEvent('close');
      await app.closeWindow?.(); // the window's `close` event, not `before-quit`
      await closed;
      expect(storedDisplay()).toMatchObject({ theme: 'dark' });
    } finally {
      await app.close(); // on macOS the app outlives its window
    }
  });

  test('a corrupt settings file falls back to defaults with a warning', async () => {
    writeFileSync(settingsFile, '{ "settingsVersion": 1, "graphics": ');
    const app = await launchControls({ userDataDir: profile });
    try {
      await expect(app.window.getByRole('alert')).toContainText('could not be read');
      await expect(app.window.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    } finally {
      await app.close();
    }
  });
});
