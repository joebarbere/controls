# platform-api (`@controls/platform-api`)

The `Platform` interface (`type:platform`): everything the game needs from its host. In P0 that is only `getAppInfo()`; files, dialogs, settings and updates are added in P1. Features and the Angular app depend on this interface and never on a concrete implementation.

May depend only on `type:platform`, `type:contract` and `type:domain` libs. Tests: `pnpm nx test platform-api`.
