# ipc-contract (`@controls/ipc-contract`)

The single source of truth for Electron IPC (`type:contract`): channel names (`IpcChannel`), Zod schemas (`AppInfoSchema`, the settings checks, `FlushRequestSchema` / `FlushAckSchema` with `FLUSH_BEFORE_QUIT_TIMEOUT_MS` for the flush-before-quit handshake, and the save I/O schemas in `saves.ts`) and the `ControlsBridge` type that the preload exposes as `window.controls`. To add a channel, add its name, then its schema, then the main handler, the preload export and the `platform-electron` consumer. `app:flush-request` is the only main → renderer channel ([UI shell: flush before quit](../../docs/architecture/ui-shell.md#flush-before-quit)).

The sandboxed preload imports `@controls/ipc-contract/preload` (channels and types only, no Zod). May depend only on `type:contract` and `type:domain` libs, with no Angular or Electron. Tests: `pnpm nx test ipc-contract`.

## Save I/O channels (F1.8b, [ADR 0009](../../docs/decisions/0009-save-io-boundary.md))

Bytes are opaque `Uint8Array`s; main owns the save directory and the renderer holds opaque handles (`SaveHandleSchema`: 22 base64url characters). Every refusal is `<channel> refused (<code>).` with a `SaveIoErrorCode` (`saveRefusalMessage`, `saveErrorCodeOf`), never the payload or a path. `platform-web` uses the same schemas and codes, so both platforms refuse the same inputs.

| Channel         | Request                                                                                                                              | Response                                             | Refusals (besides `invalid`, `io`)                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `save:list`     | none                                                                                                                                 | `SaveEntry[]`, newest first, ≤ 500                   | `not-a-file`                                                           |
| `save:read`     | `{ handle }`                                                                                                                         | `Uint8Array` ≤ `MAX_SAVE_BYTES` (64 MiB)             | `unknown-handle`, `not-found`, `not-a-file`, `too-large`, `write-only` |
| `save:write`    | `{ target, bytes }`; target `{ kind: 'manual', name, overwrite }`, `{ kind: 'autosave', slotCount }` or `{ kind: 'handle', handle }` | `SaveEntry`                                          | `exists`, `unknown-handle`, `read-only`, `too-large`, `not-a-file`     |
| `dialog:open`   | `{ fileType: 'ctrl' }`                                                                                                               | read-only `SaveEntry` (`kind: 'external'`) or null   | `busy`, `not-found`, `not-a-file`                                      |
| `dialog:saveAs` | `{ fileType: 'ctrl', suggestedName }`                                                                                                | write-only `SaveAsTarget` `{ handle, name }` or null | `busy`                                                                 |

`SaveEntry` is `{ handle, name, kind: 'manual' | 'autosave' | 'external', slot, modifiedMs, sizeBytes }`. Names are `SaveNameSchema` (no separators, so no traversal); autosave slots are picked with `pickAutosaveSlot`.
