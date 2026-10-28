# commands (`@controls/commands`)

Framework-free domain library (`type:domain`): the command registry, bus, undo/redo and replay behind the palette, keybindings, console and scripting API (plan §4.6, F1.2). It is generic over its state; `@controls/world-model` instantiates it for the world document. Semantics: [ADR 0006](../../../docs/decisions/0006-command-system.md).

- **`CommandDef<A, S>`:** `id`, `title`, `category`, Zod `args`, `when`, `keybinding`, `undoable`, `cheat`, `run(ctx, args)`. `run` is pure and returns `succeed(change)`, `succeed()` or `fail(code, message)`; a change is an `apply`/`invert` pair.
- **`CommandRegistry`:** rejects malformed ids (the replay-log `CommandId` grammar), duplicates and malformed `when` with a `CommandRegistrationError`. `isEnabled(id, context)` evaluates `when` for surfaces.
- **`CommandBus`:** `exec(id, args)` parses args, runs, commits and logs, or returns a typed `ExecError` and changes nothing. Undo/redo stacks, `subscribe`, `entries`, `contextKeys()`.
- **Built-ins:** `edit.undo`, `edit.redo` (`editCommands()`), and view commands (`defineViewCommand`, `view.resetLayout`).
- **`when`:** `parseWhen` / `evaluateWhen`, a hand-written parser (no `eval`).
- **`replayEntries(bus, entries)`:** re-runs a log and checks seq, tick and args.
- **Console lines (`console/`, F1.6, [ADR 0008](../../../docs/decisions/0008-console-and-scripts.md)):** `parseConsoleLine` (the `verb.noun --flag value` grammar, errors with a column), `consoleArgs` / `parseConsoleCommand` (map a line onto a command's Zod args: dotted flags, positional keys in order, words typed by the leaf schema) and `formatConsoleLine` (the inverse). Shared by `sim-cli` and the in-game console (F1.5).

Tests: `pnpm nx test commands` (90 % coverage gate).
