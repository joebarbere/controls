import { app, ipcMain } from 'electron';
import { AppInfoSchema, IpcChannel, type AppInfo } from '@controls/ipc-contract';
import { join } from 'node:path';
import type { FlushCoordinator } from './flush-before-quit';
import { assertTrustedSender, createIpcHandlers } from './ipc-handlers';
import { SettingsFile } from './settings-file';

/** Settings live in `userData` (set from `CONTROLS_USER_DATA_DIR` in main.ts before this runs). */
export const SETTINGS_FILE_NAME = 'settings.json';

export function registerIpcHandlers(flush: FlushCoordinator): void {
  ipcMain.handle(IpcChannel.AppInfo, (event): AppInfo => {
    assertTrustedSender(event);
    return AppInfoSchema.parse({
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    });
  });

  const handlers = createIpcHandlers({
    settingsFile: new SettingsFile(join(app.getPath('userData'), SETTINGS_FILE_NAME)),
    quit: () => app.quit(),
  });
  ipcMain.handle(IpcChannel.SettingsGet, (event) => handlers.getSettings(event));
  ipcMain.handle(IpcChannel.SettingsSet, (event, payload: unknown) => handlers.setSettings(event, payload));
  // app.quit() goes through `before-quit`, where QuitGuard flushes the renderer first.
  ipcMain.handle(IpcChannel.AppQuit, (event) => handlers.quit(event));
  ipcMain.handle(IpcChannel.FlushAck, (event, payload: unknown) => flush.acknowledge(event, payload));
}
