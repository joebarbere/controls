# Architecture overview

> **This page shows the target architecture** from [`controls-development-plan.md`](../../controls-development-plan.md) §4. Most of it doesn't exist yet.
>
> **P0 implements:** `apps/desktop` (Electron main + preload, `app://` protocol, one IPC channel `app:info`, updater wiring), `apps/game` (Angular 22 zoneless shell with an about box and the viewport), `apps/game-e2e` (Playwright against the web harness) and `apps/desktop-e2e` (Playwright `_electron`, or a CDP attach to a packaged binary), `libs/domain/units` (`@controls/units`, so far only the generated `lib/version.ts`), `libs/ipc-contract` (`@controls/ipc-contract`, plus the narrow `@controls/ipc-contract/preload` entry), `libs/rendering/renderer` (`@controls/renderer`, sub-panel + two DIN rails) and `libs/platform/api|electron|web`. There is **no** sim worker, PLC worker, command registry or save format yet.
>
> Items marked _(PN)_ below arrive in that phase.

## Process and thread model

```mermaid
flowchart TB
    subgraph main["Electron main process (Node)"]
        PROTO["app:// protocol handler<br/>COOP/COEP + CSP headers"]
        IPCH["IPC handlers<br/>Zod-validated, senderFrame checked"]
        UPD["electron-updater<br/>packaged only, not macOS while unsigned"]
        FILE["Atomic file I/O (P1)<br/>temp file + rename"]
        NET["Optional Modbus/OPC UA server (P12)<br/>utilityProcess, 127.0.0.1, opt-in"]
    end

    subgraph renderer["Renderer process (sandboxed, crossOriginIsolated)"]
        NG["Angular 22 zoneless UI<br/>HUD, menus, docked editors"]
        THREE["Three.js r186 viewport<br/>WebGPU, WebGL2 fallback, 60 fps"]
    end

    subgraph simw["Sim worker (P2)"]
        LOOP["Fixed-step loop, 1 kHz sim time"]
        DISC["Discrete layer: relay/contactor state machines"]
        CONT["Continuous layer: thermal, motor mechanics, process"]
        PROT["Protection layer: breaker/fuse/overload/GFCI integrators"]
        ELEC["Electrical layer: DC + 60 Hz phasor MNA<br/>on topology change + every 10-20 ms"]
        LOOP --> DISC --> CONT --> PROT --> ELEC
    end

    PLC["PLC worker(s) (P10)<br/>one per PLC, scan on sim ticks"]

    PRE["Preload: narrow typed bridge<br/>(contextBridge)"]
    NG <-->|"invoke / handle"| PRE
    PRE <--> IPCH
    PROTO -->|"serves Angular build"| renderer
    NG -->|"Commands to ring buffer"| simw
    simw -->|"SharedArrayBuffer snapshots<br/>(double-buffered, seq counter)"| THREE
    simw -->|"snapshots"| NG
    PLC <-->|"tag memory (SAB)"| simw
```

- `SharedArrayBuffer` needs `crossOriginIsolated`, which is why content is served from `app://` (not `file://`) with COOP/COEP headers. A `postMessage` snapshot path is kept as a fallback and for the web harness.
- **Determinism** _(P2)_: sim time is an integer tick count, all randomness comes from a seeded PRNG, and the seed plus the command log reproduces a session.
- The UI never mutates the world directly. Every change is a registered Command _(P1)_.

## Module boundaries

Nx project tags, enforced by `@nx/enforce-module-boundaries` in the root ESLint config. The authoritative `depConstraints` live in `eslint.config.mjs`; this diagram shows the intent from plan §4.2. Green boxes exist in P0, and the edges between them are the imports P0 actually has. `REND --> UNITS` is intended: the renderer still uses its own `mm()` helper. E2E projects (`type:e2e`) may import no workspace libs, so they aren't drawn.

```mermaid
flowchart LR
    classDef p0 fill:#dff5e1,stroke:#2e7d32;
    classDef later fill:#f4f4f4,stroke:#999,stroke-dasharray: 4 3;

    subgraph apps["type:app"]
        GAME["apps/game"]:::p0
        DESK["apps/desktop"]:::p0
        SIMCLI["apps/sim-cli (P1)"]:::later
    end

    FEAT["libs/features/* (P1)<br/>type:feature"]:::later
    UI["libs/ui (P1)<br/>type:ui"]:::later
    REND["libs/rendering/renderer<br/>type:rendering"]:::p0
    PAPI["libs/platform/api<br/>type:platform"]:::p0
    PEL["libs/platform/electron<br/>type:platform"]:::p0
    PWEB["libs/platform/web<br/>type:platform"]:::p0
    IPC["libs/ipc-contract<br/>type:contract"]:::p0
    UNITS["libs/domain/units<br/>type:domain"]:::p0
    DOM["libs/domain/* (P1+)<br/>world-model, commands, save-format, sim-core…"]:::later
    WORKER["libs/sim-worker (P2)"]:::later

    GAME --> FEAT & UI & REND & PAPI & PEL & PWEB
    DESK --> IPC
    SIMCLI --> DOM
    FEAT --> DOM & REND & UI & PAPI
    REND --> UNITS & DOM
    PAPI --> IPC
    PEL --> PAPI & IPC
    PWEB --> PAPI & IPC & UNITS
    WORKER --> DOM
    DOM --> UNITS
```

**Rules** (plan §4.2):

- `type:domain` is pure TypeScript (no Angular, DOM or Electron) and depends only on other domain libs. That's what lets `sim-cli` run the game headless.
- `sim-worker` depends on domain libs only.
- `type:rendering` depends on `world-model`, `catalog` and `units`, plus read-only snapshot types from `sim-worker`. It is framework-free.
- `type:feature` may depend on domain, rendering, ui and `platform/api`, **never** on a concrete platform implementation.
- `type:app` projects assemble features and inject a platform implementation (`platform-electron` inside Electron, `platform-web` in the browser harness).
- `type:contract` (`ipc-contract`) is shared by the Electron main process, the preload and the platform libs, so the bridge has one source of truth. The preload imports only `@controls/ipc-contract/preload` (channel names and the bridge type, no Zod) to stay tiny. Main validates each response with Zod, and `platform-electron` validates it again in the renderer.

## Desktop packaging (P0)

```mermaid
flowchart LR
    NGB["nx build game<br/>dist/apps/game/browser"] -->|"copied to renderer/"| DIST["dist/apps/desktop<br/>apps/desktop/build.mjs"]
    ESB["esbuild<br/>main.cjs + preload.cjs, all deps bundled"] --> DIST
    PKG["apps/desktop/package.json<br/>(version written by version:sync)"] --> DIST
    DIST --> EB["electron-builder<br/>apps/desktop/electron-builder.config.cjs"]
    EB --> OUT["dist/release/<br/>NSIS · dmg/zip · AppImage/deb/rpm<br/>+ latest*.yml"]
```

The packaged app directory has **no `node_modules`**: every main-process dependency is bundled by esbuild. See [electron caveats](../caveats/electron.md) and [release caveats](../caveats/release.md).

## Related

- [ADR 0001 Stack](../decisions/0001-stack.md) · [ADR 0002 Simulation architecture](../decisions/0002-simulation-architecture.md)
- Research: [tech stack](../research/2026-10-tech-stack.md), [circuit simulation](../research/2026-10-circuit-simulation.md)
