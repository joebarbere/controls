import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { AppInfoSchema, IpcChannel, type AppInfo } from '@controls/ipc-contract';
import { APP_ORIGIN } from './app-protocol';

/** Only our own top-level page may call IPC; anything else is dropped. */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? '';
  if (!url.startsWith(`${APP_ORIGIN}/`)) throw new Error(`IPC from untrusted origin refused: ${url}`);
}

export function registerIpcHandlers(): void {
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
}
