# ipc-contract (`@controls/ipc-contract`)

The single source of truth for Electron IPC (`type:contract`): channel names (`IpcChannel`), Zod response schemas (`AppInfoSchema`) and the `ControlsBridge` type that the preload exposes as `window.controls`. To add a channel, add its name, then its schema, then the main handler, the preload export and the `platform-electron` consumer.

The sandboxed preload imports `@controls/ipc-contract/preload` (channels and types only, no Zod). May depend only on `type:contract` and `type:domain` libs, with no Angular or Electron. Tests: `pnpm nx test ipc-contract`.
