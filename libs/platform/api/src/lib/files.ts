import type {
  DialogFileType,
  SaveAsTarget,
  SaveEntry,
  SaveHandle,
  SaveIoErrorCode,
  SaveName,
  SaveTarget,
} from '@controls/ipc-contract';

export type {
  DialogFileType,
  SaveAsTarget,
  SaveEntry,
  SaveHandle,
  SaveIoErrorCode,
  SaveKind,
  SaveName,
  SaveTarget,
} from '@controls/ipc-contract';

/**
 * A refused or failed save operation. `code` says why (`SaveIoErrorCode`); the message never holds
 * the payload or a path. Both platforms reject with this, so callers switch on `code`.
 */
export class SaveIoError extends Error {
  override readonly name = 'SaveIoError';
  constructor(
    readonly code: SaveIoErrorCode,
    message = `Save operation refused (${code}).`,
  ) {
    super(message);
  }
}

/**
 * Saves in the host's save directory (ADR 0009): a folder in userData owned by Electron main, or
 * the origin-private file system in the web harness. Bytes are opaque (`.ctrl` encoding is
 * `@controls/save-format`'s job). The renderer gets {@link SaveHandle}s, never paths.
 *
 * Handles from {@link list} and {@link write} name a manual save or an autosave slot. Manual saves
 * are readable and writable; autosave slots are read-only (only `write({ kind: 'autosave' })`
 * writes them, so rotation stays with the platform). Handles are valid for this window's lifetime.
 * Manual names are unique ignoring case (`saveNameKey`): a write whose name clashes with another
 * save's is `exists`, or with `overwrite` replaces that save, which keeps its existing name.
 *
 * Every method rejects with {@link SaveIoError} on refusal or failure.
 */
export interface FileService {
  /** Manual saves and autosave slots, newest first (at most `MAX_SAVE_LIST_ENTRIES`). */
  list(): Promise<SaveEntry[]>;
  /** The bytes behind a readable handle (at most `MAX_SAVE_BYTES`). */
  read(handle: SaveHandle): Promise<Uint8Array>;
  /**
   * Writes atomically: the old file is intact unless the new one is complete. Targets:
   * `manual` (`<name>.ctrl`; `exists` unless `overwrite`), `autosave` (the next of `slotCount` slots;
   * slots above the count are removed), or `handle` (a manual save or a Save As target).
   * Resolves with the written file's entry.
   */
  write(target: SaveTarget, bytes: Uint8Array): Promise<SaveEntry>;
  /**
   * Deletes a manual save or an autosave slot (a handle from {@link list} or {@link write}). A file
   * outside the save directory (an Open or Save As handle) is never deleted (`read-only`); a save
   * that has already gone is `not-found`. The handle stays valid: writing that name again reuses it.
   */
  delete(handle: SaveHandle): Promise<void>;
  /**
   * The PNG thumbnail inside a readable save, or null when it has none or the file isn't a save the
   * thumbnail can be read from. Reads only that ZIP entry, never the whole save (ADR 0009 amendment).
   * A null is not a verdict on the save: it may still load, or fail to.
   */
  thumbnail(handle: SaveHandle): Promise<Uint8Array | null>;
}

/**
 * File pickers for files outside the save directory. Desktop: native dialogs in main. Web harness:
 * Open uploads a file (`<input type="file">`), Save As downloads it.
 *
 * Call these from a user gesture (a click or key handler): the web harness needs transient
 * activation to open a picker or start a download. Only one dialog at a time (`busy`).
 */
export interface DialogService {
  /** The picked file as a **read-only** entry (`kind: 'external'`), or null if cancelled. */
  open(options: { readonly fileType: DialogFileType }): Promise<SaveEntry | null>;
  /**
   * A **write-only** target the player picked, or null if cancelled. Write to it with
   * `FileService.write({ kind: 'handle', handle })`; in the web harness that write is the download.
   */
  saveAs(options: {
    readonly fileType: DialogFileType;
    readonly suggestedName: SaveName;
  }): Promise<SaveAsTarget | null>;
}
