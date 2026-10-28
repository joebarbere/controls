import {
  AUTOSAVE_DIRECTORY,
  autosaveDisplayName,
  autosaveFileName,
  autosaveSlotOf,
  compareSaveEntries,
  DialogOpenRequestSchema,
  DialogSaveAsRequestSchema,
  manualSaveFileName,
  manualSaveNameOf,
  MAX_SAVE_BYTES,
  MAX_SAVE_LIST_ENTRIES,
  pickAutosaveSlot,
  SAVE_FILE_EXTENSION,
  SaveHandleSchema,
  SaveWriteRequestSchema,
  type DialogFileType,
  type SaveAsTarget,
  type SaveEntry,
  type SaveHandle,
  type SaveKind,
  type SaveName,
  type SaveTarget,
} from '@controls/ipc-contract';
import { SaveIoError, type DialogService, type FileService } from '@controls/platform-api';

/*
 * Web harness saves (F1.8b, ADR 0009) in the **origin-private file system** (OPFS). Only the slices
 * of the File System API used here are typed, so tests can pass an in-memory fake.
 */

/** `FileSystemWritableFileStream`: writes go to a swap file; `close()` commits it in one step. */
export interface OpfsWritable {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export interface OpfsFile {
  readonly size: number;
  readonly lastModified: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface OpfsFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<OpfsFile>;
  createWritable(): Promise<OpfsWritable>;
}

export interface OpfsDirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string): Promise<void>;
  values(): AsyncIterable<OpfsFileHandle | OpfsDirectoryHandle>;
}

/** The OPFS root, or undefined where there is none (no `navigator.storage.getDirectory`, Node). */
export async function opfsRoot(): Promise<OpfsDirectoryHandle | undefined> {
  const storage = (globalThis as { navigator?: { storage?: { getDirectory?: () => Promise<unknown> } } }).navigator
    ?.storage;
  if (typeof storage?.getDirectory !== 'function') return undefined;
  return (await storage.getDirectory()) as OpfsDirectoryHandle;
}

/** A file the player uploaded through Open (a `File`). */
export type PickedFile = OpfsFile & { readonly name: string };

/** Browser-side pickers, injectable for tests. Both must run inside a user gesture. */
export interface WebFilePickers {
  /** Shows a file chooser; resolves the file, or null if the player cancelled. */
  pickFile(accept: string): Promise<PickedFile | null>;
  /** Starts a download of `bytes` named `fileName`. */
  download(fileName: string, bytes: Uint8Array): void;
}

/** The save directory inside OPFS. */
export const WEB_SAVES_DIRECTORY = 'saves';

type Location =
  | { readonly kind: 'manual'; readonly name: SaveName }
  | { readonly kind: 'autosave'; readonly slot: number }
  | { readonly kind: 'upload'; readonly file: PickedFile }
  | { readonly kind: 'download'; readonly fileName: string };

const domName = (error: unknown): string | undefined => (error as { name?: unknown } | null)?.name as string;

function randomHandle(): SaveHandle {
  const raw = new Uint8Array(16);
  globalThis.crypto.getRandomValues(raw);
  let binary = '';
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * `FileService` and `DialogService` for the web harness. The same contract as Electron (one test
 * suite runs against both): handles are random tokens in a table that lives as long as the page,
 * names and handles are checked with the same schemas, and the same reason codes come back.
 *
 * Atomic writes: `createWritable()` writes to a swap file and `close()` swaps it in, so a failure
 * before `close()` completes leaves the old file. A brand-new file exists (empty) from
 * `getFileHandle({ create: true })`, so it is removed again if its first write fails, and listing
 * skips empty files (no valid save is empty) in case the tab died in between.
 */
export class WebSaveStore {
  readonly files: FileService;
  readonly dialogs: DialogService;
  private readonly byToken = new Map<SaveHandle, Location>();
  private readonly byKey = new Map<string, SaveHandle>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastAutosaveSlot: number | null = null;
  private dialogOpen = false;

  constructor(
    private readonly root: () => Promise<OpfsDirectoryHandle | undefined> = opfsRoot,
    private readonly pickers: WebFilePickers = browserPickers(),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.files = {
      list: () => this.guard(() => this.list()),
      read: (handle) => this.guard(() => this.read(handle)),
      write: (target, bytes) => this.guard(() => this.write(target, bytes)),
    };
    this.dialogs = {
      open: (options) => this.guard(() => this.open(options)),
      saveAs: (options) => this.guard(() => this.saveAs(options)),
    };
  }

  private async list(): Promise<SaveEntry[]> {
    const saves = await this.savesDir(false);
    if (!saves) return [];
    const out: SaveEntry[] = [];
    for await (const entry of saves.values()) {
      const name = entry.kind === 'file' ? manualSaveNameOf(entry.name) : null;
      if (name === null || entry.kind !== 'file') continue;
      const file = await entry.getFile();
      if (file.size > 0) out.push(this.entryOf({ kind: 'manual', name }, file));
    }
    const autosaves = await this.autosaveDir(saves, false);
    if (autosaves)
      for await (const entry of autosaves.values()) {
        const slot = entry.kind === 'file' ? autosaveSlotOf(entry.name) : null;
        if (slot === null || entry.kind !== 'file') continue;
        const file = await entry.getFile();
        if (file.size > 0) out.push(this.entryOf({ kind: 'autosave', slot }, file));
      }
    return out.sort(compareSaveEntries).slice(0, MAX_SAVE_LIST_ENTRIES);
  }

  private async read(handle: SaveHandle): Promise<Uint8Array> {
    const location = this.locate(handle);
    if (location.kind === 'download') throw new SaveIoError('write-only');
    const file =
      location.kind === 'upload' ? location.file : await (await this.fileHandleOf(location, false)).getFile();
    if (file.size > MAX_SAVE_BYTES) throw new SaveIoError('too-large');
    const data = new Uint8Array(await file.arrayBuffer());
    if (data.byteLength > MAX_SAVE_BYTES) throw new SaveIoError('too-large');
    return data;
  }

  private write(target: SaveTarget, bytes: Uint8Array): Promise<SaveEntry> {
    const parsed = SaveWriteRequestSchema.safeParse({ target, bytes });
    if (!parsed.success) throw new SaveIoError('invalid');
    if (bytes.byteLength > MAX_SAVE_BYTES) throw new SaveIoError('too-large');
    const request = parsed.data;
    return this.serialised(async () => {
      switch (request.target.kind) {
        case 'manual': {
          const location = { kind: 'manual', name: request.target.name } as const;
          const exists = await this.exists(location);
          if (exists && !request.target.overwrite) throw new SaveIoError('exists');
          return this.commit(location, request.bytes, !exists);
        }
        case 'autosave':
          return this.writeAutosave(request.target.slotCount, request.bytes);
        case 'handle': {
          const handle = request.target.handle;
          const location = this.locate(handle);
          if (location.kind === 'manual') return this.commit(location, request.bytes, !(await this.exists(location)));
          if (location.kind === 'download') {
            this.pickers.download(location.fileName, request.bytes);
            return this.externalEntry(handle, location.fileName, request.bytes.byteLength);
          }
          throw new SaveIoError('read-only');
        }
      }
    });
  }

  private async writeAutosave(slotCount: number, bytes: Uint8Array): Promise<SaveEntry> {
    const saves = await this.requireSavesDir();
    const dir = await this.autosaveDir(saves, true);
    const existing: { slot: number; modifiedMs: number }[] = [];
    for await (const entry of dir?.values() ?? []) {
      const slot = entry.kind === 'file' ? autosaveSlotOf(entry.name) : null;
      if (slot !== null && entry.kind === 'file')
        existing.push({ slot, modifiedMs: (await entry.getFile()).lastModified });
    }
    const slot = pickAutosaveSlot(existing, slotCount, this.lastAutosaveSlot);
    const location = { kind: 'autosave', slot } as const;
    const entry = await this.commit(location, bytes, !existing.some((e) => e.slot === slot));
    this.lastAutosaveSlot = slot;
    for (const extra of existing.filter((e) => e.slot > slotCount))
      await dir?.removeEntry(autosaveFileName(extra.slot)).catch(() => undefined);
    return entry;
  }

  /** Writes through a swap file; on failure aborts it, and removes a file this write created. */
  private async commit(location: Location & { kind: 'manual' | 'autosave' }, bytes: Uint8Array, created: boolean) {
    const fileHandle = await this.fileHandleOf(location, true);
    let writable: OpfsWritable | undefined;
    try {
      writable = await fileHandle.createWritable();
      await writable.write(bytes);
      await writable.close();
    } catch (error) {
      await writable?.abort().catch(() => undefined);
      if (created) await this.remove(location).catch(() => undefined);
      throw error;
    }
    return this.entryOf(location, await fileHandle.getFile());
  }

  private async open(options: { readonly fileType: DialogFileType }): Promise<SaveEntry | null> {
    if (!DialogOpenRequestSchema.safeParse(options).success) throw new SaveIoError('invalid');
    const file = await this.withDialog(() => this.pickers.pickFile(`.${SAVE_FILE_EXTENSION}`));
    if (!file) return null;
    const location: Location = { kind: 'upload', file };
    const handle = this.issue(location);
    return {
      handle,
      name: file.name.slice(0, 255) || 'upload',
      kind: 'external',
      slot: null,
      modifiedMs: Math.max(0, Math.floor(file.lastModified)),
      sizeBytes: file.size,
    };
  }

  private async saveAs(options: {
    readonly fileType: DialogFileType;
    readonly suggestedName: SaveName;
  }): Promise<SaveAsTarget | null> {
    const parsed = DialogSaveAsRequestSchema.safeParse(options);
    if (!parsed.success) throw new SaveIoError('invalid');
    if (this.dialogOpen) throw new SaveIoError('busy');
    // A download has no picker: the browser names the file (or asks, per its own settings).
    const fileName = manualSaveFileName(parsed.data.suggestedName);
    return { handle: this.issue({ kind: 'download', fileName }), name: fileName };
  }

  private async withDialog<T>(body: () => Promise<T>): Promise<T> {
    if (this.dialogOpen) throw new SaveIoError('busy');
    this.dialogOpen = true;
    try {
      return await body();
    } finally {
      this.dialogOpen = false;
    }
  }

  private externalEntry(handle: SaveHandle, name: string, sizeBytes: number): SaveEntry {
    return { handle, name, kind: 'external', slot: null, modifiedMs: Math.floor(this.now()), sizeBytes };
  }

  private entryOf(location: Location & { kind: 'manual' | 'autosave' }, file: OpfsFile): SaveEntry {
    const kind: SaveKind = location.kind;
    return {
      handle: this.issue(location),
      name: location.kind === 'manual' ? location.name : autosaveDisplayName(location.slot),
      kind,
      slot: location.kind === 'autosave' ? location.slot : null,
      modifiedMs: Math.max(0, Math.floor(file.lastModified)),
      sizeBytes: file.size,
    };
  }

  private issue(location: Location): SaveHandle {
    const key =
      location.kind === 'manual'
        ? `manual\u0000${location.name}`
        : location.kind === 'autosave'
          ? `autosave\u0000${location.slot}`
          : null;
    const existing = key === null ? undefined : this.byKey.get(key);
    if (existing !== undefined) return existing;
    let token = randomHandle();
    while (this.byToken.has(token)) token = randomHandle();
    this.byToken.set(token, location);
    if (key !== null) this.byKey.set(key, token);
    return token;
  }

  private locate(handle: SaveHandle): Location {
    if (!SaveHandleSchema.safeParse(handle).success) throw new SaveIoError('invalid');
    const location = this.byToken.get(handle);
    if (!location) throw new SaveIoError('unknown-handle');
    return location;
  }

  private async exists(location: Location & { kind: 'manual' | 'autosave' }): Promise<boolean> {
    try {
      await this.fileHandleOf(location, false);
      return true;
    } catch (error) {
      if (error instanceof SaveIoError && error.code === 'not-found') return false;
      throw error;
    }
  }

  private async fileHandleOf(location: Location & { kind: 'manual' | 'autosave' }, create: boolean) {
    const saves = create ? await this.requireSavesDir() : await this.savesDir(false);
    if (!saves) throw new SaveIoError('not-found');
    const dir = location.kind === 'manual' ? saves : await this.autosaveDir(saves, create);
    if (!dir) throw new SaveIoError('not-found');
    const fileName = location.kind === 'manual' ? manualSaveFileName(location.name) : autosaveFileName(location.slot);
    try {
      return await dir.getFileHandle(fileName, { create });
    } catch (error) {
      if (domName(error) === 'NotFoundError') throw new SaveIoError('not-found');
      if (domName(error) === 'TypeMismatchError') throw new SaveIoError('not-a-file');
      throw error;
    }
  }

  private async remove(location: Location & { kind: 'manual' | 'autosave' }): Promise<void> {
    const saves = await this.savesDir(false);
    if (!saves) return;
    if (location.kind === 'manual') return saves.removeEntry(manualSaveFileName(location.name));
    const dir = await this.autosaveDir(saves, false);
    await dir?.removeEntry(autosaveFileName(location.slot));
  }

  private async requireSavesDir(): Promise<OpfsDirectoryHandle> {
    const saves = await this.savesDir(true);
    if (!saves) throw new SaveIoError('unavailable');
    return saves;
  }

  private async savesDir(create: boolean): Promise<OpfsDirectoryHandle | undefined> {
    const root = await this.root();
    if (!root) {
      if (create) throw new SaveIoError('unavailable');
      return undefined;
    }
    return this.subdirectory(root, WEB_SAVES_DIRECTORY, create);
  }

  private autosaveDir(saves: OpfsDirectoryHandle, create: boolean): Promise<OpfsDirectoryHandle | undefined> {
    return this.subdirectory(saves, AUTOSAVE_DIRECTORY, create);
  }

  private async subdirectory(parent: OpfsDirectoryHandle, name: string, create: boolean) {
    try {
      return await parent.getDirectoryHandle(name, { create });
    } catch (error) {
      if (domName(error) === 'NotFoundError') return undefined;
      if (domName(error) === 'TypeMismatchError') throw new SaveIoError('not-a-file');
      throw error;
    }
  }

  private serialised<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Every rejection is a `SaveIoError`; anything unexpected (quota, a browser error) is `io`. */
  private async guard<T>(body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      if (error instanceof SaveIoError) throw error;
      throw new SaveIoError(domName(error) === 'SecurityError' ? 'unavailable' : 'io');
    }
  }
}

/**
 * Real pickers: a hidden `<input type="file">` for Open (its `cancel` event reports a dismissed
 * chooser) and an `<a download>` on a `blob:` URL for Save As. Both need the caller's gesture
 * (transient activation). The file input's `click()` is deferred one task: Chromium shows no
 * chooser for a click made inside a keydown handler (Mod+O, Enter in the console), and the
 * activation outlives the task, so the deferred click still opens it.
 */
export function browserPickers(): WebFilePickers {
  return {
    pickFile: (accept) =>
      new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
        input.addEventListener('cancel', () => resolve(null), { once: true });
        setTimeout(() => input.click(), 0);
      }),
    download: (fileName, bytes) => {
      const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  };
}
