# ADR 0006: Command system semantics

**Status:** Accepted (F1.2); amended in F1.4 (keybindings, input actions, `toolbelt.select`), F1.3 (`palette.open`, unlogged UI-chrome commands, argument hints, cheat confirmation) and F1.7 (`view.mode`, `view.focus`, context-argument bindings, gestures)
**Date:** 2026-10-27 (Phase 1)
**Sources:** plan §4.6, §4.9; [phase 1 plan](../../plans/phase-1-game-shell.md) F1.2, F1.4, F1.7; [ADR 0007](0007-world-document-v1.md) (ids, PRNG, hash, replay log shape)

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
- **Except UI chrome (amended in F1.3).** A command with `logged: false` (`palette.open`, and `console.toggle` in F1.5) opens or closes UI chrome and carries no information replay needs. It runs through the registry and its listeners fire (`Session.onCommand`, the scripting API's `on('executed')`), but it is never written to the log, consumes no `seq` and leaves undo and redo alone. The success result and the executed event say so explicitly: `{ logged: false, entry: null }` instead of `{ logged: true, entry }`, and both carry `command` (`id`, `tick`, normalised `args`) either way.
  - **Why:** the replay log is save format, frozen once v0.2.0 ships. Replay logs and bug reports should carry only world and view changes, not every time the player opened the palette; a `seq` handed to an unlogged command would also be reused by the next logged one.
  - **Guard:** an unlogged state change would break replay, so the registry refuses `logged: false` together with `undoable` or `cheat` (`CommandRegistrationError`, reason `unlogged-state-change`), and `exec` refuses an unlogged command whose `run` returns a change or a history move (`ExecError` kind `unlogged-change`; nothing is committed).
  - **Older logs:** a log written before a command became unlogged may still contain it. `replayEntries` keeps such an entry as it is (`CommandBus.carryOver`, after checking its `seq` and tick) instead of running it. The command can't have changed the state, so this is exact, and every later entry keeps its `seq` and therefore its `seq`-derived randomness.
- **Replay re-executes everything**, `edit.undo` included, through a fresh bus that starts from `initialWorld` with an empty history. The bus is deterministic, so it rebuilds the same stacks and reaches the same state and hash. `replayEntries` also checks each entry's `seq`, `tick` and (structurally) its args, and stops at the first entry that fails or diverges.
- **Why this is consistent with loading a save** (F1.8b clears the undo stack and continues the log): an undo or redo on an empty stack fails and isn't logged. So every undo the live session logged after a load acted on a post-load change, and that change is also on top of the replay's rebuilt stack. The redo stack is the same argument in reverse.
- **Rejected:**
  - logging undo as its inverse command: undoing `entity.place` restores `nextEntityId`, which no command can express;
  - pruning or rewriting the log on undo: the log stops being append-only, `seq` stops being stable, and a bug report loses what the player actually did;
  - a world snapshot per entry: large, and still needs the log for intent.

### View commands versus world commands

- **View commands** (`view.resetLayout`, `toolbelt.select`, and since F1.7 `view.mode` and `view.focus`) are declared in domain code with `defineViewCommand`. Their `run` is a no-op, so a headless replay knows every id and argument schema a log can contain.
- They are logged (for bug-report fidelity and palette recents) but never change the world, its hash or the history.
- The feature that owns the view state applies the effect when the session reports the command (`Session.onCommand`). For example, the workspace's Reset layout button runs `exec('view.resetLayout')`, and the workspace resets its layout when the command comes back. A palette, keybinding or console call behaves identically.
- **Settings** are player preferences, not commands. They are edited through `SettingsStore` and never logged.

### Input actions versus commands

- Continuous, per-frame or exploratory input is an **input action**, handled in the renderer and never logged: WASD walking, mouse look, orbit and pan, hover, and cycling the selection. Input actions are rebindable (F1.4), keyed by physical key code.
- **Only commit points become commands**: placing (one `entity.place` on commit, none while dragging), a move commit, delete, switching mode and focusing a target. That keeps the replay log small and meaningful.
- **Selection is view state.** It feeds `when` (`selection.kind`) but isn't a command.
- _Confirmed in F1.4._ The input actions are declared as data next to the commands (`INPUT_ACTIONS` in `@controls/commands`: id, renderer action, title, held or triggered, default keys). The renderer implements them and its spec checks it implements exactly that table. The keybinding service resolves the player's overrides and hands the renderer a plain action → `KeyboardEvent.code` map (`ViewportRenderer.setBindings`). They never reach `exec`, so they never reach the replay log. **Mouse look** is an input action on the mouse axes, not a key: its options are the settings' look sensitivity and invert-Y, and pointer-lock release is the browser's Escape.

### Keybindings (F1.4)

**Chords.** A chord is zero or more modifiers and one key joined with `+` (`Mod+Shift+Z`, `F4`, `1`, `ShiftLeft`). Parsing (`normaliseChord`) accepts aliases (`Cmd`, `Control`, `Option`, `Esc`, `Up`, `]`, …) and any letter case.

- `Mod` is Ctrl on Windows and Linux and Cmd on macOS. The **canonical form**, which settings store and key events resolve to, puts modifiers in the order `Mod`, `Ctrl`, `Meta`, `Alt`, `Shift`, followed by the key. The platform's own command key is folded into `Mod`, so on Linux `Ctrl+K` is stored as `Mod+K`, and on macOS `Ctrl+K` stays `Ctrl+K`.
- **Key names** are `KeyboardEvent.code` with the `Key` and `Digit` prefixes dropped (`W`, `1`, `BracketRight`, `F5`, `ShiftLeft`).
- **Command chords match letters by layout.** On a Latin layout the letter the key types wins, so `Mod+Z` is the key labelled Z on AZERTY too. If the key types no ASCII character (Cyrillic, macOS Option, dead keys), the physical letter is used. If a letter position types punctuation (Dvorak), the punctuation is used. Digits and every other key are positional, so `Shift+1` stays `1` and the tool-belt keys stay on the top row.
- **Input-action chords are positional bare keys.** A modifier key on its own (`ShiftLeft` for sprint) is a valid input-action key but never a command key.
- **Reserved:** Tab and Shift+Tab (focus movement) and Escape (the shell's fixed "back" key: dialogs and the menu). The player can't bind them. Defaults may still use Escape: the viewport's clear-selection action uses it and falls through to the menu when nothing is selected.

**Bindings and storage.** A binding has an id, and that id is the key in settings `controls.keybindings` (`binding id → chord | null`, where `null` means unbound by the player):

- an argument-less command binds under its **command id** (`edit.undo`), with defaults from `CommandDef.keybinding` (a chord or a list);
- a command bound **with fixed arguments** gets its own id (`toolbelt.select.slot3` runs `toolbelt.select {slot: 3}`), because one chord can't carry arguments;
- an **input action** binds under `input.<action>` (`input.moveForward`). `input` is a reserved namespace: no command may use it, and the keymap refuses one that does.

All three fit the command-id grammar the v1 settings schema already uses for the record's keys, so **settings did not change shape** (only doc comments). Sharing one record is clean because the namespaces can't collide. Splitting it would only buy a `settingsVersion` bump. An override replaces all of a binding's defaults. Overrides that can't be used (an unknown key, a modifier on an input action, a reserved chord) are ignored, listed and shown in the rebinding UI, and left in the file. Overrides for ids this build doesn't know are ignored.

**Conflicts.** Two bindings on one chord conflict unless their `when`s are **provably disjoint**. Input actions count as `when: viewport.focused`, because they only listen on the viewport canvas. The proof is deliberately conservative:

1. Negations are pushed inward (De Morgan; `!(k == v)` becomes `k != v`) and each `when` is expanded to disjunctive normal form. Above 64 terms the proof gives up and assumes overlap.
2. Atoms are `k == v`, `k != v`, `k` (truthy) and `!k` (falsy). Anything else (key against key, …) is opaque and contradicts nothing.
3. Two `when`s are disjoint if every pair of terms clashes on some key: two different required values, `== v` with `!= v`, truthy with falsy, or a value of the wrong truthiness. A term containing `false` clashes with everything. Falsy means `null` (also a missing key), `false`, `0` and `''`, as in `evaluateWhen`.

A binding without `when` is never disjoint from anything. A property test checks soundness: no context satisfies two expressions the analysis calls disjoint. Conflicts are shown on both bindings and in a summary, never silently shadowed.

**Resolution order** is fixed: the player's bindings come before defaults, then bindings are ordered by id (code-unit order), never by registration or object-key order. A key press runs the first **command** binding on its chord whose `when` holds and that the focus rules allow. When two input actions share a key, the first in the same order keeps it. In the viewport an input action sees the key first, and a key it acts on (it calls `preventDefault`) never reaches the command layer.

**Focus rules.** The keybinding service listens on the document and ignores events an inner handler already handled. While focus is in a text field, a `<select>`, `contenteditable`, a CodeMirror editor (`.cm-editor`) or an open dialog, only bindings marked **global** fire. A command opts in with `CommandDef.globalKeybinding` (for the palette in F1.3 and the console toggle in F1.5). Auto-repeat never runs a command, because a held key would flood the replay log.

**The tool belt.** `toolbelt.select {slot}` (`slot` an integer from 1 to 9, strict object) is a view command declared in `@controls/commands` next to `view.resetLayout`. Keys 1 to 9 are bound by default. The UI applies it through `Session.onCommand` (the `ToolBelt` service) and publishes the `toolbelt.slot` context key. Its id and argument shape are now save format.

### Viewport commands, context arguments and gestures (F1.7)

**`view.mode {mode}`** (`mode`: `'walk' | 'work'`, strict) and **`view.focus {target}`** (`target`: a view target id, lower-case words joined by single hyphens, at most 64 characters: `backplate`, `din-rail-1`) are view commands in `@controls/commands` (`viewportCommands()`), registered by `createWorldRegistry()`. The viewport applies them through `Session.onCommand` and publishes `mode` as a `when` context key. **They are logged** (the default): unlike `palette.open` and `console.toggle`, they change what the player sees, so a bug report's log should show them. `view.focus` can't validate its target (a view command never sees the scene); the viewport ignores a target it can't focus. **Their ids and argument shapes are save format.**

**Context arguments.** One chord can't carry "the other mode" or "the selected thing", so a command binding may take arguments from context keys: `BindingTarget.contextArgs` maps an argument name to a context key (`{ id: 'selection.entityId' }`). The keymap resolves such a binding only while every key is set (not missing or `null`); `bindingArgs(target, context)` fills them when the key is pressed, so **the log holds concrete values**, never a reference to the selection. Rejected: arguments that mean "the current selection" (a log entry that can't be replayed without UI state); a toggle command (the log wouldn't say which mode was chosen).

**Extra bindings live on the command.** `CommandDef.bindings` declares bindings with fixed or context arguments, each with its own binding id; `defaultBindingDecls` collects them from the registry. The F1.7 defaults:

| Binding id                | Runs                                       | Default               | `when`                                    |
| ------------------------- | ------------------------------------------ | --------------------- | ----------------------------------------- |
| `view.mode.walk`          | `view.mode {mode: 'walk'}`                 | `V`                   | `viewport.focused && mode == 'work'`      |
| `view.mode.work`          | `view.mode {mode: 'work'}`                 | `V`                   | `viewport.focused && mode == 'walk'`      |
| `view.focus.selection`    | `view.focus {target: <selection.id>}`      | `F`                   | `viewport.focused && selection.focusable` |
| `entity.delete.selection` | `entity.delete {id: <selection.entityId>}` | `Delete`, `Backspace` | `viewport.focused && selection.entityId`  |

`V` is two bindings on provably disjoint `when`s, so it toggles without a conflict. All four need `viewport.focused`, as the input actions they replace did. The viewport publishes `mode`, `selection.id`, `selection.kind`, `selection.focusable` and `selection.entityId`.

**Input-action table changes.** `toggleMode` and `focusSelection` left `INPUT_ACTIONS`; `commitPlacement` (`Enter`, `NumpadEnter`) and `moveSelection` (`M`) joined it, and `clearSelection` (`Escape`) became "cancel placement, or clear the selection". Stored overrides under `input.toggleMode` / `input.focusSelection` are now unknown binding ids, which the keymap ignores and leaves in the settings file. No `settingsVersion` bump: the record's shape didn't change, and an unknown id was already defined as ignored.

**Gestures commit once.** The renderer turns pointer and key gestures into intents at commit points only, and `feature-workspace` executes each as exactly one Command: a click or `Enter` on a valid snap is one `entity.place {ref, positionMm, orientationMdeg}`; releasing a drag (or `Enter`/click after `M`) is one `entity.move {id, positionMm}` if the position changed; dragging produces nothing; Escape while placing produces nothing (the tool is put away as UI state). The arguments come from `placeOnTargets` in `@controls/world-model`, the same function scripts call, so a mouse session and a script that aims at the same points log identical entries and reach the same `world.hash` (`apps/sim-cli/scenarios/mouse-place-move-delete.*`, `apps/game-e2e/src/placement.spec.ts`).

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

### The palette (F1.3)

- **`palette.open` is an unlogged view command** (`Mod+K`, `Mod+Shift+P`, `globalKeybinding: true`, `logged: false`), declared next to `view.resetLayout`. It is UI chrome, so it never enters the replay log ("What is logged" above); closing the palette is not a command at all.
- **Argument forms are generated from each command's `args`** through `z.toJSONSchema(args, { io: 'input' })`. Commands may add **`.meta()` hints** to their schemas: `title` and `description` label and explain a field, and the `x-controls-ref` keyword (`ARG_REF_KEYWORD`; `entityRefMeta` for `entity`) marks an integer as a world-entity id, which the palette prefills from the `selection.entityId` context key. Hints only add JSON Schema keywords and never change what a schema accepts, so adding one to a persisted args shape is not a save-format change. Validation stays the command's own schema.
- **The palette never lists `palette.open`** and runs the chosen command only after its dialog has closed, so the command sees focus where the player left it.
- **Recents** (settings `palette.recents`) are the commands run from the palette, not every logged command: a keybinding or script shouldn't reorder the palette.
- **Cheats ask once per world.** Before a `cheat` command runs in a world that isn't assisted yet, the palette asks for confirmation; once the world is assisted there is nothing more to lose, so it doesn't ask again. The flag itself is still set by the bus ("Cheats" above).

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

- Surfaces (palette F1.3, keybindings F1.4, console F1.5, scripting API F1.6) call `exec` and read `when` through the registry, and never touch state. A command whose args the palette's form can't express fails the palette's every-command spec, so new argument shapes extend the form model first.
- A new view command is declared in domain code (in `@controls/commands` for now), never only in a component, or headless replay of a log that contains it fails with `unknown-command`.
- Command ids and argument shapes are save format (ADR 0007): renaming one or changing its args needs a `schemaVersion` bump and a log migration. `replayEntries` reports a changed args shape as `diverged`.
- F1.8b's load continues the loaded log with a cleared history; it never starts a new log or drops entries, which would break the undo argument above. That needs a small bus addition (clear the history, keep the log).
- The undo stack holds closures, so it is never persisted. A loaded session starts with an empty history, by design.
