import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

/**
 * Checks GitHub Releases for a newer published version. Packaged builds only; opt out with
 * CONTROLS_DISABLE_UPDATES=1 (CI smoke tests set it). macOS needs a signed build to update,
 * so it is skipped there until signing is decided (docs/caveats/release.md).
 */
export function startAutoUpdate(): void {
  if (!app.isPackaged || process.env['CONTROLS_DISABLE_UPDATES'] === '1' || process.platform === 'darwin') return;
  autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => console.warn('update check failed', error));
}
