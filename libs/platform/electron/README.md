# platform-electron (`@controls/platform-electron`)

`ElectronPlatform` (`type:platform`): implements `Platform` on top of the preload bridge (`window.controls`) and re-validates each response with the Zod schemas from `@controls/ipc-contract`. `findBridge()` tells the app whether it is running inside the Controls Electron shell.

Runs in the sandboxed renderer, so it must not import `electron` or Node APIs. May depend only on `type:platform`, `type:contract` and `type:domain` libs. Tests: `pnpm nx test platform-electron`.
