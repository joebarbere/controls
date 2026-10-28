# ADR 0009: Save I/O boundary

**Status:** Accepted (F1.8b part 2: platform save I/O)
**Date:** 2026-10-28 (Phase 1)
**Sources:** plan §4.3, §4.4, §4.11; [ADR 0004](0004-save-format.md) (atomic writes in main, N autosave slots); [phase 1 plan](../../plans/phase-1-game-shell.md) F1.8b; [electron caveats](../caveats/electron.md)

## Context

F1.8b makes saves real. The `.ctrl` container (`writeCtrl` / `readCtrl` in `@controls/save-format`) turns a session into bytes and back; something has to put those bytes on disk and find them again, in the desktop app and in the browser harness, without breaking the Electron posture: a sandboxed renderer with no Node, Zod-validated IPC, and a page that must stay `crossOriginIsolated`. Part 3 (autosave timer, Continue, Load) builds its UI on whatever this boundary offers, so the boundary must cover listing, reading, writing, autosave rotation and the native Open and Save As dialogs.

The questions: who owns paths, what the renderer holds instead, how a write survives a crash, how autosave slots rotate, and where the web harness keeps its saves.

## Decisions

### Bytes are opaque

`FileService` and `DialogService` (`@controls/platform-api`) move `Uint8Array`s. Encoding, validation and migration of the container are `save-format`'s job; the I/O layer never parses a save. That keeps the two halves of F1.8b independent and lets main enforce a single size cap (`MAX_SAVE_BYTES`, 64 MiB) without knowing the format.

### Main owns the save directory

Saves live in `<userData>/saves/` (so `CONTROLS_USER_DATA_DIR` moves them with the settings): manual saves are `<name>.ctrl`, autosaves `autosave/slot-N.ctrl`. Only main touches the file system. The renderer names a manual save; it never names a path.

- **Save names** (`SaveNameSchema`) are 1–64 characters of letters (any script, with combining marks), digits, space and `_ - . , ( ) ' & + ! # [ ]`, starting with a letter or digit, not ending in a space or dot, and not a Windows device name. There is no separator in the alphabet, so a name can't express traversal; main still checks that the resolved path is a direct child of its directory.
- **Autosaves are in a subdirectory**, so a manual save called `Autosave 1` or `slot-1` never collides with a slot. That directory must be a real directory: a symlink there is refused.
- **Listing** skips anything that isn't a regular file with a valid name: symlinks, temp files, other files.

### Opaque handles

Everything the renderer gets back is a **handle**: 128 random bits as 22 base64url characters (`SaveHandleSchema`). Main keeps a table (`SaveHandleTable`) from handle to location, scoped to the `WebContents` it was issued to.

- A handle from another window, a guessed one or a stale one is `unknown-handle`; anything that isn't 22 base64url characters is `invalid`. A path is never a handle.
- Save-directory entries get one stable handle per window (listing twice gives the same one). Locations hold a validated name or slot, never a path, and are resolved against the root on each use.
- A file picked in a native dialog becomes a handle to that absolute path. **Open gives a read-only handle; Save As gives a write-only one.** The page can read only what the player opened and write only where the player chose, never the other way round. Autosave slots are read-only too: only `write({ kind: 'autosave' })` writes them, so rotation stays in main.
- The table is bounded (4096, oldest first) and a window's handles are dropped when its `WebContents` is destroyed.

Alternatives: structured handles such as `manual:Shop` would be readable and survive restarts, but a renderer could then build one, and every check would rest on parsing it correctly. Exposing paths was never an option (plan §4.11).

### Atomic writes

`writeFileAtomic` (`apps/desktop/src/atomic-write.ts`, shared with `settings.json`):

1. a temp file in the **same directory** (a rename can't cross file systems), opened `wx` with mode 0600;
2. write it, `fsync` it;
3. `rename` it over the target (atomic on POSIX, and on NTFS through `MoveFileEx`);
4. `fsync` the directory on POSIX, so the rename itself is durable.

Any failure up to the rename removes the temp file and leaves the old save as it was; tests inject a failure at open, mid-write (half the data written), at `fsync` and at the rename, and check the old bytes. The directory `fsync` is best effort: once the rename has happened, reporting failure would tell the player a save failed that in fact landed. Reads `lstat` first and refuse anything but a regular file, check the size cap, then open with `O_NOFOLLOW` (where the platform has it) and check again on the descriptor, so a file swapped for a symlink in between is refused. Writes replace a symlink at the target rather than following it. All writes go through one queue, so autosave slot choice can't race.

### Autosave rotation

The caller passes `slotCount` (from settings); main (or the web store) picks the slot with `pickAutosaveSlot`:

- after a write in this session, the next slot, wrapping at `slotCount`;
- otherwise (first autosave after launch) the lowest free slot, else the oldest by mtime, ties to the lowest slot.

The session counter matters: on a file system with coarse timestamps (FAT's 2 s) several slots can share an mtime, and "oldest" alone would overwrite the same slot forever. A failed write doesn't advance the counter. After a successful write, slots above `slotCount` are deleted (the player lowered the count; they would otherwise go stale forever). Continue (part 3) lists, takes the newest autosave and falls back to the next if `readCtrl` refuses it.

### Web harness storage: OPFS

The browser harness keeps saves in the **origin-private file system** (`navigator.storage.getDirectory()`), under `saves/` and `saves/autosave/`, with the same names, schemas, handles and reason codes as main (`WebSaveStore`).

- **Why not IndexedDB:** both work under the CSP and COOP/COEP (neither is a fetch, so `connect-src` and COEP don't apply, and both are available to a cross-origin-isolated page; the e2e test checks `crossOriginIsolated` alongside the round trip). OPFS maps one-to-one onto the desktop layout (directories and files, `lastModified`, size), so the store's code mirrors main's. Its `createWritable()` writes a swap file that `close()` commits, which is the same atomicity contract as temp-and-rename. And it can be faked in Node with a 100-line in-memory directory, where IndexedDB would need a new test dependency (`fake-indexeddb`) and a licence row.
- **A new file exists, empty, as soon as `getFileHandle({ create: true })` returns**, before its first write commits. The store removes it again if that write fails, and listing skips empty files (no valid save is empty) in case the tab closed in between.
- **Open is an upload** (`<input type="file">`, whose `cancel` event reports a dismissed chooser) and **Save As is a download** (`<a download>` on a `blob:` URL). A download has no picker, so it can't be cancelled and is named after the suggested name. Both need transient user activation: call them from the click or key handler.

### One contract, two platforms

`describeSaveIoContract` (`@controls/platform-api/testing`) runs the same 28 behaviour tests against Electron (the real `ElectronPlatform` over an in-process bridge that structured-clones like IPC, into main's real handlers, store and handle table on a temp directory) and the web harness (`WebSaveStore` on an in-memory OPFS). Tests that need a real Save As picker (cancel, adding the extension) are skipped on the web.

## Consequences

- New IPC channels: `save:list`, `save:read`, `save:write`, `dialog:open`, `dialog:saveAs`. Each checks the `app://` sender, parses its payload with the `ipc-contract` schema, and refuses with `<channel> refused (<code>).`: the code only, never the payload or a path. File-system errors become `io`, and main logs only their errno code. One dialog per window at a time (`busy`).
- `Platform` gains `files` and `dialogs`; any fake `Platform` in a spec needs both.
- Handles don't survive a restart or a reload of a different window. Part 3 lists again at start-up; nothing should persist a handle (in settings, a replay log or a save).
- No delete channel yet: autosaves are pruned by rotation, and deleting a manual save from the Load screen can be added as `save:delete` (save-directory handles only) when part 3 needs it.
- The save directory is fixed under `userData`. Making it configurable (or adding cloud sync) would need its own ADR, and handles would still be the only thing the renderer sees.
