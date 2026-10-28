import {
  compareSaveEntries,
  DialogOpenRequestSchema,
  DialogSaveAsRequestSchema,
  IpcChannel,
  manualSaveFileName,
  MAX_SAVE_BYTES,
  MAX_SAVE_LIST_ENTRIES,
  SaveListRequestSchema,
  SaveReadRequestSchema,
  saveRefusalMessage,
  SaveWriteRequestSchema,
  type SaveAsTarget,
  type SaveEntry,
  type SaveIoErrorCode,
} from '@controls/ipc-contract';
import { basename, join } from 'node:path';
import { assertTrustedSender, type IpcSender } from './ipc-handlers';
import type { SaveHandleTable } from './save-handles';
import { SaveRefusal, SaveStore, type SaveFileInfo, type SaveLocation } from './save-store';

/** The part of an `IpcMainInvokeEvent` the save handlers use: the frame (origin) and the `WebContents` id. */
export interface SaveIpcEvent extends IpcSender {
  readonly sender: { readonly id: number };
}

/**
 * Native dialogs, injected so the handlers stay electron-free. Each resolves the picked absolute
 * path, or null when the player cancels. `ipc.ts` implements them with Electron's `dialog`.
 */
export interface SaveDialogs {
  showOpen(event: SaveIpcEvent, options: { readonly defaultPath: string }): Promise<string | null>;
  showSaveAs(event: SaveIpcEvent, options: { readonly defaultPath: string }): Promise<string | null>;
}

export interface SaveHandlerDeps {
  readonly store: SaveStore;
  readonly handles: SaveHandleTable;
  readonly dialogs: SaveDialogs;
  /** Where unexpected file-system errors are reported (errno code only; never a path or payload). */
  readonly log?: (message: string) => void;
}

type Channel =
  | typeof IpcChannel.SaveList
  | typeof IpcChannel.SaveRead
  | typeof IpcChannel.SaveWrite
  | typeof IpcChannel.DialogOpen
  | typeof IpcChannel.DialogSaveAs;

/**
 * `save:*` and `dialog:*` handlers (F1.8b, ADR 0009). Each one: checks the sender is our `app://`
 * page, parses the payload with its `@controls/ipc-contract` schema, enforces `MAX_SAVE_BYTES`, and
 * resolves handles only for the `WebContents` they were issued to. Errors are
 * `<channel> refused (<code>).`: never the payload, never a path.
 */
export function createSaveHandlers(deps: SaveHandlerDeps) {
  const { store, handles } = deps;
  const log = deps.log ?? ((message: string) => console.warn(message));
  /** Windows with a dialog open: one at a time, so a page can't stack dialogs. */
  const dialogOpen = new Set<number>();

  const refuse = (channel: Channel, code: SaveIoErrorCode): never => {
    throw new Error(saveRefusalMessage(channel, code));
  };

  /** Runs `body`, turning refusals and file-system errors into reason-only messages. */
  async function guarded<T>(channel: Channel, event: SaveIpcEvent, body: () => Promise<T>): Promise<T> {
    assertTrustedSender(event);
    try {
      return await body();
    } catch (error) {
      if (error instanceof SaveRefusal) return refuse(channel, error.code);
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      log(`${channel} failed (${typeof code === 'string' ? code : 'unknown error'}).`);
      return refuse(channel, 'io');
    }
  }

  const entryOf = (ownerId: number, info: SaveFileInfo): SaveEntry => ({
    handle: handles.issue(ownerId, info.location),
    name: info.name,
    kind: info.kind,
    slot: info.slot,
    modifiedMs: info.modifiedMs,
    sizeBytes: info.sizeBytes,
  });

  const locate = (event: SaveIpcEvent, handle: string): SaveLocation => {
    const location = handles.resolve(event.sender.id, handle);
    if (!location) throw new SaveRefusal('unknown-handle');
    return location;
  };

  async function withDialog<T>(event: SaveIpcEvent, body: () => Promise<T>): Promise<T> {
    const owner = event.sender.id;
    if (dialogOpen.has(owner)) throw new SaveRefusal('busy');
    dialogOpen.add(owner);
    try {
      return await body();
    } finally {
      dialogOpen.delete(owner);
    }
  }

  return {
    list(event: SaveIpcEvent, payload?: unknown): Promise<SaveEntry[]> {
      return guarded(IpcChannel.SaveList, event, async () => {
        if (!SaveListRequestSchema.safeParse(payload).success) throw new SaveRefusal('invalid');
        const infos = await store.list();
        return infos
          .map((info) => entryOf(event.sender.id, info))
          .sort(compareSaveEntries)
          .slice(0, MAX_SAVE_LIST_ENTRIES);
      });
    },

    read(event: SaveIpcEvent, payload: unknown): Promise<Uint8Array> {
      return guarded(IpcChannel.SaveRead, event, async () => {
        const parsed = SaveReadRequestSchema.safeParse(payload);
        if (!parsed.success) throw new SaveRefusal('invalid');
        const location = locate(event, parsed.data.handle);
        if (location.kind === 'external' && location.access === 'write') throw new SaveRefusal('write-only');
        return store.read(location);
      });
    },

    write(event: SaveIpcEvent, payload: unknown): Promise<SaveEntry> {
      return guarded(IpcChannel.SaveWrite, event, async () => {
        const parsed = SaveWriteRequestSchema.safeParse(payload);
        if (!parsed.success) throw new SaveRefusal('invalid');
        const { target, bytes } = parsed.data;
        if (bytes.byteLength > MAX_SAVE_BYTES) throw new SaveRefusal('too-large');
        const owner = event.sender.id;
        switch (target.kind) {
          case 'manual':
            return entryOf(owner, await store.writeManual(target.name, bytes, target.overwrite));
          case 'autosave':
            return entryOf(owner, await store.writeAutosave(target.slotCount, bytes));
          case 'handle': {
            const location = locate(event, target.handle);
            if (location.kind === 'manual') return entryOf(owner, await store.writeManual(location.name, bytes, true));
            if (location.kind === 'external' && location.access === 'write') {
              const info = await store.writeExternal(location, bytes);
              return { ...entryOf(owner, info), handle: target.handle }; // keep the Save As handle
            }
            throw new SaveRefusal('read-only'); // autosave slots rotate; opened files are never written
          }
        }
      });
    },

    dialogOpen(event: SaveIpcEvent, payload: unknown): Promise<SaveEntry | null> {
      return guarded(IpcChannel.DialogOpen, event, async () => {
        if (!DialogOpenRequestSchema.safeParse(payload).success) throw new SaveRefusal('invalid');
        return withDialog(event, async () => {
          await store.ensureRoot();
          const picked = await deps.dialogs.showOpen(event, { defaultPath: store.root });
          if (picked === null) return null;
          const location = await store.resolvePicked(picked);
          const info = await store.info(location);
          return entryOf(event.sender.id, { ...info, name: basename(picked) });
        });
      });
    },

    dialogSaveAs(event: SaveIpcEvent, payload: unknown): Promise<SaveAsTarget | null> {
      return guarded(IpcChannel.DialogSaveAs, event, async () => {
        const parsed = DialogSaveAsRequestSchema.safeParse(payload);
        if (!parsed.success) throw new SaveRefusal('invalid');
        return withDialog(event, async () => {
          await store.ensureRoot();
          const defaultPath = join(store.root, manualSaveFileName(parsed.data.suggestedName));
          const picked = await deps.dialogs.showSaveAs(event, { defaultPath });
          if (picked === null) return null;
          const path = SaveStore.withSaveExtension(picked);
          const handle = handles.issue(event.sender.id, { kind: 'external', path, access: 'write' });
          return { handle, name: basename(path) };
        });
      });
    },
  };
}

export type SaveHandlers = ReturnType<typeof createSaveHandlers>;
