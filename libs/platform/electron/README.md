# platform-electron (`@controls/platform-electron`)

`ElectronPlatform` (`type:platform`): implements `Platform` on top of the preload bridge (`window.controls`) and re-validates each response with the Zod schemas from `@controls/ipc-contract`. `findBridge()` tells the app whether it is running inside the Controls Electron shell. `ElectronFileService` and `ElectronDialogService` (F1.8b) call `save:*` and `dialog:*`: they check each request with the same schema main uses (so an invalid request fails locally with the same code), re-validate every response, and turn main's `refused (<code>)` messages into `SaveIoError`.

Runs in the sandboxed renderer, so it must not import `electron` or Node APIs. May depend only on `type:platform`, `type:contract` and `type:domain` libs. Tests: `pnpm nx test platform-electron`.
