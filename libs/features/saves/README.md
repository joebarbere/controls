# @controls/feature-saves

Saving and loading games (`type:feature`, F1.8b part 3): `SaveGames` (the unlogged `file.save` / `file.saveAs` / `file.open` / `file.load` commands, autosave and Continue, over `Session`, `loadGame` and the platform's save I/O), `ctl-load-game-dialog`, `ctl-save-game-dialog`, the `SAVE_FILES` / `SAVE_DIALOGS` tokens (provided from `Platform.files` / `.dialogs` by `apps/game`), `SaveThumbnails` and the player-facing error messages.

Tests: `pnpm nx test feature-saves`. See [world and saves](../../../docs/architecture/world-and-saves.md) and the [UI caveats](../../../docs/caveats/ui.md).
