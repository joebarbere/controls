import { checkSettingsForWrite, type SettingsLoadResult } from '@controls/ipc-contract';
import { APP_ORIGIN } from './app-protocol';
import type { SettingsFile } from './settings-file';

/** The part of an `IpcMainInvokeEvent` the handlers look at (kept electron-free for unit tests). */
export interface IpcSender {
  readonly senderFrame?: { readonly url: string } | null;
}

/** Only our own top-level `app://` page may call IPC; anything else is refused. */
export function assertTrustedSender(event: IpcSender): void {
  const url = event.senderFrame?.url ?? '';
  if (!url.startsWith(`${APP_ORIGIN}/`)) throw new Error('IPC from an untrusted origin was refused.');
}

export interface HandlerDeps {
  readonly settingsFile: Pick<SettingsFile, 'read' | 'write'>;
  readonly quit: () => void;
}

/**
 * IPC handlers, independent of `ipcMain` so they can be unit-tested. Errors carry a reason only,
 * never the offending payload (it could be large, or crafted to end up in logs).
 */
export function createIpcHandlers(deps: HandlerDeps) {
  return {
    async getSettings(event: IpcSender): Promise<SettingsLoadResult> {
      assertTrustedSender(event);
      return deps.settingsFile.read();
    },

    async setSettings(event: IpcSender, payload: unknown): Promise<void> {
      assertTrustedSender(event);
      const check = checkSettingsForWrite(payload);
      if (!check.ok) throw new Error(`settings:set refused (${check.reason}).`);
      await deps.settingsFile.write(check.json);
    },

    quit(event: IpcSender): void {
      assertTrustedSender(event);
      deps.quit();
    },
  };
}
