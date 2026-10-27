# ADR 0006: Command system semantics

**Status:** Accepted (F1.2)
**Date:** 2026-10-27 (Phase 1)
**Sources:** plan §4.6; [phase 1 plan](../../plans/phase-1-game-shell.md) F1.2, F1.4; [ADR 0007](0007-world-document-v1.md) (ids, PRNG, hash, replay log shape)

## Context

Every world change and every logged UI action is a registered Command, shared by the palette, keybindings, console and scripting API (plan §4.6). The replay log plus the initial world must reproduce a session's `world.hash` exactly, in the game and headless in `sim-cli`. That needs precise answers to: what a command returns, what undo does, what gets logged (including undo itself), how view actions differ from world changes, where per-frame input fits, and what `when` means. ADR 0007 already fixed the world document, id allocation, the hash and the log's shape.

## Decisions

### Where the code lives

- `@controls/commands` (`type:domain`) is the engine: `CommandDef`, `CommandRegistry`, `CommandBus`, the `when` parser, the built-in `edit.*` and view commands, and `replayEntries`. It is generic over its state `S`, and its property tests use a toy state.
- `@controls/world-model` (`type:domain`) instantiates it for `World`: the `entity.*` commands, `createWorldRegistry()`, `createWorldBus()`, `replayLog()`, plus the PRNG and `world.hash`. Its property tests repeat the engine's properties with the real commands and the real hash.
- `@controls/feature-session` (`type:feature`) is a thin Angular adapter: the world as a signal, `exec`, context keys, `onCommand`.

### A command

- `CommandDef<A, S>` has the §4.6 fields (`id`, `title`, `category`, Zod `args`, `when`, `keybinding`, `undoable`, `cheat`, `run`).
- `run(ctx, args)` is **pure**. It reads `ctx.state` (plus `seq`, `tick`, `canUndo`, `canRedo`) and returns one of:
  - `succeed(change)`, where a change is an `{ apply, invert }` pair of pure functions;
  - `succeed()`, which changes nothing (view commands);
  - `fail(code, message)`, a refusal such as `not-found`.
- A change may capture values from the state it ran against (the deleted entity, the old position, the old `nextEntityId`). The stacks guarantee that `invert` only ever sees the state `apply` produced, and `apply` only the state it ran on.
- The registry rejects an id that doesn't match the replay log's `CommandId` grammar (reused from `@controls/save-format`), a duplicate id, or a `when` that doesn't parse. These throw `CommandRegistrationError`, because they are programming errors.

### `exec(id, args)`

1. Look up the id.
2. Parse `args` with the command's Zod schema.
3. Parse `{ seq, tick, id, args }` as a `ReplayEntry`. That proves the args are a loggable JSON object with finite numbers, and normalises `-0`.
4. Call `run` with the **logged** form of the args, so a live run and its replay see identical values.
5. Compute the next state. If `run` or the change throws, that is caught too.
6. Commit: update the stacks, set the state, append the entry and notify subscribers.

Any failure returns a typed `ExecError` (`unknown-command`, `invalid-args`, `rejected`, `threw`) and leaves the state, the history and the log untouched.

### Undo and redo

- **An undoable change** is pushed on the undo stack and clears the redo stack ("a new mutation clears redo").
- **A non-undoable change** (none in P1; a future `sim.step` is the example) clears both stacks, because history can't be undone across it.
- **No change** (view commands, refusals) leaves both stacks alone.
- `edit.undo` inverts the top of the undo stack and moves it to redo; `edit.redo` does the reverse. Both are registered commands (`Mod+Z`, `Mod+Shift+Z`, `when: history.canUndo` / `history.canRedo`). **With an empty stack they fail** (`nothing-to-undo` / `nothing-to-redo`).
- The stacks are unbounded in P1. A cap would change which undos succeed, so any future cap must be a fixed constant applied identically in replay.

### What is logged

- **Every successful command, and only those.** That includes view commands and `edit.undo` / `edit.redo` (with `args: {}`). Failures are never logged.
- **Replay re-executes everything**, `edit.undo` included, through a fresh bus that starts from `initialWorld` with an empty history. The bus is deterministic, so it rebuilds the same stacks and reaches the same state and hash. `replayEntries` also checks each entry's `seq`, `tick` and (structurally) its args, and stops at the first entry that fails or diverges.
- **Why this is consistent with loading a save** (F1.8b clears the undo stack and continues the log): an undo or redo on an empty stack fails and isn't logged. So every undo the live session logged after a load acted on a post-load change, and that change is also on top of the replay's rebuilt stack. The redo stack is the same argument in reverse.
- **Rejected:**
  - logging undo as its inverse command: undoing `entity.place` restores `nextEntityId`, which no command can express;
  - pruning or rewriting the log on undo: the log stops being append-only, `seq` stops being stable, and a bug report loses what the player actually did;
  - a world snapshot per entry: large, and still needs the log for intent.

### View commands versus world commands

- **View commands** (`view.resetLayout` now; `view.mode` and `view.focus` with F1.7) are declared in domain code with `defineViewCommand`. Their `run` is a no-op, so a headless replay knows every id and argument schema a log can contain.
- They are logged (for bug-report fidelity and palette recents) but never change the world, its hash or the history.
- The feature that owns the view state applies the effect when the session reports the command (`Session.onCommand`). For example, the workspace's Reset layout button runs `exec('view.resetLayout')`, and the workspace resets its layout when the command comes back. A palette, keybinding or console call behaves identically.
- **Settings** are player preferences, not commands. They are edited through `SettingsStore` and never logged.

### Input actions versus commands

- Continuous, per-frame or exploratory input is an **input action**, handled in the renderer and never logged: WASD walking, mouse look, orbit and pan, hover, and cycling the selection. Input actions are rebindable (F1.4), keyed by physical key code.
- **Only commit points become commands**: placing (one `entity.place` on commit, none while dragging), a move commit, delete, switching mode and focusing a target. That keeps the replay log small and meaningful.
- **Selection is view state.** It feeds `when` (`selection.kind`) but isn't a command.

### `when`

- **Advisory.** The palette and keybindings use it to hide, disable or resolve commands (`registry.isEnabled`, `Session.isEnabled`). `exec` does **not** check it, because the UI context (mode, selection) isn't in the replay log, so a replay couldn't evaluate it. Any precondition that matters for the world belongs in `run`, which sees the world.
- **Grammar** (hand-written recursive descent; no `eval` or `new Function` under the CSP), lowest precedence first:
  - `||`;
  - `&&`;
  - `==` and `!=` (not chainable);
  - `!` (binds tighter than `==`, as in JavaScript);
  - parentheses, literals and keys.
- **Literals** are `true`, `false`, `null`, numbers and single- or double-quoted strings (escapes: `\\`, `\'`, `\"`).
- **Keys** are dotted identifiers looked up in a flat map (`{ mode: 'work', 'selection.kind': 'terminal' }`). A missing key reads as `null`, and a bare key is truthy unless it is `null`, `false`, `0` or `''`. Comparison is strict equality.
- Source is capped at 512 characters and nesting at 32 levels. Parse errors carry a 1-based column.
- The bus contributes `history.canUndo` and `history.canRedo`, and the UI adds the rest through `Session.setContext`.

### Cheats

A successful `cheat` command sets the world's `assisted` flag through the bus's `markAssisted` hook, **outside** its change. So undoing the cheat doesn't clear the flag, which is never cleared (ADR 0007). The consequence is that "undo everything returns the initial hash" holds only for sessions without cheats.

### Randomness

- A command that needs randomness derives a stream with `deriveStream(world.seed, commandStreamKey(ctx.seq))` (key `command:<seq>`). Entity-owned randomness uses `entityStreamKey(id)` (`entity:<id>`).
- Redo re-applies the stored change instead of re-running the command, so nothing is redrawn. A replay re-runs at the same `seq`, so it draws the same values.
- **The derivation** (fixed here and pinned by golden vectors):
  - `k = hashStreamKey(key)`: FNV-1a over the key's UTF-16 code units, folded with its length, then `mix32`;
  - the sfc32 state is `a = mix32(seed ^ 0x9e3779b9)`, `b = mix32(k ^ 0x85ebca6b)`, `c = mix32(((seed + k) mod 2^32) ^ 0xc2b2ae35)` and `counter = 1`;
  - then 12 outputs are discarded as a warm-up.
- `mix32` is the MurmurHash3 32-bit finaliser (public domain). Changing any of this changes every seeded behaviour and needs a `schemaVersion` bump.

### Ticks

Each entry records the state's `tick` when it ran (always 0 in P1), and replay refuses an entry whose recorded tick differs from the replayed one.

## Consequences

- Surfaces (palette F1.3, keybindings F1.4, console F1.5, scripting API F1.6) call `exec` and read `when` through the registry, and never touch state.
- A new view command is declared in domain code (in `@controls/commands` for now), never only in a component, or headless replay of a log that contains it fails with `unknown-command`.
- Command ids and argument shapes are save format (ADR 0007): renaming one or changing its args needs a `schemaVersion` bump and a log migration. `replayEntries` reports a changed args shape as `diverged`.
- F1.8b's load continues the loaded log with a cleared history; it never starts a new log or drops entries, which would break the undo argument above. That needs a small bus addition (clear the history, keep the log).
- The undo stack holds closures, so it is never persisted. A loaded session starts with an empty history, by design.
