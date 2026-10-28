# scripting-api (`@controls/scripting-api`)

Framework-free domain library (`type:domain`): the scripting API v0 (plan §4.6 surface 4, F1.6). One typed object, `Game`, over the world command bus. `sim-cli` scripts drive it, and `@controls/feature-session` wraps the same object, so the UI and scripts run identical code. Guide: [scripting](../../../docs/guides/scripting.md). Decisions: [ADR 0008](../../../docs/decisions/0008-console-and-scripts.md).

- **`createGame({ seed })` / `createGame({ world })`:** `exec(id, args)`, `execOrThrow`, `world()` (a frozen snapshot), `hash()`, `entries()`, `replayLog()`, `canUndo()`/`canRedo()`, `contextKeys()`, `isEnabled(id, context)`, `on('executed', listener)`.
- **Reserved:** `probe(from, to)` (P2) and `tag(path)` (P10) exist in the type and throw `NotAvailableError` (`code: 'not-available'`).
- **`replayGame(json)`:** validates and migrates a replay log through `@controls/save-format`, replays it, and returns a `Game` at its end that continues the same log.
- **Saves (F1.8b):** `game.save({ thumbnail? })` returns `.ctrl` bytes; `loadGame(bytes, { registry?, limits? })` (or `gameFromSave(contents)` after `readCtrl`) returns `{ ok: true, game, manifest, thumbnail, fromVersion, replay }` or a typed `CtrlError`. The loaded game has an empty undo history and continues the save's replay log if it reproduces `world.json` (`replay.status` `continued`), otherwise starts a new one (`absent` / `restarted`).
- **Console-line files:** `runConsoleScript(target, text)` (parse every line first, then run; `world.hash` prints the hash), `toConsoleScript(entries)`. The line grammar lives in `@controls/commands` (`console/`).

Tests: `pnpm nx test scripting-api` (90 % coverage gate).
