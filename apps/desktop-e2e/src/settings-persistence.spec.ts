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
      // Written atomically by main after the save debounce.
      await expect.poll(() => existsSync(settingsFile) && readFileSync(settingsFile, 'utf8')).toContain('"metric"');
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
