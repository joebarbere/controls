# ADR 0009: Save I/O boundary

**Status:** Accepted (F1.8b part 2: platform save I/O). Amended 2026-10-28: Continue resumes the last-played save (settings v2). Amended 2026-11-18 (P4 Saves): `save:delete`, `save:thumbnail` and case-unique manual names ([below](#delete-thumbnails-and-case-unique-names)).
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

The session counter matters: on a file system with coarse timestamps (FAT's 2 s) several slots can share an mtime, and "oldest" alone would overwrite the same slot forever. A failed write doesn't advance the counter. After a successful write, slots above `slotCount` are deleted (the player lowered the count; they would otherwise go stale forever). Continue (part 3) lists and tries the last-played save first ([below](#continue-and-the-last-played-save)), then the newest, falling back to the next if `readCtrl` refuses it.

### Web harness storage: OPFS

The browser harness keeps saves in the **origin-private file system** (`navigator.storage.getDirectory()`), under `saves/` and `saves/autosave/`, with the same names, schemas, handles and reason codes as main (`WebSaveStore`).

- **Why not IndexedDB:** both work under the CSP and COOP/COEP (neither is a fetch, so `connect-src` and COEP don't apply, and both are available to a cross-origin-isolated page; the e2e test checks `crossOriginIsolated` alongside the round trip). OPFS maps one-to-one onto the desktop layout (directories and files, `lastModified`, size), so the store's code mirrors main's. Its `createWritable()` writes a swap file that `close()` commits, which is the same atomicity contract as temp-and-rename. And it can be faked in Node with a 100-line in-memory directory, where IndexedDB would need a new test dependency (`fake-indexeddb`) and a licence row.
- **A new file exists, empty, as soon as `getFileHandle({ create: true })` returns**, before its first write commits. The store removes it again if that write fails, and listing skips empty files (no valid save is empty) in case the tab closed in between.
- **Open is an upload** (`<input type="file">`, whose `cancel` event reports a dismissed chooser) and **Save As is a download** (`<a download>` on a `blob:` URL). A download has no picker, so it can't be cancelled and is named after the suggested name. Both need transient user activation: call them from the click or key handler.

### Continue and the last-played save

_Added after F1.8b part 3 (fix/continue-last-played)._ Part 3 shipped Continue as "the newest save that loads". That resumes the wrong game whenever a save newer than the game the player was in exists. The case that showed it: playing game A with unsaved changes, the player loads save X; A is autosaved before X replaces it (so A isn't lost); they quit without changing X, so nothing of X is written. Next launch, A's autosave is the newest file and Continue loads A. The same happens without any autosave: save A at 10:00, load yesterday's X, quit.

**Decision:** settings hold a pointer, `saves.lastPlayed`: `{ kind: 'manual', name }` or `{ kind: 'autosave', slot }` or `null` (`LastPlayedSave`, settings v2). `SaveGames` sets it for the game running now whenever the save directory gets or gives that game:

- a load from the directory (Load list, Continue) points at the entry loaded;
- a manual save or an autosave of the current game points at the entry written. A write that lands after its game was replaced (queued before a New sandbox) moves nothing, so the pre-load autosave of A points at A's slot first and the load then points at X;
- a load of a file from outside the directory (Open) sets `null`: its handle doesn't outlive the window, and the web harness's upload can't be read again.

Continue lists the directory and tries the pointer's entry first, then the rest newest first, as before. A pointer to a save that no longer loads, or that has gone, is named in the one "skipped" warning, and the newest save that loads is used.

To make the pointer total, the directory must hold the game the player is in. **Autosave now writes any game the directory doesn't hold as it is**, not only one with changes since its last save: a game opened from outside the directory, or saved only with Save As, counts as not held, so the next autosave trigger (interval, menu, a load over it, quit) copies it into a slot and points there. An untouched New sandbox is still never autosaved.

The quit flush autosaves and then flushes settings itself: the host runs every registered flush at once, so the settings store's own flush may already have finished before autosave sets the pointer.

Alternatives considered:

- **Write X as the newest autosave when it loads** (or touch its mtime). No schema or IPC change, but it spends a slot on every load: with one slot it overwrites A's pre-load autosave immediately, losing A. Touching the mtime needs a new channel, changes the time the Load list shows as "saved", and can't touch a file the web harness uploaded.
- **"Last active" metadata inside each save.** Loading X writes nothing to X, so X can't be marked; marking A's autosave as "left for another save" still has to name X, which is the pointer with extra steps, and it doesn't cover the case with no pre-load autosave.
- **A `saves/last.json` written by main** behind a new `save:*` channel. It could be atomic with the write it follows, and could even remember an opened file's path in main. But it needs a new channel, a new persisted document, a second implementation in the web store (which still couldn't reopen an upload, so autosave would have to copy opened files in anyway) and contract tests on both platforms. The settings pointer reuses storage both platforms already have, with no IPC change.

Consequences: `settingsVersion` 2 (adds `saves`; v1 files migrate with `lastPlayed: null`). The pointer is a reference by name or slot, never a handle or path, and is resolved against a fresh listing (exact name only since the 2026-11-18 amendment; until then exact name first, then case-insensitively, for case-insensitive file systems). A crash in the 300 ms settings debounce after an autosave leaves the pointer at the same game's previous save, at most one autosave interval old. With autosave off, a game that exists only outside the directory isn't copied in, and Continue falls back to the newest save.

### Delete, thumbnails and case-unique names

_Amended 2026-11-18 (P4 Saves, PR 25; the P1 follow-ups "the Load list has no delete and shows no thumbnails" and "Continue's case-insensitive fallback")._ Players build up saves from P4's sandbox, so the Load list deletes them and shows the picture each was saved with.

**`save:delete { handle }`** deletes a manual save or an autosave slot. Save-directory handles only: a handle from Open or Save As is refused with `read-only` (the page never deletes a file outside the directory, whatever access its handle had), another window's or a guessed one is `unknown-handle`, a save already gone is `not-found`. Main resolves the location against the root as for every other operation, `lstat`s it (a regular file only; a directory is `not-a-file`; the `autosave/` directory must be a real one) and `unlink`s it, serialised with the writes so a delete never races a write to the same name. `unlink` removes a name: a file swapped for a symlink after the check is removed as the link, never through it. The handle stays in the table: writing that name again reuses it, and reading it meanwhile is `not-found`. A refused handle (`unknown-handle`, say one evicted from the bounded table) is not taken as a delete: the renderer lists again and reports the save gone only if the listing no longer has it, else nothing changes and the player is asked to try again. The renderer clears Continue's pointer if it named the deleted save; if that save held the game being played, the game counts as not held, so the next autosave copies it in (the pointer stays total).

**`save:thumbnail { handle }`** returns the save's `thumbnail.png` (PNG bytes) or `null`. **Main reads only that entry**: `readCtrlThumbnail` (`@controls/save-format`) takes a random-access source and reads the ZIP's tail (at most 64 KiB + 22 bytes, for the end record and a comment), its central directory (at most 256 KiB, `count` ≤ `CTRL_LIMITS.maxEntries`) and then the entry's local header with its name and its data (at most `maxThumbnailBytes`, 4 MiB). For that entry it applies `readZipDirectory`'s checks (no ZIP64, version needed ≤ 2.0, only the allowed flags, so no encryption, stored or DEFLATE, one disk, local method and name bytes equal to the central directory's), the same slice-wise inflate and CRC-32 check, and the PNG signature; the other entries are never read or checked. Main opens the file the way `save:read` does (`lstat`, size cap, `O_NOFOLLOW`, `fstat`) and reads ranges through the descriptor. This is the one place the I/O layer looks inside a save, and only as a display path: anything malformed is `null`, never an error, and a `null` says nothing about whether the save loads. Readable handles only (a Save As target is `write-only`), so an opened file's thumbnail can be read too. The web harness implements both through OPFS, reading the thumbnail with `File.slice()`.

- **Why not decode in the renderer from `save:read`:** a 30 MiB save would cross IPC whole for a 20 KiB picture, for every save in the list, every time it opens. The parser is shared, so the renderer could run it on the bytes, but the cost is in the transfer.
- **Why a domain function and not main-only code:** both platforms need it (the web store reads OPFS files), and `save-format` already owns the ZIP subset and its caps; a second parser would drift.
- **Display:** the Load list turns each thumbnail into a `blob:` URL (`img-src 'self' data: blob:` is already in the CSP; no header changed) and revokes them when the dialog closes. The renderer re-checks the response: `null`, or PNG-signed bytes within `MAX_SAVE_THUMBNAIL_BYTES` (`isSaveThumbnail`).

**Manual names are unique ignoring case.** Continue's pointer was resolved by exact name, then case-insensitively, so that on a case-insensitive file system a pointer written as "shop" still found the listed "Shop". On a case-sensitive one the fallback could pick another save: "SHOP", when the last-played "Shop" had been deleted outside the game. Both platforms now keep at most one manual save per `saveNameKey` (NFC, then lower case: Windows and macOS ignore case, APFS ignores normalisation). A `save:write` whose name clashes with another listed save's is `exists`, or with `overwrite` replaces that save under its existing spelling, and the entry it returns carries the name a listing shows. The pointer is therefore always the listed spelling, and Continue matches it **exactly**. Two spellings already on disk ("Shop" and "shop", which 0.4.0 could create on Linux or in OPFS) are left alone: a write prefers the exact match, else the first by code units. So that the prompt and the write never disagree, **the Save game dialog resolves the exact listed name and submits it**: the typed spelling if a save has it, else this game's own save if listed under the key (no prompt), else the first other save under the key (asked about first, by name). The store's tie-break is then only reached by other callers (scripts). A pointer written by an earlier build with another spelling falls back to the newest save with the usual warning.

_Rejected:_ folding case only where the folder is case-insensitive (probing the file system per launch is a write main doesn't otherwise need, and saves copied between machines would still collide); keeping the fallback only when exactly one save matches (still picks "SHOP" in the case above).

### One contract, two platforms

`describeSaveIoContract` (`@controls/platform-api/testing`) runs the same behaviour tests (28 at F1.8b; the 2026-11-18 amendment added delete, thumbnail and case-clash tests) against Electron (the real `ElectronPlatform` over an in-process bridge that structured-clones like IPC, into main's real handlers, store and handle table on a temp directory) and the web harness (`WebSaveStore` on an in-memory OPFS). Tests that need a real Save As picker (cancel, adding the extension) are skipped on the web.

## Consequences

- New IPC channels: `save:list`, `save:read`, `save:write`, `dialog:open`, `dialog:saveAs` (and, from the 2026-11-18 amendment, `save:delete` and `save:thumbnail`). Each checks the `app://` sender, parses its payload with the `ipc-contract` schema, and refuses with `<channel> refused (<code>).`: the code only, never the payload or a path. File-system errors become `io`, and main logs only their errno code. One dialog per window at a time (`busy`).
- `Platform` gains `files` and `dialogs`; any fake `Platform` in a spec needs both.
- Handles don't survive a restart or a reload of a different window. Part 3 lists again at start-up; nothing should persist a handle (in settings, a replay log or a save).
- ~~No delete channel yet~~: `save:delete` (save-directory handles only) shipped with the 2026-11-18 amendment; autosaves are still also pruned by rotation.
- The save directory is fixed under `userData`. Making it configurable (or adding cloud sync) would need its own ADR, and handles would still be the only thing the renderer sees.
