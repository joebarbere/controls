# ADR 0008: Console grammar, CodeMirror 6, and where scripts may run

**Status:** Accepted. The grammar and the script boundary landed with F1.6; the CodeMirror 6 section with F1.5.
**Date:** 2026-10-27 (Phase 1)
**Sources:** plan §4.6; [phase 1 plan](../../plans/phase-1-game-shell.md) F1.5, F1.6 and the kickoff decisions; [ADR 0006](0006-command-system.md) (commands, `when`, replay); [ADR 0007](0007-world-document-v1.md) (world document, hash, replay log)

## Context

Plan §4.6 gives the one command registry four surfaces: the palette, keybindings, the dev console and the scripting API. Two of them take text:

- the **dev console** (F1.5), where a player or developer types `entity.place --ref.id prop.crate …`;
- **scripts**, which `sim-cli` runs headless (F1.6), and which the in-game console can run with `run <file>`.

The renderer's CSP has no `unsafe-eval` (P0), so the game can never evaluate JavaScript or TypeScript. The phase-1 kickoff therefore decided that the in-game console's `run` takes console-line files only and that TypeScript scripts run in `sim-cli`. This ADR fixes the line grammar that both sides share, how a line becomes a command's arguments, which script formats run where, how `sim-cli` loads TypeScript, and what `sim replay` and `sim hash` read before the `.ctrl` container exists (F1.8b).

## Decisions

### Where the code lives

- The **line grammar** (`parseConsoleLine`), the mapping onto a command's Zod args (`consoleArgs`, `parseConsoleCommand`) and its inverse (`formatConsoleLine`) live in `@controls/commands` under `src/lib/console/`. They are framework-free, so `sim-cli`, the in-game console and any test parse lines identically.
- **Running a console-line file** (`runConsoleScript`, `toConsoleScript`) lives in `@controls/scripting-api`, next to `Game`. It needs only `registry`, `exec` and `hash`, which both a `Game` and the UI's `Session` have, so F1.5's `run <file>` can call it with the session.
- **Loading TypeScript** lives in `apps/sim-cli` only. No library can load or evaluate a script.

### Console-line grammar

A hand-written tokeniser and parser, like `when` (no `eval`, no parser generator), with errors that carry a 1-based column:

```text
line     := ws* ( command ws* )? comment?
command  := id ( ws+ ( flag | word ) )*
id       := segment ( '.' segment )*            segment := [a-z][a-zA-Z0-9]*
flag     := '--' name ( ws+ word )?             name := ident ( '.' ident )*   ident := [A-Za-z_][A-Za-z0-9_]*
word     := bare | quoted
bare     := non-space characters, not starting with a quote, '#' or '--'
quoted   := '…' or "…" with \\ \' \" escapes, followed by a space or the end of the line
comment  := '#' to the end of the line, only where a word could start
ws       := space or tab
```

- **The id** is the command id (dotted camelCase segments, the replay log's `CommandId` grammar) or a single-segment console verb (`help`, `run`, `clear`, which F1.5 handles before the registry).
- **Positional words come first, then flags.** A word after a flag is that flag's value, so `--visible foo` can't mean "flag, then positional". This keeps one parse per line without knowing the schema.
- **A bare flag means `true`.** It is bare when the next word is another flag or the line ends. `--flag true` and `--flag false` also work.
- **Dotted flag names address nested objects:** `--positionMm.x 100 --positionMm.y 0 --positionMm.z -200` builds `{ positionMm: { x: 100, y: 0, z: -200 } }`. There is no inline object or array literal. Arrays aren't in the grammar yet, because no command takes one; a later ADR adds them when one does.
- **Quotes** are single or double, with only `\\`, `\'` and `\"` escapes (the same set as `when`). A quoted word must be a whole word (`"a"b` and `a"b"` are errors), and a quoted word is always a string.
- **Numbers** are typed later, against the schema (see below). A word is a number when it matches the JSON number grammar (`-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`) and is finite; `0x10`, `01`, `+1` and `1e999` are not numbers.
- **Comments and blank lines:** `#` starts a comment where a word could start (`a#b` and `"#c"` are words). A blank or comment-only line is no command. `world.hash # check` works.
- **Limits:** a line is at most 4096 characters, and control characters other than tab are rejected. A console-line file is split on `\n` or `\r\n`, a leading BOM is dropped, and it is at most 10,000 lines.

### Mapping a line onto a command's arguments

The registry already gives every command a Zod `args` object, so the console needs no per-command syntax:

- **Flags** walk the args schema's object shape by their dotted path. A path that isn't in the shape is an error at the flag's column (`Unknown argument --idd`), not just a later Zod issue without a column. `__proto__`, `constructor` and `prototype` are never valid segments. Giving a key twice, or as both a scalar and an object, is an error.
- **Positional words** fill the shape's keys in declaration order: `entity.delete 3` is `{ id: 3 }`, and `entity.move 1 --positionMm.x …` is `{ id: 1, positionMm: … }`. A positional word can't fill an object-valued key; use dotted flags. The consequence is that **a command's args key order is part of the console grammar**: reordering keys changes what positional console lines mean (but not replay logs, which store objects).
- **Words are typed by their leaf schema** (after unwrapping optional, default, nullable and pipe wrappers): a number field needs a number word; a boolean field takes a bare flag, `true` or `false`; string, enum and string-literal fields take the word's text as written (so `--label 12` is the string `"12"`); a nullable field accepts an unquoted `null`. Leaves the mapping can't classify (unions, `unknown`) get the word's lexical type (number, `true`/`false`/`null`, else string; quoted is always a string).
- **The mapping only shapes and types.** Bounds, patterns, required fields and strictness are checked once, by `exec` parsing the args with the same schema as every other surface. So a console line, a palette form and a script call can't disagree about what's valid.
- **The inverse**, `formatConsoleLine(id, args)`, writes every argument as a sorted flag and quotes any string that would read back as something else. A fast-check property checks that formatting and then parsing gives the same args, and another that any recorded session re-run as console lines (`toConsoleScript`) reaches the same hash and the same log. F1.5 can use it for history and "copy as console line".

### Console-line files

- A console-line file is **data, not code**: one command or query per line, run with `runConsoleScript`.
- **Every line is parsed and mapped before anything runs**, so a typo on line 40 doesn't leave lines 1–39 applied. Execution then stops at the first command that fails. The commands before it stay applied and logged, exactly as if they had been typed.
- **Queries** are console words that read state and are never logged. In F1.6 there is one, `world.hash`, which prints the current hash; F1.5 adds `help`. A command registered with the same id takes precedence.
- The conventional extension is `.console`.

### Where scripts may run

| Where                                  | Console-line files | TypeScript / JavaScript modules                      |
| -------------------------------------- | ------------------ | ---------------------------------------------------- |
| In-game dev console, `run <file>`      | Yes (F1.5)         | **No.** The CSP bans eval, and it stays banned.      |
| `sim-cli run <script>` (Node, dev)     | Yes                | Yes, bundled with esbuild at run time                |
| Scenario tests (Vitest, `sim-cli`)     | Yes                | Yes                                                  |
| Mods (P13)                             | Yes                | In a sandbox (worker or QuickJS-WASM), never in Node |
| Electron main, preload or the renderer | No script loading  | No                                                   |

- **The renderer never evaluates code.** Nothing in `type:domain`, `type:feature` or the apps loads a script: `scripting-api` exposes a `Game` object, not a loader. The CSP is unchanged by F1.6.
- **TypeScript scripts run only in `sim-cli`** until the P13 mod sandbox, which gets its own ADR. A script is a module whose default export is `(game: Game) => void | Promise<void>`.

### How `sim-cli` loads a TypeScript script

- **Bundled with esbuild at run time**, in memory (`write: false`), as an ESM bundle with an inline source map, using `tsconfig.base.json` so `@controls/*` aliases resolve. The bundle is written to a fresh temp directory, imported, and the directory removed.
- **Why not Node's type stripping?** Node 24 strips types natively, but it doesn't resolve tsconfig `paths` (so `import { … } from '@controls/commands'` fails), and it rejects TypeScript that needs a transform (enums, parameter properties). Bundling also lets `sim-cli` police imports.
- **Why not `tsx` or `ts-node`?** A new dependency for what esbuild (already a devDependency, MIT, used by `apps/desktop`) does.
- **esbuild stays external to the `sim-cli` bundle** and is loaded with a dynamic `import()` only when a module script runs, so `replay`, `hash` and console-line runs don't touch it. `sim-cli` is a dev tool and isn't shipped, so this adds no runtime dependency to the game.
- **Import boundary:** an esbuild plugin lets a script import only relative files, the `type:domain` aliases (read from `tsconfig.base.json`: those whose paths point into `libs/domain/`) and `zod`. Node built-ins, framework packages and non-domain workspace libs are build errors. This mirrors the `scope:headless` lint rule on `sim-cli` itself, keeps scripts deterministic and portable to the P13 sandbox, and means a scenario that works headless can't depend on the UI.
- **Not a security boundary.** The import check catches mistakes; it is not a sandbox. A script runs in the `sim-cli` Node process with full access to Node globals such as `process`, so only run scripts you trust. Untrusted code waits for the P13 mod sandbox.
- **A script bundles its own copy** of any `@controls/*` lib it imports, so `instanceof` against errors thrown by the `game` it is given doesn't work. Check the error's `code` (or `name`) instead.
- **Determinism:** `sim-cli` and its `scenarios/` folder get the same determinism lint as `type:domain` (no `Math.random`, `Date.now`, `new Date()`, `performance`, `crypto`). An ad-hoc script outside the repo can still read the clock; its replay log stays reproducible (the log records arguments, not how they were computed), but re-running the script may not be.

### What `sim replay` and `sim hash` read

- Until F1.8b they read the JSON documents a `.ctrl` contains, validated and migrated through `@controls/save-format`:
  - `sim hash <file>` takes a **world document** (`world.json`, or a level such as `content/levels/workshop.json` in F1.9) and prints its `world.hash`;
  - `sim replay <file>` takes a **replay log** (`replay.log`, which is JSON, or any `*.json`), replays it from its `initialWorld` and prints the resulting hash.
- The document kind is taken from the content (a replay log has `initialWorld`), not the file name, and passing the wrong kind is an error naming the right subcommand.
- A `.ctrl` file is refused with a clear "not supported until F1.8b" error. **Forward-compatible shape:** F1.8b adds `.ctrl` to the same reader, where `hash` reads the archive's `world.json` and `replay` reads its `replay.log` (and can check the result against `world.json`). The subcommands, options and output don't change.
- `sim run --log <file>` writes the session's replay log in the same format, so `sim run` then `sim replay` round-trips.

### CLI conventions

- `pnpm sim <command>` runs `apps/sim-cli/bin/sim.mjs`, which rebuilds the bundle with esbuild (well under a second) and runs it; the Nx `build` target produces the same `dist/apps/sim-cli/main.mjs`. Relative paths resolve against the directory the command was typed in (`INIT_CWD`).
- **stdout is data only** (hashes, `world.hash` query output and a script's own output), so `pnpm --silent sim hash world.json` can be piped. Diagnostics go to stderr.
- **Exit codes:** 0 success, 1 failure (a document that doesn't load, a failing script, a hash mismatch), 2 usage error. `--expect <hash>` turns any subcommand into an assertion.

### CodeMirror 6 in the in-game console (F1.5)

The console lives in `@controls/feature-console` (architecture: [dev console](../architecture/console.md)). It consumes the grammar above unchanged.

**Packages.** Only `@codemirror/state` (~6.7.6) and `@codemirror/view` (~6.43.15), both MIT, plus their MIT dependencies `style-mod`, `w3c-keyname`, `crelt` and `@marijn/find-cluster-break`. No `@codemirror/language`, `commands` or `autocomplete`:

- the input is one line, so there is nothing to highlight or indent; native contenteditable editing (typing, deleting, caret movement, select-all) is enough, and the keys the console owns (Enter, ↑, ↓, Tab, Escape) are a five-entry `keymap`;
- `@codemirror/autocomplete` would pull `language` and Lezer for a popup the console doesn't need. Completion is shell-style instead (below), with the candidates in the hint line and the result announced in a polite `role="status"` region;
- the editor is loaded with a dynamic `import()` when the console first becomes available. It is a separate chunk (about 208 kB raw, 60 kB gzipped), which keeps the initial bundle under its 2 MB budget.

**CSP.** CodeMirror never evaluates code. It does inject styles: `style-mod` mounts its rules in a `<style>` element in `document.head` (it uses constructable stylesheets only inside a shadow root), and the editor sets inline `style` attributes on its own elements. Both are allowed by the existing `style-src 'self' 'unsafe-inline'`, which Angular's component styles already need, so **F1.5 doesn't change the CSP**. `apps/desktop-e2e` opens the console in Electron under the real `app://` CSP, runs a line, checks CodeMirror's styles applied and asserts no `securitypolicyviolation`. If the CSP ever drops `'unsafe-inline'` for nonces, `EditorView.cspNonce` passes the same nonce to `style-mod` (Angular has `CSP_NONCE`); the inline `style` attributes would then need `'unsafe-hashes'` or a CodeMirror without them, so check that before tightening.

**Editor setup.** A one-line document (a transaction filter turns pasted line breaks into spaces), the console's keymap, an error-mark field, a theme on the design tokens, and content attributes: `role="textbox"` (CodeMirror's), `aria-label="Console input"`, `aria-multiline="false"`, `aria-describedby` the hint line and a live `aria-invalid`. CodeMirror's base theme removes the outline from `.cm-content`, so the console theme restores the global 2 px focus outline on `.cm-content:focus-visible`. The keybinding service already treats `.cm-editor` as a typing target, so only global bindings fire inside it.

**Completion.** Tab completes the word before the cursor, read from the registry: command ids plus the console words for the first word (and after `help`), flag names after `-` (from `consoleFields(def.args)`, the same walk over the args shape `consoleArgs` uses, minus flags already given), and the values of enum, literal and boolean fields after their flag or in their positional slot. One candidate is inserted with a space; several extend to their common prefix, and when that adds nothing, Tab cycles through them, with the list in the hint line. Inside a quote, a comment, a free-text value or an unknown command there is nothing to complete. **On an empty line Tab moves focus on**, so the input never traps the keyboard; Shift+Tab is never captured.

**Errors at a column.** `resolveConsoleLine` returns the `ConsoleError` from `parseConsoleLine` or `parseConsoleCommand` unchanged. The console keeps the line, underlines the word starting at that column (a CodeMirror mark decoration), puts the caret there, sets `aria-invalid="true"`, and shows `Column N: message` in the hint line and in the output log (with the line and a caret under the column). The mark clears on the next edit. Errors from `exec` (bounds, refusals) are shown with `describeExecError`.

**History.** Every submitted, non-blank line goes to settings `console.history` (oldest first), including lines with errors so they can be fixed. `appendHistory` writes within the schema's caps (200 lines of at most 2,000 characters, well-formed strings, no repeat of the newest), because one over-cap value makes the whole settings file fall back. A line longer than 2,000 characters still runs (the parser allows 4,096) but isn't kept. ↑ and ↓ walk it like a shell and give back the draft past the newest line.

**Console words.** `help`, `run` and `clear` are handled before the registry; `world.hash` is the shared query from `CONSOLE_QUERIES`, and a registered command with that id would win. None is logged.

- `help` lists every registered command (id, title, its keys from the keybinding service, a cheat marker) and the console words. `help <id>` shows a command's title and category, a usage line, each flag with its type (number bounds, enum values, `true|false`), whether it is optional and its positional slot, its keys, `when`, whether it is undoable and whether it is a cheat. All of it is generated from the `CommandDef` and its args schema.
- `run` takes no argument. It opens a file picker (or the player drops a file on the console, or uses the Run file button). The renderer can't open file paths until save I/O (F1.8b), so `run <path>` is an error that says so; the file input works the same in the web harness and in Electron's sandboxed renderer, which shows the native dialog. The file (at most 1 MiB) is read as text and run with `runConsoleScript`. Console words other than `world.hash` aren't valid in a file.
- `clear` empties the output.

**Cheats.** Before a `cheat: true` command runs in a world that isn't assisted yet, the console holds it and shows a warning banner (`role="alert"`): running it marks the save as assisted, permanently. Enter on the unchanged line or Run cheat confirms; Escape, Cancel or another line drops it, and nothing runs or is logged. A console-line file that contains a cheat is checked the same way before any of it runs. Once the world is assisted there is nothing left to warn about, so cheats run directly. The assisted flag itself is set by the bus (ADR 0006).

**Toggle and gating.** `console.toggle` is a view command (no world change, and not in the replay log: UI-chrome toggles use `logged: false`, the rule F1.3 introduces for `palette.open`) with the default key `Backquote`, `globalKeybinding: true` and `when: console.available`. Because it is global, backtick closes the console from inside its own input, as in most games' consoles; the cost is that a literal backtick can't be typed there (no part of the grammar needs one, and rebinding the toggle frees the key). The `console.available` context key is true in a Sandbox or a dev build while the workspace is on screen; elsewhere the backtick does nothing and the console shows a note instead of the input.

## Consequences

- One parser for every text surface: the in-game console, console-line files and `sim-cli` accept the same lines, and a test checks a session recorded through the scripting API re-runs as console lines to the same hash.
- Command authors control console ergonomics through the args schema: key order sets positional order, and dotted flags follow nesting. Reordering an args object's keys is a console-grammar change, worth a CHANGELOG line.
- Arrays have no console syntax yet. The first command that takes an array must extend the grammar here.
- `sim-cli` depends on esbuild at run time for TypeScript scripts only. If esbuild ever leaves the workspace, console-line files, `replay` and `hash` keep working, and module scripts need another loader.
- The CSP and the renderer are untouched: scripting adds no eval path to the game.
