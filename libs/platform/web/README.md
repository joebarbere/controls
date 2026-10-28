# platform-web (`@controls/platform-web`)

`WebPlatform` (`type:platform`): the `Platform` implementation for the browser dev harness (`pnpm start:web`) and the `apps/game-e2e` Playwright tests. It reports `platform: 'web'` and `APP_VERSION` from `@controls/units`. Settings live in `localStorage`; saves (`WebSaveStore`, F1.8b) live in the origin-private file system (OPFS) under `saves/`, with the same names, handles and reason codes as the desktop app. Open uploads a file and Save As downloads one ([ADR 0009](../../../docs/decisions/0009-save-io-boundary.md)).

Must not depend on Electron. May depend only on `type:platform`, `type:contract` and `type:domain` libs. Tests: `pnpm nx test platform-web`.
