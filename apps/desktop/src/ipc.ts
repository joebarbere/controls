import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
  type SaveDialogOptions,
  type WebContents,
} from 'electron';
import { AppInfoSchema, IpcChannel, SAVE_FILE_EXTENSION, type AppInfo } from '@controls/ipc-contract';
import { join } from 'node:path';
import type { FlushCoordinator } from './flush-before-quit';
import { assertTrustedSender, createIpcHandlers } from './ipc-handlers';
import { SaveHandleTable } from './save-handles';
import { createSaveHandlers, type SaveIpcEvent } from './save-handlers';
import { SaveStore } from './save-store';
import { SettingsFile } from './settings-file';

/** Settings live in `userData` (set from `CONTROLS_USER_DATA_DIR` in main.ts before this runs). */
export const SETTINGS_FILE_NAME = 'settings.json';

/** The main-owned save directory, under `userData` (ADR 0009). */
export const SAVES_DIRECTORY_NAME = 'saves';

const SAVE_FILTERS = [{ name: 'Controls save', extensions: [SAVE_FILE_EXTENSION] }];

/** The dialog's parent window, so it is modal to the page that asked. */
const windowOf = (event: SaveIpcEvent) => BrowserWindow.fromWebContents(event.sender as WebContents) ?? undefined;

/** What main.ts needs back: forget a window's save handles when its `WebContents` goes away. */
export interface RegisteredIpc {
  forgetWindow(webContentsId: number): void;
}

export function registerIpcHandlers(flush: FlushCoordinator): RegisteredIpc {
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

  const handles = new SaveHandleTable();
  const saves = createSaveHandlers({
    store: new SaveStore(join(app.getPath('userData'), SAVES_DIRECTORY_NAME)),
    handles,
    dialogs: {
      // `dialog.show…` is looked up on each call: desktop-e2e stubs it in the dev build.
      showOpen: async (event, { defaultPath }) => {
        const options: OpenDialogOptions = {
          title: 'Open save',
          defaultPath,
          properties: ['openFile'],
          filters: SAVE_FILTERS,
        };
        const parent = windowOf(event);
        const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      showSaveAs: async (event, { defaultPath }) => {
        const options: SaveDialogOptions = {
          title: 'Save as',
          defaultPath,
          filters: SAVE_FILTERS,
          properties: ['createDirectory', 'showOverwriteConfirmation'],
        };
        const parent = windowOf(event);
        const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
        return result.canceled || !result.filePath ? null : result.filePath;
      },
    },
  });
  ipcMain.handle(IpcChannel.SaveList, (event, payload: unknown) => saves.list(event, payload));
  ipcMain.handle(IpcChannel.SaveRead, (event, payload: unknown) => saves.read(event, payload));
  ipcMain.handle(IpcChannel.SaveWrite, (event, payload: unknown) => saves.write(event, payload));
  ipcMain.handle(IpcChannel.DialogOpen, (event, payload: unknown) => saves.dialogOpen(event, payload));
  ipcMain.handle(IpcChannel.DialogSaveAs, (event, payload: unknown) => saves.dialogSaveAs(event, payload));

  return { forgetWindow: (id) => handles.forgetOwner(id) };
}
