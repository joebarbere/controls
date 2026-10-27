# platform-web (`@controls/platform-web`)

`WebPlatform` (`type:platform`): the `Platform` implementation for the browser dev harness (`pnpm start:web`) and the `apps/game-e2e` Playwright tests. It reports `platform: 'web'` and `APP_VERSION` from `@controls/units`.

Must not depend on Electron. May depend only on `type:platform`, `type:contract` and `type:domain` libs. Tests: `pnpm nx test platform-web`.
