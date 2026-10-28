import {
  AUTOSAVE_DIRECTORY,
  autosaveDisplayName,
  autosaveFileName,
  autosaveSlotOf,
  manualSaveFileName,
  manualSaveNameOf,
  MAX_SAVE_BYTES,
  pickAutosaveSlot,
  SAVE_FILE_EXTENSION,
  type SaveIoErrorCode,
  type SaveKind,
  type SaveName,
} from '@controls/ipc-contract';
import { constants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { writeFileAtomic, type AtomicWriteFs } from './atomic-write';

/** A refusal with a reason code. Handlers turn it into `save:read refused (code).`; never a path. */
export class SaveRefusal extends Error {
  constructor(readonly code: SaveIoErrorCode) {
    super(`refused (${code})`);
  }
}

/**
 * What a handle stands for, in main only. Save-directory locations carry a validated name or slot
 * (never a path), and are resolved against the root on every use. External locations carry the
 * absolute path the player picked in a native dialog, with the access that dialog granted.
 */
export type SaveLocation =
  | { readonly kind: 'manual'; readonly name: SaveName }
  | { readonly kind: 'autosave'; readonly slot: number }
  | { readonly kind: 'external'; readonly path: string; readonly access: 'read' | 'write' };

/** A file's metadata, as listed or after a write. */
export interface SaveFileInfo {
  readonly location: SaveLocation;
  readonly name: string;
  readonly kind: SaveKind;
  readonly slot: number | null;
  readonly modifiedMs: number;
  readonly sizeBytes: number;
}

/** The subset of `node:fs/promises` the store uses; tests inject failures. */
export interface SaveFs extends AtomicWriteFs {
  lstat: typeof fsp.lstat;
  readdir: typeof fsp.readdir;
  realpath: typeof fsp.realpath;
}

/** No `O_NOFOLLOW` on Windows; there the `lstat` check before opening is what refuses a symlink. */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/**
 * The main-owned save directory (`<userData>/saves`, ADR 0009): manual saves are `<name>.ctrl`,
 * autosaves `autosave/slot-N.ctrl`. Everything about paths stays in here.
 * - Reads `lstat` first and refuse anything but a regular file (a symlink, a directory, a device),
 *   check the size cap, then open with `O_NOFOLLOW` and check again on the open descriptor.
 * - Writes are atomic (`writeFileAtomic`) and serialised, so autosave slot choice can't race.
 * - Listing skips symlinks, temp files and names that aren't valid save names.
 */
export class SaveStore {
  private queue: Promise<unknown> = Promise.resolve();
  /** The slot written last in this session (rotation is by this counter, then by mtime). */
  private lastAutosaveSlot: number | null = null;

  constructor(
    readonly root: string,
    private readonly fs: SaveFs = fsp,
  ) {}

  private get autosaveDir(): string {
    return join(this.root, AUTOSAVE_DIRECTORY);
  }

  /** The path of a save-directory location, checked to be a direct child of its directory. */
  pathOf(location: SaveLocation): string {
    if (location.kind === 'external') return location.path;
    const [dir, file] =
      location.kind === 'manual'
        ? [this.root, manualSaveFileName(location.name)]
        : [this.autosaveDir, autosaveFileName(location.slot)];
    const path = resolve(dir, file);
    // Names and slots are schema-validated already; this is the belt to that brace.
    if (dirname(path) !== resolve(dir) || relative(dir, path) !== file) throw new SaveRefusal('invalid');
    return path;
  }

  /** Creates the save directory (so a dialog can open in it). */
  async ensureRoot(): Promise<void> {
    await this.fs.mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  /** Manual saves and autosave slots (unsorted). A missing directory is an empty list. */
  async list(): Promise<SaveFileInfo[]> {
    const out: SaveFileInfo[] = [];
    for (const name of await this.fileNames(this.root)) {
      const saveName = manualSaveNameOf(name);
      if (saveName === null) continue;
      const info = await this.infoOrNull({ kind: 'manual', name: saveName });
      if (info) out.push(info);
    }
    // A bad autosave directory hides the autosaves; manual saves still list.
    const autosaves = await this.autosaveFileNames().catch((error: unknown) => {
      if (error instanceof SaveRefusal) return [];
      throw error;
    });
    for (const name of autosaves) {
      const slot = autosaveSlotOf(name);
      if (slot === null) continue;
      const info = await this.infoOrNull({ kind: 'autosave', slot });
      if (info) out.push(info);
    }
    return out;
  }

  /** Metadata of a regular file at `location`; refuses missing files and anything else. */
  async info(location: SaveLocation): Promise<SaveFileInfo> {
    const path = this.pathOf(location);
    const stat = await this.lstatOrRefuse(path);
    if (!stat.isFile()) throw new SaveRefusal('not-a-file');
    return {
      location,
      name: displayName(location),
      kind: location.kind,
      slot: location.kind === 'autosave' ? location.slot : null,
      modifiedMs: Math.max(0, Math.floor(stat.mtimeMs)),
      sizeBytes: stat.size,
    };
  }

  /** The bytes at `location`: a regular file (no symlinks), at most `MAX_SAVE_BYTES`. */
  async read(location: SaveLocation): Promise<Uint8Array> {
    if (location.kind === 'autosave') await this.checkAutosaveDir();
    const path = this.pathOf(location);
    const stat = await this.lstatOrRefuse(path);
    if (!stat.isFile()) throw new SaveRefusal('not-a-file');
    if (stat.size > MAX_SAVE_BYTES) throw new SaveRefusal('too-large');
    let handle: fsp.FileHandle;
    try {
      handle = await this.fs.open(path, READ_FLAGS);
    } catch (error) {
      // ELOOP: swapped for a symlink since the lstat. ENOENT: deleted since.
      if (errno(error) === 'ELOOP') throw new SaveRefusal('not-a-file');
      if (errno(error) === 'ENOENT') throw new SaveRefusal('not-found');
      throw error;
    }
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) throw new SaveRefusal('not-a-file');
      if (opened.size > MAX_SAVE_BYTES) throw new SaveRefusal('too-large');
      const data = await handle.readFile();
      if (data.byteLength > MAX_SAVE_BYTES) throw new SaveRefusal('too-large'); // grew while reading
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } finally {
      await handle.close();
    }
  }

  /**
   * Writes a manual save. With `overwrite` false, an existing file (any kind) is `exists`.
   * Something that isn't a regular file or a symlink at that name (a directory) is `not-a-file`.
   */
  writeManual(name: SaveName, bytes: Uint8Array, overwrite: boolean): Promise<SaveFileInfo> {
    return this.serialised(async () => {
      const location: SaveLocation = { kind: 'manual', name };
      const path = this.pathOf(location);
      const existing = await this.lstatOrNull(path);
      if (existing && !overwrite) throw new SaveRefusal('exists');
      if (existing && !existing.isFile() && !existing.isSymbolicLink()) throw new SaveRefusal('not-a-file');
      await this.fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      await writeFileAtomic(path, bytes, this.fs); // a symlink at `path` is replaced, never followed
      return this.info(location);
    });
  }

  /**
   * Writes the next autosave slot of `slotCount` (`pickAutosaveSlot`), then removes slots above the
   * count (they would otherwise go stale forever). A failed write doesn't advance the rotation.
   */
  writeAutosave(slotCount: number, bytes: Uint8Array): Promise<SaveFileInfo> {
    return this.serialised(async () => {
      const existing = await this.autosaveSlots();
      const slot = pickAutosaveSlot(existing, slotCount, this.lastAutosaveSlot);
      const location: SaveLocation = { kind: 'autosave', slot };
      await this.fs.mkdir(this.autosaveDir, { recursive: true, mode: 0o700 });
      await this.checkAutosaveDir();
      await writeFileAtomic(this.pathOf(location), bytes, this.fs);
      this.lastAutosaveSlot = slot;
      for (const extra of existing.filter((e) => e.slot > slotCount))
        await this.fs.rm(this.pathOf({ kind: 'autosave', slot: extra.slot }), { force: true }).catch(() => undefined);
      return this.info(location);
    });
  }

  /** Writes a Save As target (an absolute path the player picked). */
  writeExternal(location: SaveLocation & { kind: 'external' }, bytes: Uint8Array): Promise<SaveFileInfo> {
    return this.serialised(async () => {
      const existing = await this.lstatOrNull(location.path);
      if (existing && !existing.isFile() && !existing.isSymbolicLink()) throw new SaveRefusal('not-a-file');
      await writeFileAtomic(location.path, bytes, this.fs);
      return this.info(location);
    });
  }

  /**
   * Resolves a file picked in the Open dialog: its real path (symlinks resolved once, here), which
   * must be a regular file. The handle then always reads that path.
   */
  async resolvePicked(path: string): Promise<SaveLocation & { kind: 'external' }> {
    let real: string;
    try {
      real = await this.fs.realpath(path);
    } catch (error) {
      throw errno(error) === 'ENOENT' ? new SaveRefusal('not-found') : error;
    }
    const stat = await this.lstatOrRefuse(real);
    if (!stat.isFile()) throw new SaveRefusal('not-a-file');
    return { kind: 'external', path: real, access: 'read' };
  }

  /** The Save As path with `.ctrl` added if the player left it off. */
  static withSaveExtension(path: string): string {
    return extname(path).toLowerCase() === `.${SAVE_FILE_EXTENSION}` ? path : `${path}.${SAVE_FILE_EXTENSION}`;
  }

  private async autosaveSlots(): Promise<{ slot: number; modifiedMs: number }[]> {
    const slots: { slot: number; modifiedMs: number }[] = [];
    for (const name of await this.autosaveFileNames()) {
      const slot = autosaveSlotOf(name);
      if (slot === null) continue;
      const stat = await this.lstatOrNull(join(this.autosaveDir, name));
      if (stat?.isFile()) slots.push({ slot, modifiedMs: stat.mtimeMs });
    }
    return slots;
  }

  /**
   * Files in the autosave directory, which must be a real directory: a symlink there (planted by
   * something with file-system access) would send autosaves outside the save directory.
   */
  private async autosaveFileNames(): Promise<string[]> {
    await this.checkAutosaveDir();
    return this.fileNames(this.autosaveDir);
  }

  private async checkAutosaveDir(): Promise<void> {
    const stat = await this.lstatOrNull(this.autosaveDir);
    if (stat && !stat.isDirectory()) throw new SaveRefusal('not-a-file');
  }

  /** Names of regular files in `dir` (readdir's dirents don't follow symlinks). Missing dir: none. */
  private async fileNames(dir: string): Promise<string[]> {
    try {
      const entries = await this.fs.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch (error) {
      if (errno(error) === 'ENOENT' || errno(error) === 'ENOTDIR') return [];
      throw error;
    }
  }

  private async infoOrNull(location: SaveLocation): Promise<SaveFileInfo | null> {
    try {
      return await this.info(location);
    } catch {
      return null; // vanished or replaced between readdir and lstat
    }
  }

  private async lstatOrNull(path: string) {
    try {
      return await this.fs.lstat(path);
    } catch (error) {
      if (errno(error) === 'ENOENT') return null;
      throw error;
    }
  }

  private async lstatOrRefuse(path: string) {
    const stat = await this.lstatOrNull(path);
    if (!stat) throw new SaveRefusal('not-found');
    return stat;
  }

  private serialised<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function displayName(location: SaveLocation): string {
  switch (location.kind) {
    case 'manual':
      return location.name;
    case 'autosave':
      return autosaveDisplayName(location.slot);
    case 'external':
      return basename(location.path);
  }
}
