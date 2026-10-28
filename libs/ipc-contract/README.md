# ipc-contract (`@controls/ipc-contract`)

The single source of truth for Electron IPC (`type:contract`): channel names (`IpcChannel`), Zod schemas (`AppInfoSchema`, the settings checks, and `FlushRequestSchema` / `FlushAckSchema` with `FLUSH_BEFORE_QUIT_TIMEOUT_MS` for the flush-before-quit handshake) and the `ControlsBridge` type that the preload exposes as `window.controls`. To add a channel, add its name, then its schema, then the main handler, the preload export and the `platform-electron` consumer. `app:flush-request` is the only main → renderer channel ([UI shell: flush before quit](../../docs/architecture/ui-shell.md#flush-before-quit)).

The sandboxed preload imports `@controls/ipc-contract/preload` (channels and types only, no Zod). May depend only on `type:contract` and `type:domain` libs, with no Angular or Electron. Tests: `pnpm nx test ipc-contract`.
