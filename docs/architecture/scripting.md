# Scripting API and `sim-cli`

> **Status (F1.6):** `libs/domain/scripting-api` (`@controls/scripting-api`) is the typed `Game` facade over the world command bus; `feature-session`'s `Session` wraps it. The console-line parser lives in `@controls/commands` (`console/`). `apps/sim-cli` (`type:app`, `scope:headless`) runs scripts, replays and hashes headless in plain Node. The in-game console is `@controls/feature-console` ([dev console](console.md), F1.5) and the `.ctrl` container F1.8b. Decisions: [ADR 0008](../decisions/0008-console-and-scripts.md). How-to: [scripting guide](../guides/scripting.md). Gotchas: [scripting caveats](../caveats/scripting.md).

## One `Game`, every driver

The UI and scripts run identical code: `Session` is a thin Angular adapter (signals, context keys, `onCommand`) over the same `Game` a script gets, and a `Game` is a thin facade over one `CommandBus<World>`.

```mermaid
flowchart LR
    classDef later fill:#f4f4f4,stroke:#999,stroke-dasharray: 4 3;
    subgraph ui["Renderer (Angular)"]
        PAL["Palette (F1.3)"] --> SES
        KEY["Keybindings (F1.4)"] --> SES
        CON["Console (F1.5)<br/>feature-console"] --> SES
        BTN["Buttons, mouse (F1.7)"] --> SES
        SES["Session<br/>feature-session"]
    end
    subgraph node["sim-cli (plain Node)"]
        TS["TS script<br/>default (game) => …"]
        CL[".console file"]
        RP["replay / hash"]
    end
    subgraph domain["type:domain"]
        GAME["Game<br/>@controls/scripting-api"]
        RCS["runConsoleScript"]
        PARSE["parseConsoleLine, consoleArgs<br/>@controls/commands console/"]
        BUS["CommandBus&lt;World&gt;, registry"]
        SF["save-format<br/>migrate, ReplayLog"]
    end
    SES --> GAME
    CON -.->|"run &lt;file&gt;"| RCS
    TS --> GAME
    CL --> RCS
    RCS --> PARSE
    RCS --> GAME
    RP -->|"replayGame, hashWorldDocument"| SF
    RP --> GAME
    GAME --> BUS
```

## `sim-cli`

```mermaid
flowchart TB
    ARGV["sim run | replay | hash &lt;file&gt; [--seed] [--world] [--log] [--expect]"] --> CLI["runCli<br/>apps/sim-cli/src/cli.ts"]
    CLI -->|".ts .mts .js .mjs"| LOAD["loadModuleScript<br/>esbuild bundle in memory, import boundary plugin"]
    LOAD --> TMP["temp .mjs → import() → default(game)"]
    CLI -->|"other extensions"| RCS["runConsoleScript<br/>parse all lines, then exec"]
    CLI -->|"replay"| DOC["readDocument<br/>JSON, size cap, kind by content"]
    CLI -->|"hash"| DOC
    DOC -->|"replay-log"| RG["replayGame → hash"]
    DOC -->|"world"| HW["hashWorldDocument"]
    DOC -->|".ctrl"| NO["error: F1.8b"]
    TMP --> OUT["stdout: final world.hash<br/>(and --log replay log)"]
    RCS --> OUT
    RG --> OUT
    HW --> OUT
```

- **Bundle:** `apps/sim-cli/build.mjs` bundles `src/main.ts` with esbuild into `dist/apps/sim-cli/main.mjs` (ESM, Node 24, domain libs and zod inlined, esbuild external). The Nx `build` target and `pnpm sim` (via `bin/sim.mjs`) both call it.
- **No DOM:** the app's tsconfig has `lib: ["es2024"]` without `dom`, its lint tag `scope:headless` allows only `type:domain` libs and bans framework packages, and the four-surface test runs the bundle in a plain `node` child process.
- **Script imports:** an esbuild plugin allows relative files, `type:domain` aliases (from `tsconfig.base.json`) and `zod`; anything else is a build error.

## Console-line files

```mermaid
sequenceDiagram
    participant F as .console text
    participant R as runConsoleScript
    participant P as parseConsoleLine / consoleArgs
    participant G as Game (or Session)
    F->>R: text
    loop every line, before anything runs
        R->>P: line
        P-->>R: command {id, args} | query | blank | error (line, column)
    end
    R-->>F: first parse error, nothing applied
    loop each step in order
        alt query (world.hash)
            R->>G: hash()
        else command
            R->>G: exec(id, args)
            G-->>R: ok | error, stop (earlier commands stay applied)
        end
    end
```

## The four-surface scenario

`apps/sim-cli/scenarios/four-surface.ts` and `four-surface.console` express one scenario. `apps/sim-cli/src/four-surface.spec.ts` drives it through the scripting API in-process, `sim run` of each file and `sim replay` of the log the script run wrote, and pins the resulting hash. The test target depends on `build`, so it runs the real bundle, and it is part of `pnpm verify`. The palette, keybinding and mouse drivers are UI and live in `apps/game-e2e`.

**The palette scenario (F1.3).** `scenarios/palette-place-undo.console` lists, as console lines, exactly what `apps/game-e2e/src/palette.spec.ts` logs with the palette and the keyboard: place a crate, place a spool, undo. Opening the palette (`palette.open`) is unlogged UI chrome, so it appears in neither. `apps/sim-cli/src/palette-place-undo.spec.ts` runs it with `sim run` and pins `PALETTE_PLACE_UNDO_HASH`; the e2e test asserts the same literal and that its replay log has the file's command ids, so the palette path is checked against the console-line path.

**The console scenarios (F1.5).** `scenarios/console-place-undo.console` (place a crate, undo) is pinned to `CONSOLE_PLACE_UNDO_HASH` by `apps/sim-cli/src/console-place-undo.spec.ts`. `apps/game-e2e/src/console.spec.ts` types it into the in-game console, types the lines of `palette-place-undo.console` into a fresh session and asserts `PALETTE_PLACE_UNDO_HASH` (the console-versus-palette cross-check), and `run`s `four-surface.console` to `FOUR_SURFACE_HASH`. Opening the console (`console.toggle`) is unlogged UI chrome too.

## Reserved queries

`game.probe(from, to)` (P2, meter probes on the as-built circuit) and `game.tag(path)` (P10, PLC tags) are in the `Game` type now and throw `NotAvailableError` (`code: 'not-available'`). Reserving them in the type keeps the names stable and gives a script a precise error instead of `is not a function`; implementing them later only widens their return type.
