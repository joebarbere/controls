# Commands and the world model

> **Status (F1.6):** the registry, bus, undo/redo, replay and `when` live in `libs/domain/commands` (`@controls/commands`), with the keybinding core (chords, conflicts, resolution, input actions) under `keybindings/` and the console-line parser under `console/`. The world commands, PRNG and `world.hash` live in `libs/domain/world-model` (`@controls/world-model`). The scripting API's `Game` (`@controls/scripting-api`) wraps them; `sim-cli` scripts drive it, and so does the Angular adapter `libs/features/session` (`@controls/feature-session`: `Session`, `KeybindingService` and `ToolBelt`); see [scripting and sim-cli](scripting.md). The command palette (`feature-palette`, F1.3) is the second UI surface; the console UI (F1.5) is still to come. Decisions: [ADR 0006](../decisions/0006-command-system.md) (semantics) and [ADR 0007](../decisions/0007-world-document-v1.md) (ids, PRNG, hash). Gotchas: [commands caveats](../caveats/commands.md).

## One registry, four surfaces

Every surface goes through the same registry and bus. Only the bus changes the world; the UI reacts to the signal.

```mermaid
flowchart LR
    classDef later fill:#f4f4f4,stroke:#999,stroke-dasharray: 4 3;
    BTN["UI buttons<br/>(Reset layout)"] --> SES
    PAL["CommandPalette (F1.3)<br/>forms from Zod args"] --> SES
    KEY["KeybindingService (F1.4)<br/>document keydown"] --> SES
    CON["Console (F1.5)"]:::later --> SES
    SES["feature-session<br/>Session: world signal, exec, context keys"] --> GAME
    SCR["sim-cli scripts and .console files (F1.6)"] --> GAME
    GAME["scripting-api Game<br/>exec, world(), hash(), on()"] --> BUS
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
    SES -->|"onCommand('toolbelt.select')"| TB["ToolBelt<br/>active slot, toolbelt.slot key"]
    SES -->|"onCommand('palette.open')"| PAL
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

## View commands

| Id                 | Args                           | Effect (applied by the UI through `Session.onCommand`)                            |
| ------------------ | ------------------------------ | --------------------------------------------------------------------------------- |
| `view.resetLayout` | none                           | the workspace restores its default panel layout                                   |
| `toolbelt.select`  | `slot`: integer 1–9 (required) | `ToolBelt` sets the active slot and the `toolbelt.slot` context key; HUD shows it |

Both are logged, never change the world or its hash, and replay headless as no-ops.

## Keybindings

```mermaid
flowchart LR
    subgraph domain["@controls/commands keybindings/ (type:domain)"]
        DEF["defaultBindingDecls(registry)<br/>CommandDef.keybinding · toolbelt.select.slot1–9 · INPUT_ACTIONS"]
        KM["Keymap.create(decls, overrides, platform)<br/>canonical chords · conflicts · invalid overrides"]
        DIS["provablyDisjoint(when, when)<br/>NNF + capped DNF"]
        DEF --> KM
        DIS --> KM
    end
    SET["settings controls.keybindings<br/>binding id → chord | null"] -->|"KEYBINDING_OVERRIDES"| KS
    KM --> KS["KeybindingService<br/>(feature-session)"]
    KEYDOWN["document keydown"] --> KS
    KS -->|"resolve(chord, contextKeys, restricted?)"| EXEC["Session.exec(command, args)"]
    KS -->|"inputCodes(): action → codes"| VP["Viewport → ViewportRenderer.setBindings"]
    KS --> UI["Key bindings dialog<br/>(feature-settings)"]
    UI -->|"setBinding / reset / resetAll"| SET
```

- **Binding ids** are the settings keys: a command id (`edit.undo`), a fixed-argument binding (`toolbelt.select.slot3` → `toolbelt.select {slot: 3}`) or an input action (`input.moveForward`, reserved namespace). Overrides replace every default of a binding; `null` unbinds.
- **Canonical chords** (`Mod+Shift+Z`): modifiers `Mod`, `Ctrl`, `Meta`, `Alt`, `Shift`, then a key name (`KeyboardEvent.code` without `Key`/`Digit`). `Mod` is Ctrl, or Cmd on macOS. Command letters follow the layout, everything else is positional; input actions are always positional bare keys.
- **Resolution:** the player's bindings first, then by id. The first command binding whose `when` holds runs; in text fields, code editors and dialogs only `globalKeybinding` commands do. Tab, Shift+Tab and Escape are reserved.
- **Conflicts:** same chord and `when`s not provably disjoint (input actions count as `viewport.focused`). Shown on both bindings, never shadowed. Rules and the proof are in [ADR 0006](../decisions/0006-command-system.md#keybindings-f14).

## Determinism primitives

- **`world.hash`:** `sha256Hex(canonicalJson(world))`. The canonical JSON sorts keys by UTF-16 code units and formats numbers and strings as `JSON.stringify` does. SHA-256 is written from FIPS 180-4 and is synchronous, so it runs in Node, the renderer and the worker. Golden hashes are asserted in Node (`world-model`) and in Chromium (`apps/game-e2e/src/world-hash.spec.ts`).
- **PRNG:** sfc32 with streams from `deriveStream(seed, key)`. Keys are `command:<seq>` or `entity:<id>`. No generator state is persisted.
