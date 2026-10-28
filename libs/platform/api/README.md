# platform-api (`@controls/platform-api`)

The `Platform` interface (`type:platform`): everything the game needs from its host: `getAppInfo()`, `settings` (`SettingsService`), `quit()`, `lifecycle` (flush before quit), and since F1.8b `files` (`FileService`: list, read and write saves in the host's save directory, including rotating autosave slots) and `dialogs` (`DialogService`: Open and Save As). Saves are opaque bytes behind opaque handles, and every refusal is a `SaveIoError` with a `code` ([ADR 0009](../../../docs/decisions/0009-save-io-boundary.md)). Updates are still to come. Features and the Angular app depend on this interface and never on a concrete implementation.

`@controls/platform-api/testing` exports `describeSaveIoContract`, the save I/O behaviour suite both platforms run (`apps/desktop` for Electron, `platform-web` for the web harness). It is test-only (excluded from the lib build).

May depend only on `type:platform`, `type:contract` and `type:domain` libs. Tests: `pnpm nx test platform-api`.
