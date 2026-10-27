# Commands and the world model

> **Status (F1.2):** the registry, bus, undo/redo, replay and `when` live in `libs/domain/commands` (`@controls/commands`). The world commands, PRNG and `world.hash` live in `libs/domain/world-model` (`@controls/world-model`). The Angular adapter is `libs/features/session` (`@controls/feature-session`). The palette (F1.3), keybindings (F1.4), console (F1.5) and scripting API with `sim-cli` (F1.6) are still to come. Decisions: [ADR 0006](../decisions/0006-command-system.md) (semantics) and [ADR 0007](../decisions/0007-world-document-v1.md) (ids, PRNG, hash). Gotchas: [commands caveats](../caveats/commands.md).

## One registry, four surfaces

Every surface goes through the same registry and bus. Only the bus changes the world; the UI reacts to the signal.

```mermaid
flowchart LR
    classDef later fill:#f4f4f4,stroke:#999,stroke-dasharray: 4 3;
    BTN["UI buttons<br/>(Reset layout)"] --> SES
    PAL["Palette (F1.3)"]:::later --> SES
    KEY["Keybindings (F1.4)"]:::later --> SES
    CON["Console (F1.5)"]:::later --> SES
    SES["feature-session<br/>Session: world signal, exec, context keys"] --> BUS
    SCR["scripting-api + sim-cli (F1.6)"]:::later --> BUS
    subgraph domain["type:domain"]
        BUS["CommandBus&lt;World&gt;<br/>@controls/commands"]
        REG["CommandRegistry<br/>entity.*, edit.*, view.*"]
        WM["world-model<br/>entity commands, world.hash, sfc32"]
        SF["save-format<br/>World, ReplayEntry, CommandId"]
        BUS --> REG
        REG --> WM
        BUS --> SF
        WM --> SF
    end
    BUS -->|"executed event"| SES
    SES -->|"onCommand('view.resetLayout')"| WS["feature-workspace<br/>resets its layout"]
```

## `exec`

```mermaid
sequenceDiagram
    participant S as Surface
    participant B as CommandBus
    participant D as CommandDef
    S->>B: exec(id, args)
    B->>B: registry lookup, else unknown-command
    B->>D: args.safeParse(args), else invalid-args
    B->>B: ReplayEntry.safeParse({seq, tick, id, args}), else invalid-args
    B->>D: run(ctx, loggedArgs)
    D-->>B: succeed(change) | succeed() | fail(code)
    B->>B: next = change.apply(state) (a throw → threw)
    B->>B: commit stacks, state, log entry
    B-->>S: { ok: true, entry } and an executed event
```

A failure at any step returns a typed error and changes nothing.

## Undo, redo and the log

| Command result             | Undo stack | Redo stack | Logged |
| -------------------------- | ---------- | ---------- | ------ |
| Undoable change            | push       | clear      | yes    |
| Non-undoable change        | clear      | clear      | yes    |
| No change (view command)   | unchanged  | unchanged  | yes    |
| `edit.undo`                | pop        | push       | yes    |
| `edit.redo`                | push       | pop        | yes    |
| Failure (incl. empty undo) | unchanged  | unchanged  | no     |

Replay re-runs every entry, `edit.undo` included, through a fresh bus from the log's `initialWorld`. The bus is deterministic, so it rebuilds the same stacks and reaches the live hash. That is the F1.2 property test.

```mermaid
flowchart LR
    W0["initialWorld"] --> BUS2["fresh CommandBus"]
    LOG["entries: seq, tick, id, args"] --> RE["replayEntries"]
    BUS2 --> RE
    RE -->|"each entry: exec, then check tick and args"| W1["world"]
    W1 --> H["world.hash<br/>SHA-256(canonical JSON)"]
```

## World commands

| Id              | Args                                                   | Apply                                                   | Invert                                 |
| --------------- | ------------------------------------------------------ | ------------------------------------------------------- | -------------------------------------- |
| `entity.place`  | `ref`, `positionMm`, `orientationMdeg` (default zeros) | appends an entity with id `nextEntityId`, increments it | removes it and restores `nextEntityId` |
| `entity.move`   | `id`, `positionMm` (absolute)                          | sets the position                                       | restores the old position              |
| `entity.rotate` | `id`, `deltaMdeg` (each in ±359 999)                   | adds the delta per axis modulo 360 000                  | subtracts it                           |
| `entity.delete` | `id`                                                   | removes the entity; `nextEntityId` unchanged            | reinserts it, same id, in sorted order |

Positions are integer mm and angles integer millidegrees, validated by the `save-format` primitives. Unknown ids fail with `not-found`.

## Determinism primitives

- **`world.hash`:** `sha256Hex(canonicalJson(world))`. The canonical JSON sorts keys by UTF-16 code units and formats numbers and strings as `JSON.stringify` does. SHA-256 is written from FIPS 180-4 and is synchronous, so it runs in Node, the renderer and the worker. Golden hashes are asserted in Node (`world-model`) and in Chromium (`apps/game-e2e/src/world-hash.spec.ts`).
- **PRNG:** sfc32 with streams from `deriveStream(seed, key)`. Keys are `command:<seq>` or `entity:<id>`. No generator state is persisted.
