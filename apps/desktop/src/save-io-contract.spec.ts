import type { ControlsBridge } from '@controls/ipc-contract';
import { describeSaveIoContract, type SaveIoHarness } from '@controls/platform-api/testing';
import { ElectronPlatform } from '@controls/platform-electron';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { SaveHandleTable } from './save-handles';
import { createSaveHandlers, type SaveIpcEvent } from './save-handlers';
import { SaveStore } from './save-store';

const event: SaveIpcEvent = { senderFrame: { url: 'app://game/index.html' }, sender: { id: 1 } };

/**
 * `invoke` without Electron: payloads and results are structured-cloned (as IPC does), and a
 * handler error comes back wrapped the way `ipcRenderer.invoke` wraps it.
 */
async function invoke(channel: string, run: () => Promise<unknown>): Promise<unknown> {
  try {
    return structuredClone(await run());
  } catch (error) {
    throw new Error(`Error invoking remote method '${channel}': ${String(error)}`);
  }
}

/**
 * The Electron side of the contract: the real `ElectronPlatform` (renderer) over an in-process
 * bridge to main's real handlers, store and handle table, on a temp directory. The rename of the
 * atomic write is where `failNextCommit` strikes.
 */
async function electronHarness(): Promise<SaveIoHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'controls-save-contract-'));
  const outside = join(dir, 'elsewhere');
  mkdirSync(outside);
  let failCommit = false;
  let nextOpen: { fileName: string; bytes: Uint8Array } | null = null;
  let nextSaveAs: { fileName: string } | null = null;
  let savedAsPath: string | undefined;

  const store = new SaveStore(join(dir, 'saves'), {
    ...fsp,
    rename: async (from, to) => {
      if (failCommit) {
        failCommit = false;
        throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
      }
      return fsp.rename(from, to);
    },
  });
  const handlers = createSaveHandlers({
    store,
    handles: new SaveHandleTable(),
    log: () => undefined,
    dialogs: {
      showOpen: async () => {
        if (!nextOpen) return null;
        const path = join(outside, nextOpen.fileName);
        writeFileSync(path, nextOpen.bytes);
        return path;
      },
      showSaveAs: async () => {
        if (!nextSaveAs) return null;
        savedAsPath = SaveStore.withSaveExtension(join(outside, nextSaveAs.fileName));
        return join(outside, nextSaveAs.fileName);
      },
    },
  });
  const unused = async () => Promise.reject(new Error('not used here'));
  const bridge: ControlsBridge = {
    getAppInfo: unused,
    getSettings: unused,
    setSettings: unused,
    quit: unused,
    onFlushRequest: () => () => undefined,
    ackFlush: unused,
    listSaves: () => invoke('save:list', () => handlers.list(event)),
    readSave: (request) => invoke('save:read', () => handlers.read(event, structuredClone(request))),
    writeSave: (request) => invoke('save:write', () => handlers.write(event, structuredClone(request))),
    showOpenDialog: (request) => invoke('dialog:open', () => handlers.dialogOpen(event, structuredClone(request))),
    showSaveAsDialog: (request) =>
      invoke('dialog:saveAs', () => handlers.dialogSaveAs(event, structuredClone(request))),
  };
  const platform = new ElectronPlatform(bridge);
  return {
    files: platform.files,
    dialogs: platform.dialogs,
    nextOpen: (pick) => (nextOpen = pick),
    nextSaveAs: (pick) => (nextSaveAs = pick),
    lastSavedAs: async () =>
      savedAsPath === undefined
        ? undefined
        : { fileName: basename(savedAsPath), bytes: new Uint8Array(readFileSync(savedAsPath)) },
    failNextCommit: () => (failCommit = true),
    dispose: async () => rmSync(dir, { recursive: true, force: true }),
  };
}

describeSaveIoContract('Electron (platform-electron → in-process IPC → main handlers → temp dir)', electronHarness);
