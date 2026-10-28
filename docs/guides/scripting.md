# Scripting guide: the scripting API and `sim-cli`

Controls can be driven without the UI. A **script** runs commands against a game through the same registry the palette, keybindings and console use, so it produces the same world, the same replay log and the same `world.hash`. Scripts are how scenario tests, bug-report repros and (from P13) mods drive the game.

There are two script formats:

- **TypeScript (or JavaScript) modules** that export `(game) => …`. They run in `sim-cli` (plain Node) only.
- **Console-line files** (`.console`): one console command per line, as data. They run in `sim-cli` and, from F1.5, in the in-game console with `run <file>`.

Why two: the game's renderer has a strict Content Security Policy with no `eval`, so it can never run JavaScript it didn't ship with. Console-line files are data, so they run everywhere. See [ADR 0008](../decisions/0008-console-and-scripts.md).

## Quick start

```bash
pnpm sim run apps/sim-cli/scenarios/four-surface.ts        # a TypeScript scenario; prints world.hash
pnpm sim run apps/sim-cli/scenarios/four-surface.console   # the same scenario as console lines
pnpm sim hash libs/domain/save-format/fixtures/v1/world/empty.json
pnpm sim replay libs/domain/save-format/fixtures/v1/replay-log/place-move-delete-undo.json
pnpm sim help
```

Use `pnpm --silent sim …` when piping: stdout then carries only data (hashes and your script's own output). Diagnostics go to stderr. Relative paths are resolved from the directory you run the command in.

## A worked example

Goal: place a crate and a spool, move the crate, delete it, undo the delete, save the replay log and prove a replay reaches the same hash.

### 1. Write the script

`my-scenario.ts` (anywhere in the repository; outside it, the `@controls/*` imports won't resolve):

```ts
import type { Game } from '@controls/scripting-api';

export default function myScenario(game: Game): void {
  const crate = { id: 'prop.crate', version: 1 };

  // execOrThrow stops the script on the first failure, with the typed error.
  game.execOrThrow('entity.place', { ref: crate, positionMm: { x: 100, y: 0, z: -200 } });
  game.execOrThrow('entity.place', { ref: { id: 'prop.spool', version: 1 }, positionMm: { x: 400, y: 0, z: -200 } });
  game.execOrThrow('entity.move', { id: 1, positionMm: { x: 150, y: 0, z: -200 } });
  game.execOrThrow('entity.delete', { id: 1 });
  game.execOrThrow('edit.undo'); // entity 1 comes back with the same id

  // exec returns a result instead of throwing. Failures change nothing and aren't logged.
  const result = game.exec('entity.delete', { id: 42 });
  if (!result.ok) console.log(`expected failure: ${result.error.kind} ${result.error.message}`);

  // Read-only snapshots: frozen, and never changed by later commands.
  const world = game.world();
  console.log(`entities: ${world.entities.map((e) => e.id).join(', ')}`); // entities: 1, 2
  console.log(`log: ${game.entries().length} entries`); // log: 5 entries
}
```

### 2. Run it and keep the log

```bash
pnpm --silent sim run my-scenario.ts --seed 42 --log my-scenario.replay.json
```

Output: the script's three `console.log` lines, then the final `world.hash` as the last line:

```text
expected failure: rejected No entity with id 42
entities: 1, 2
log: 5 entries
2099ec551babb486c481d9c394e9359918422e538347123eb3c0eaf7b3003145
```

`--seed` sets the seed of the empty starting world (default 0); `--world <file>` starts from a world document instead.

### 3. Replay it

```bash
pnpm --silent sim replay my-scenario.replay.json
```

This prints the same hash: the replay log holds the initial world and every successful command (`seq`, `tick`, `id`, `args`), and replaying it through a fresh bus is deterministic. Add `--expect <hash>` to any subcommand to make it fail (exit 1) when the hash differs, which is how CI-style checks are written.

### 4. The same scenario as console lines

`my-scenario.console`:

```text
# Comments start with #; blank lines are ignored.
entity.place --ref.id prop.crate --ref.version 1 --positionMm.x 100 --positionMm.y 0 --positionMm.z -200
entity.place --ref.id prop.spool --ref.version 1 --positionMm.x 400 --positionMm.y 0 --positionMm.z -200
entity.move 1 --positionMm.x 150 --positionMm.y 0 --positionMm.z -200   # 1 is the positional id
entity.delete 1
edit.undo
world.hash
```

```bash
pnpm --silent sim run my-scenario.console --seed 42
```

It prints the hash twice (the file's own `world.hash` query, then the final hash), and it equals the TypeScript run's. The whole file is checked before anything runs, so a typo is reported as `line N, column C: …` with nothing applied.

## The `Game` API

`import { createGame, replayGame, runConsoleScript } from '@controls/scripting-api'`. In `sim-cli`, the game is created for you and passed to your default export.

| Member                                    | What it does                                                                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createGame({ seed })`                    | A new game from an empty world with that seed (unsigned 32-bit).                                                                                                                                   |
| `createGame({ world })`                   | A new game from a valid current-version world document. Passing both requires `seed === world.seed`.                                                                                               |
| `exec(id, args?)`                         | Runs a command. Returns `{ ok: true, logged, entry, command }` (`entry` is `null` for unlogged UI chrome such as `palette.open`) or `{ ok: false, error }` (`unknown-command`, `invalid-args`, …). |
| `execOrThrow(id, args?)`                  | `exec`, but throws `CommandFailedError` (with `.error`) on failure and returns the logged entry (`null` for an unlogged command).                                                                  |
| `world()`                                 | The current world document, deeply frozen. Later commands produce new snapshots and never change old ones.                                                                                         |
| `hash()`                                  | `world.hash` of the current world.                                                                                                                                                                 |
| `entries()`, `replayLog()`                | The replay entries so far, and the full replay log (initial world plus entries), as saved in `replay.log`.                                                                                         |
| `canUndo()`, `canRedo()`, `contextKeys()` | History state, also the `history.canUndo` / `history.canRedo` context keys.                                                                                                                        |
| `isEnabled(id, context?)`                 | Whether a command's `when` holds, given extra UI context keys. Advisory, like `when` itself.                                                                                                       |
| `on('executed', listener)`                | Called after every successful command with `{ entry, def, previous, state }`. Returns an unsubscribe function.                                                                                     |
| `registry`                                | The command registry: every id, title, category, Zod `args` schema and `when`.                                                                                                                     |
| `probe(from, to)`                         | **Reserved for P2** (meter probes on the as-built circuit). Throws `NotAvailableError` (`code: 'not-available'`).                                                                                  |
| `tag(path)`                               | **Reserved for P10** (read a PLC tag such as `PLC1:Motor.Run`). Throws `NotAvailableError`.                                                                                                        |
| `replayGame(json)`                        | Validates and migrates a replay log, replays it and returns a game at its end that continues the same log.                                                                                         |
| `runConsoleScript(game, text)`            | Runs a console-line file against a game (or the UI's `Session`).                                                                                                                                   |
| `toConsoleScript(entries)`                | Writes replay entries as console lines, so any recorded session can be re-run from a console-line file.                                                                                            |

The commands available in P1 are `entity.place`, `entity.move`, `entity.rotate`, `entity.delete`, `edit.undo`, `edit.redo` and `view.resetLayout` (see [commands](../architecture/commands.md#world-commands)). Positions are integer millimetres and rotations integer millidegrees. View commands are logged but don't change the hash.

The UI runs the same code: `Session` in `@controls/feature-session` wraps a `Game`, so a palette or keyboard action and a script call go through the identical path.

## Console-line syntax

```text
command.id positional… --flag value --nested.flag value --boolean-flag
```

- The first word is the command id. Positional words come next and fill the command's argument keys in order (`entity.delete 3` → `{ id: 3 }`). Flags come last.
- `--a.b value` sets a nested field. A flag with no value (followed by another flag or the end of the line) means `true`.
- Words are typed by the argument schema: `12` is a number for a number field and the text `"12"` for a string field. Quote strings with spaces or that would look like something else: `"two words"`, `'it\'s'`, `"--not-a-flag"`.
- `#` starts a comment. `world.hash` prints the current hash and is never logged.

The full grammar and its rationale are in [ADR 0008](../decisions/0008-console-and-scripts.md).

## Rules for scripts

- **Imports:** relative files, the `type:domain` libs (`@controls/scripting-api`, `@controls/commands`, `@controls/world-model`, `@controls/save-format`, `@controls/units`) and `zod` only. Node built-ins, UI libs and other packages are rejected when the script is bundled. Use the `game` you're given rather than creating your own.
- **Determinism:** don't use `Math.random()`, `Date.now()`, `new Date()` or `performance.now()`. Inside `apps/sim-cli` (including `scenarios/`) lint enforces it. Need randomness? Use a fixed seed or the seeded PRNG in `@controls/world-model`.
- **No `.ctrl` yet:** `sim hash` and `sim replay` read the JSON documents (`world.json`, a level file, `replay.log`). `.ctrl` support arrives with F1.8b and uses the same commands.

## The four-surface scenario

`apps/sim-cli/scenarios/four-surface.{ts,console}` is the P1 acceptance scenario: place, move, rotate and delete with undo and redo. `apps/sim-cli/src/four-surface.spec.ts` drives it through the scripting API in-process, `sim run` of the TypeScript script, `sim run` of the console file and `sim replay` of the written log, and requires the same pinned hash from all of them. It runs in `pnpm nx test sim-cli`, which is part of `pnpm verify`. The palette and keybinding surfaces need the UI and are driven in `apps/game-e2e`, which must reach the same hash.

## Troubleshooting

| Message                                                 | Fix                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `Scripts may import only relative files, …`             | Remove the import; take what you need from `game`, or import a domain lib.                  |
| `the script must export a default function (game) => …` | Add `export default function (game: Game) { … }`.                                           |
| `line 3, column 15: Unknown argument --idd`             | A flag that isn't in the command's args. `pnpm sim run` checks the whole file first.        |
| `Invalid arguments for "entity.place": positionMm: …`   | The args failed the command's Zod schema (the same message the palette shows).              |
| `is a replay log (use "sim replay")` and the reverse    | `hash` takes a world document, `replay` a replay log.                                       |
| `.ctrl saves are not supported until F1.8b`             | Pass the world or replay-log JSON.                                                          |
| `hash mismatch: expected …`                             | The result differs from `--expect`. Replay with an older log to find the diverging command. |
