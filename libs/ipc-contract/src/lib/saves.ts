import { z } from 'zod';

/**
 * Save I/O contract (F1.8b, ADR 0009). Saves are **opaque bytes** here: the `.ctrl` container is
 * `@controls/save-format`'s business. The renderer names saves and receives opaque handles; main (or
 * the web harness store) owns every path. Shared by main, `platform-electron` and `platform-web`, so
 * both platforms refuse exactly the same inputs with the same reason codes.
 */

/** File extension of a save (no dot in the constant: Electron's dialog filters take it bare). */
export const SAVE_FILE_EXTENSION = 'ctrl';

/**
 * Largest save main will read or write, in bytes. A P1 save is a few KB to a few MB (world, replay
 * log, a thumbnail); the cap keeps a renderer from making main buffer or write hundreds of MB.
 */
export const MAX_SAVE_BYTES = 64 * 1024 * 1024;

/** `save:list` never returns more than this many entries (newest first). */
export const MAX_SAVE_LIST_ENTRIES = 500;

/** Upper bound for `slotCount` (the settings schema allows 1..10; this leaves room). */
export const MAX_AUTOSAVE_SLOTS = 20;

/** Longest save name, in UTF-16 code units (the file name is `<name>.ctrl`). */
export const MAX_SAVE_NAME_LENGTH = 64;

/**
 * Why a save operation was refused. Errors carry this code only, never the payload or a path.
 * - `invalid`: the request failed its schema (bad name, malformed handle, empty bytes);
 * - `unknown-handle`: well-formed, but this window was never given that handle;
 * - `exists`: a manual save with that name exists and `overwrite` was false;
 * - `not-found`: the file behind a handle is gone;
 * - `too-large`: over {@link MAX_SAVE_BYTES};
 * - `read-only` / `write-only`: the handle doesn't allow that (autosave and opened files are
 *   read-only; Save As targets are write-only);
 * - `not-a-file`: the path is a directory, a symlink or a device;
 * - `busy`: a file dialog is already open for this window;
 * - `unavailable`: no storage (a browser without OPFS);
 * - `io`: anything else the file system threw (its message is not forwarded).
 */
export const SaveIoErrorCode = z.enum([
  'invalid',
  'unknown-handle',
  'exists',
  'not-found',
  'too-large',
  'read-only',
  'write-only',
  'not-a-file',
  'busy',
  'unavailable',
  'io',
]);
export type SaveIoErrorCode = z.infer<typeof SaveIoErrorCode>;

/** The message every refusal uses: `save:read refused (unknown-handle).` (channel + code, nothing else). */
export function saveRefusalMessage(operation: string, code: SaveIoErrorCode): string {
  return `${operation} refused (${code}).`;
}

/**
 * Recovers the code from a refusal message (Electron wraps handler errors in
 * `Error invoking remote method '…': Error: …`). Anything unrecognised is `io`.
 */
export function saveErrorCodeOf(message: string): SaveIoErrorCode {
  const match = /refused \(([a-z-]+)\)\.?/.exec(message);
  const parsed = SaveIoErrorCode.safeParse(match?.[1]);
  return parsed.success ? parsed.data : 'io';
}

/**
 * An opaque save handle: 128 random bits, base64url (22 characters). It means nothing outside the
 * table that issued it, so a renderer can't build one from a path, and a forged one is refused.
 */
export const SaveHandleSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export type SaveHandle = z.infer<typeof SaveHandleSchema>;

/** Device names Windows reserves in every directory (`CON`, `CON.txt`, `com1`, …). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * A save name as the player sees it, and the stem of its file name. Letters (any script, with
 * combining marks for NFD file systems), digits, space and `_ - . , ( ) ' & + ! # [ ]`. It must
 * start with a letter or digit and not end with a space or dot (Windows strips those), and must not
 * be a Windows device name. No separators, so no traversal.
 */
export const SaveNameSchema = z
  .string()
  .min(1)
  .max(MAX_SAVE_NAME_LENGTH)
  .regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N} _\-.,()'&+!#[\]]*$/u)
  .refine((name) => !/[ .]$/.test(name), 'must not end with a space or dot')
  .refine((name) => !WINDOWS_RESERVED.test(name), 'reserved name');
export type SaveName = z.infer<typeof SaveNameSchema>;

/** `manual`: named, in the save directory. `autosave`: a rotating slot. `external`: a file the player picked. */
export const SaveKind = z.enum(['manual', 'autosave', 'external']);
export type SaveKind = z.infer<typeof SaveKind>;

/** One save as the renderer sees it: a handle and metadata, never a path. */
export const SaveEntrySchema = z.strictObject({
  handle: SaveHandleSchema,
  /** Manual: the save name. Autosave: `Autosave N`. External: the picked file's base name. */
  name: z.string().min(1).max(255),
  kind: SaveKind,
  /** Autosave slot (1-based), else null. */
  slot: z.int().min(1).max(MAX_AUTOSAVE_SLOTS).nullable(),
  /** Last modified, whole milliseconds since the epoch. */
  modifiedMs: z.int().nonnegative(),
  sizeBytes: z.int().nonnegative(),
});
export type SaveEntry = z.infer<typeof SaveEntrySchema>;

/** `save:list` response: manual saves and autosave slots, newest first. */
export const SaveListResponseSchema = z.array(SaveEntrySchema).max(MAX_SAVE_LIST_ENTRIES);

/** `save:list` takes no payload. */
export const SaveListRequestSchema = z.undefined();

/** `save:read` request. The response is the file's bytes (a `Uint8Array`). */
export const SaveReadRequestSchema = z.strictObject({ handle: SaveHandleSchema });
export type SaveReadRequest = z.infer<typeof SaveReadRequestSchema>;

/** True for a real `Uint8Array` from any realm (IPC and `contextBridge` copy them across worlds). */
export function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
}

/** Save bytes: a non-empty `Uint8Array`. The size cap is checked separately, so it gets its own code. */
export const SaveBytesSchema = z.custom<Uint8Array>((value) => isUint8Array(value) && value.byteLength > 0);

/**
 * Where `save:write` puts the bytes.
 * - `manual`: `<name>.ctrl` in the save directory; refused with `exists` unless `overwrite`;
 * - `autosave`: the next of `slotCount` rotating slots (main or the web store picks it);
 * - `handle`: the file behind a writable handle (a manual save from `save:list`, or a Save As target).
 */
export const SaveTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual'), name: SaveNameSchema, overwrite: z.boolean() }),
  z.strictObject({ kind: z.literal('autosave'), slotCount: z.int().min(1).max(MAX_AUTOSAVE_SLOTS) }),
  z.strictObject({ kind: z.literal('handle'), handle: SaveHandleSchema }),
]);
export type SaveTarget = z.infer<typeof SaveTargetSchema>;

/** `save:write` request. The response is the written file's {@link SaveEntry}. */
export const SaveWriteRequestSchema = z.strictObject({ target: SaveTargetSchema, bytes: SaveBytesSchema });
export type SaveWriteRequest = z.infer<typeof SaveWriteRequestSchema>;

/** File types the dialogs offer. Only saves in P1. */
export const DialogFileType = z.enum(['ctrl']);
export type DialogFileType = z.infer<typeof DialogFileType>;

/** `dialog:open` request. The response is a read-only {@link SaveEntry} (`kind: 'external'`), or null if cancelled. */
export const DialogOpenRequestSchema = z.strictObject({ fileType: DialogFileType });
export type DialogOpenRequest = z.infer<typeof DialogOpenRequestSchema>;
export const DialogOpenResponseSchema = SaveEntrySchema.nullable();

/** `dialog:saveAs` request. The response is a write-only target, or null if cancelled. */
export const DialogSaveAsRequestSchema = z.strictObject({ fileType: DialogFileType, suggestedName: SaveNameSchema });
export type DialogSaveAsRequest = z.infer<typeof DialogSaveAsRequestSchema>;

/** A Save As target: write to it with `save:write { target: { kind: 'handle', handle } }`. */
export const SaveAsTargetSchema = z.strictObject({ handle: SaveHandleSchema, name: z.string().min(1).max(255) });
export type SaveAsTarget = z.infer<typeof SaveAsTargetSchema>;
export const DialogSaveAsResponseSchema = SaveAsTargetSchema.nullable();

/** File name of a manual save. */
export const manualSaveFileName = (name: SaveName): string => `${name}.${SAVE_FILE_EXTENSION}`;

/** Name of a manual save from its file name, or null if the file isn't one (wrong extension, bad name). */
export function manualSaveNameOf(fileName: string): SaveName | null {
  const suffix = `.${SAVE_FILE_EXTENSION}`;
  if (!fileName.endsWith(suffix)) return null;
  const parsed = SaveNameSchema.safeParse(fileName.slice(0, -suffix.length));
  return parsed.success ? parsed.data : null;
}

/** Autosave slots live in a subdirectory of the save directory, so manual names never collide with them. */
export const AUTOSAVE_DIRECTORY = 'autosave';

/** File name of autosave slot `slot` (1-based) inside {@link AUTOSAVE_DIRECTORY}. */
export const autosaveFileName = (slot: number): string => `slot-${slot}.${SAVE_FILE_EXTENSION}`;

/** Slot number from an autosave file name, or null. Only canonical names (`slot-3.ctrl`, not `slot-03.ctrl`). */
export function autosaveSlotOf(fileName: string): number | null {
  const match = /^slot-([1-9][0-9]?)\.ctrl$/.exec(fileName);
  if (!match) return null;
  const slot = Number(match[1]);
  return slot <= MAX_AUTOSAVE_SLOTS ? slot : null;
}

/** Display name of an autosave slot. */
export const autosaveDisplayName = (slot: number): string => `Autosave ${slot}`;

/**
 * Picks the autosave slot to write next (ADR 0009). With `lastWritten` known (this session), the
 * slot after it, wrapping at `slotCount`. Otherwise the lowest free slot in `1..slotCount`, else the
 * one with the oldest mtime (ties: the lowest slot). The session counter makes rotation immune to
 * coarse mtimes (FAT's 2 s), which would otherwise tie and overwrite one slot forever.
 */
export function pickAutosaveSlot(
  existing: readonly { readonly slot: number; readonly modifiedMs: number }[],
  slotCount: number,
  lastWritten: number | null,
): number {
  if (lastWritten !== null) return lastWritten >= slotCount ? 1 : lastWritten + 1;
  const inRange = existing.filter((e) => e.slot >= 1 && e.slot <= slotCount);
  for (let slot = 1; slot <= slotCount; slot++) if (!inRange.some((e) => e.slot === slot)) return slot;
  let oldest = inRange[0];
  for (const entry of inRange)
    if (
      oldest === undefined ||
      entry.modifiedMs < oldest.modifiedMs ||
      (entry.modifiedMs === oldest.modifiedMs && entry.slot < oldest.slot)
    )
      oldest = entry;
  return oldest?.slot ?? 1;
}

/** Newest first; ties keep a stable order (manual before autosave, then name). */
export function compareSaveEntries(a: SaveEntry, b: SaveEntry): number {
  if (a.modifiedMs !== b.modifiedMs) return b.modifiedMs - a.modifiedMs;
  if (a.kind !== b.kind) return a.kind < b.kind ? 1 : -1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
