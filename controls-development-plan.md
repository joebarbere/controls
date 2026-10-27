# Controls — Development Plan

> **Status:** Plan v1.2 (2026-10-27). Phase 1 underway. v1.1 corrected toolchain facts found during F0.1 (TS 6.0, Vitest 4.1, pnpm 11, e2e split); v1.2 records the P1 kickoff decisions (Node follows Electron's embedded Node, Vitest 4.1 kept by choice, F1.8 split, in-game `run` takes console-line files only).
> **This document is the spec.** If a request conflicts with it, raise the conflict instead of quietly deviating. Change the plan first, then the code.
> The supporting research (licences, versions, solver design, domain figures) is in [`docs/research/`](docs/research/). Every version number below was checked on 2026-10-26. `release-engineer` re-checks them at the start of Phase 0.

---

## 1. Vision

**Controls** is a cross-platform desktop simulation game about the electrical trade, from apprentice electrician to controls engineer. The player does the physical work in a 3D world: mounting devices, pulling and terminating wire, probing with meters, locking out equipment. The engineering work happens in docked 2D editors: reading prints, programming ladder logic, building HMI screens. One physically grounded circuit simulator runs underneath both.

### Pillars

1. **The simulator runs what is wired, not what is drawn.** The circuit model is compiled from the physical wiring. Prints (schematics) are a separate document that can be wrong, which is how real brownfield jobs work.
2. **Meters tell the truth.** Every reading comes from the solver: voltage under load, ghost voltage on a high-impedance meter, current imbalance on a single-phased motor. The player must be able to diagnose every fault with instruments, with no X-ray view at Realistic difficulty.
3. **One layer from wire to logic.** The same game covers wiring a PNP sensor into a sinking input card and then writing the ladder logic that fails because of it. No surveyed product combines the physical layer with the logic layer (see research: domain-realism, Part A).
4. **Safety is a mechanic, not a cutscene.** Test-before-touch, LOTO, PPE and arc-flash boundaries are things the player does. Consequences are non-graphic and scale with difficulty.
5. **Realistic within reason.** We simulate what a tradesperson can observe or measure, and abstract what they can't (see §3).

### Decisions so far (Q&A, 2026-10-26)

| Topic       | Decision                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name / repo | **controls**, at `~/dev/github/joebarbere/controls`                                                                                                                                   |
| Structure   | **Career + Sandbox**. Career is apprentice → journeyman → controls technician → controls engineer, built from work orders. Sandbox unlocks every part. One simulator underneath both. |
| Code region | **NEC/US first** (120/240 split-phase, 208Y/120, 480Y/277, AWG, NEMA, ANSI/JIC symbols). The data model is region-agnostic so an **IEC profile** can follow after 1.0.                |
| Perspective | **Hybrid**: a 3D world (first-person walk plus a focused "work mode" orbit camera) and docked 2D editors (prints, ladder/ST, HMI).                                                    |
| "Commands"  | **Command palette + rebindable keybinds**, **dev/debug console**, **scripting/automation API**. All three sit on one command registry (§4.6).                                         |
| Safety      | **Realistic, scaled by difficulty.** Presets run from Trainee (hints, no injury) to Realistic (no hints, injuries, licence strikes).                                                  |
| Licence     | **MIT**, distributed on **GitHub Releases** with auto-update. GPL/AGPL projects are reference-only (§5).                                                                              |
| Platform    | **Electron** desktop app (Windows, macOS, Linux), **TypeScript + Angular + Three.js**.                                                                                                |

---

## 2. Scope by phase (summary)

| Phase | Theme                                                                                                  | Release    |
| ----- | ------------------------------------------------------------------------------------------------------ | ---------- |
| P0    | Foundation: workspace, Electron shell, CI, release pipeline, docs, Claude agents                       | v0.1.0     |
| P1    | Game shell: UI, **commands**, cameras, interaction, save/load                                          | v0.2.0     |
| P2    | Circuit engine and **power sources** (headless solver in a worker)                                     | v0.3.0     |
| P3    | **Wires**, terminations, enclosures and hand **tools**                                                 | v0.4.0     |
| P4    | **Lights**, switches, receptacles, panels, overcurrent protection, grounding: _first playable sandbox_ | v0.5.0     |
| P5    | Test instruments, safety systems, fault injection, **Apprentice career**                               | v0.6.0     |
| P6    | Three-phase distribution, control circuits, **relays**, **timers**, prints                             | v0.7.0     |
| P7    | **Contactors**, **overloads**, **motors**, starters; Journeyman career, part 1                         | v0.8.0     |
| P8    | **Pumps**, **actuators**, process simulation; Journeyman career, part 2                                | v0.9.0     |
| P9    | **Sensors** and instrumentation (discrete and 4-20 mA)                                                 | v0.10.0    |
| P10   | **PLC I**: hardware, runtime, ladder editor; Controls Technician career                                | v0.11.0    |
| P11   | **PLC II**: Structured Text, FBD, analog/PID, basic VFD                                                | v0.12.0    |
| P12   | Industrial networking, **SCADA/HMI** builder, alarms, trends; Controls Engineer career                 | v0.13.0    |
| P13   | Campaign completion, polish, signing, modding v1                                                       | **v1.0.0** |

**Changes from the requested order, and why.** Timers moved up into P6 next to relays, because a timer relay is just a relay with a delay and the first useful control circuits (star-delta, sequencing) need one. Relays and contactors come _before_ motors, because a motor with no starter only gives you a switch to play with. Pumps and actuators (P8) come before the full sensor catalogue (P9). P8 still includes the float and pressure switches a pump needs. P9 then has real machines to sense. Everything else follows the requested order: basics first, then motors → … → PLC → SCADA.

---

## 3. Realism charter

These rules decide simulate-vs-abstract questions. `electrical-realism-reviewer` enforces them (§10).

1. **Simulate what can be measured or observed.** Voltage, current, resistance, insulation resistance, phase rotation, temperature, sound (hum, buzz, chatter), light output, motor speed and direction, and trip timing are all real solver outputs.
2. **Abstract what can't, or what isn't fun.** Exact torque in in-lb becomes a green-zone dial. Fish-tape pulls become a short minigame. IEEE 1584 incident-energy maths becomes printed arc-flash labels. AFCI arc-signature detection becomes a probabilistic trip. PWM harmonics are skipped.
3. **Numbers need a source.** Every ratings or physics constant in `content/` has a `source` field: a manufacturer datasheet, physics derivation, or public reference. We do **not** reproduce NFPA/NEC text or tables verbatim, because they are copyrighted. Where possible, conductor resistance is computed from resistivity × length ÷ area with a temperature coefficient. Ampacity and trip curves come from published manufacturer data or are derived. Inspector rules paraphrase requirements and cite the article number.
4. **Tolerances are real, and seeded.** Each device instance draws its trip point, pickup voltage and similar values from a realistic band using the world seed, so replays stay deterministic.
5. **Faults have signatures.** Every fault type in the library has at least one measurable signature (see `domain-realism` Part B, Tier 3). A fault you can't find with instruments isn't allowed.
6. **Vendors are fictional.** Device brands, PLC families and model numbers are invented. Instruction mnemonics can follow industry conventions (XIC/OTE/TON, IEC names), but there's no vendor trade dress.
7. **No graphic injury.** Shock and arc flash produce injury states, a medical-leave timer, reputation loss and licence strikes, never gore.

---

## 4. Architecture

### 4.1 Stack (versions verified 2026-10-26; see `docs/research/2026-10-tech-stack.md`)

| Concern                           | Choice                                                                                                                                                                        | Notes                                                                                                                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Desktop shell                     | **Electron 45** (Chromium 156, Node 24)                                                                                                                                       | Main and preload bundled with esbuild. Custom `app://` protocol, not `file://`.                                                                                                                                    |
| UI                                | **Angular 22**, standalone, **zoneless**, signals, `@angular/build` (esbuild/Vite)                                                                                            | The HUD and panels read signals that the sim updates at about 10–30 Hz, not once per frame.                                                                                                                        |
| 3D                                | **Three.js r186**, plain imperative (no angular-three)                                                                                                                        | `WebGPURenderer` with automatic WebGL2 fallback. Detect `navigator.gpu`, because Linux WebGPU depends on drivers. angular-three is ruled out because its peer dependencies stop at Angular < 22 and three < 0.183. |
| Picking                           | three-mesh-bvh 0.9.x, with GPU ID-buffer picking later for dense panels                                                                                                       |                                                                                                                                                                                                                    |
| Cables                            | Custom Verlet/PBD rope, baked to static tubes once settled                                                                                                                    | Rapier (`@dimforge/rapier3d-compat`) only if rigid-body props need it                                                                                                                                              |
| Language                          | TypeScript, `strict`                                                                                                                                                          | **TypeScript 6.0.x** — Angular 22 requires `>=6.0 <6.1`, so TS 7 / `tsgo` is not used (resolved in F0.1, ADR 0001). `baseUrl` is deprecated in TS 6; paths are root-relative.                                      |
| Workspace                         | **Nx 24 + pnpm 11**, integrated `tsconfig.base.json` paths (Nx's Angular plugin rejects TS project references)                                                                | Module boundaries enforced with tags (§4.2)                                                                                                                                                                        |
| Schemas                           | **Zod 4**, source of truth, with JSON Schema exported for docs and mods                                                                                                       | Saves, catalogue, IPC payloads, command arguments                                                                                                                                                                  |
| Tests                             | **Vitest 4.1** (unit/integration; Angular 22.2 also accepts `^5`, but 4.1 is kept through P1), **fast-check** (property tests), **Playwright 1.64** `_electron` (E2E)         | §8                                                                                                                                                                                                                 |
| Packaging                         | **electron-builder 26** + **electron-updater** via GitHub Releases                                                                                                            | NSIS (Windows), dmg/zip universal (macOS), AppImage + deb + rpm (Linux). Flatpak later.                                                                                                                            |
| Runtime Node                      | Node 24 LTS (`.nvmrc`); move when Electron's embedded Node moves (Electron 45–47 embed Node 24)                                                                               |                                                                                                                                                                                                                    |
| Other libraries (all MIT/BSD/ISC) | fflate (ZIP), uPlot (trends), CodeMirror 6 (ST editor and console), dockview or custom split panes (docking; evaluate in P1), modbus-serial (ISC) and node-opcua (MIT) in P12 |                                                                                                                                                                                                                    |

**State management.** Authoritative game state lives in the **world document** (persistent) and the **sim worker** (live). Angular state is UI-only: signal services, or NgRx SignalStore if it gets complex. The UI **never** changes the world directly. Every change is a Command (§4.6).

### 4.2 Repository layout and module boundaries

```
controls/
  apps/
    desktop/            # Electron main + preload: app:// protocol (COOP/COEP), IPC handlers, updater, fuses, file I/O
    game/               # Angular 22 app: shell, menus, HUD, docked panels, editors
    game-e2e/           # Playwright against the browser dev harness
    desktop-e2e/        # Playwright _electron smoke (dev app) / CDP attach (packaged, fused binary)
    sim-cli/            # Headless Node runner: scenario tests, replays, scripting API, CI oracle checks
  libs/
    domain/             # FRAMEWORK-FREE (no Angular, DOM, Electron)
      units/            #   SI quantities, AWG↔mm², display conversion, region profiles
      world-model/      #   physical model: entities, devices, terminals, wires, routes, enclosures
      catalog/          #   device-definition types + loader + validation (data lives in content/)
      commands/         #   command registry, bus, undo/redo, replay log
      save-format/      #   Zod schemas, migrations, ZIP container, fixtures
      sim-core/         #   netlist compiler, MNA solvers, device models, protection, thermal, process, PLC VM
      plc/              #   program model, IR, ladder/ST/FBD compilers, PLCopen XML import/export (P10+)
      hmi-model/        #   HMI screen documents, tag bindings, alarm model (P12)
      career/           #   work orders, objectives, scoring, progression, fault-injection specs
      scripting-api/    #   typed public API over commands + sim queries (used by console, tests, mods)
    sim-worker/         # worker entry, SharedArrayBuffer layout, typed message protocol
    rendering/
      renderer/         # Three.js scene, loaders, procedural device geometry, cables, picking, cameras, audio
    platform/
      api/              # FileService, DialogService, SettingsService, UpdateService interfaces
      electron/         # IPC-backed implementations
      web/              # browser dev-harness implementations (fast iteration + Playwright without packaging)
    ui/                 # Angular presentational components (design system, panels, widgets)
    features/           # Angular feature libs: workspace, palette, console, inventory, prints-editor,
                        #   ladder-editor, hmi-editor, career, settings, meter-hud …
    ipc-contract/       # shared Zod schemas + types for the preload bridge
  content/              # data-only: device catalog JSON, wire tables, curves, jobs, faults (mod-pack format)
  tools/                # scripts: version sync check, catalog validation, asset gen, release helpers
  docs/                 # see §9 / CLAUDE.md documentation discipline
  plans/                # per-phase implementation plans (written at the start of each phase)
  .claude/              # agents, skills, settings (§10)
```

**Boundary rules** (Nx `enforce-module-boundaries`):

- `domain/*` is pure TypeScript and depends only on other `domain/*` libs. That's what lets `sim-cli` run the whole game headless.
- `sim-worker` depends on `domain/*` only.
- `rendering/*` depends on `domain/world-model`, `domain/catalog` and `domain/units`, plus read-only snapshot types from `sim-worker`.
- `features/*` may depend on `domain/*`, `rendering/*`, `ui` and `platform/api`. They never depend on a concrete platform.
- `apps/*` assemble the features and inject a platform implementation.

### 4.3 Process and thread model

```
Electron main ── file I/O (atomic save), updater, settings, optional real Modbus/OPC UA server (P12, utilityProcess)
   │ typed, Zod-validated IPC (contextBridge)
Renderer (Angular + Three.js, 60 fps)
   │ commands → command ring buffer          ▲ SharedArrayBuffer snapshots (double-buffered, seq counter)
Sim Worker ── fixed-step loop @ 1 kHz sim time
   ├─ discrete layer   (relay/contactor state machines, event queue)         every tick
   ├─ continuous layer (thermal, motor mechanics, process fluid/pneumatic)   every tick
   ├─ protection layer (breaker/fuse/overload/GFCI integrators)              every tick
   └─ electrical layer (DC + 60 Hz phasor MNA)                               on topology change + every 10–20 ms
PLC Worker(s) ── one per PLC (P10). Scan cycle advanced by sim-clock ticks, tag memory in its own SAB
```

- `SharedArrayBuffer` needs `crossOriginIsolated`, so the `app://` handler sends COOP/COEP headers. A `postMessage` snapshot path is kept as a fallback and for the web harness.
- **Determinism.** Sim time is an integer tick count. All randomness comes from a seeded PRNG. The command log plus the seed reproduces any session exactly. This is what powers replays, bug reports and scenario tests.
- **Time control.** Pause, step, 1×, 10× and 60× (for thermal and process waits). The PLC follows the sim clock, so 10× runs ten times the scans.

### 4.4 World model: physical, electrical, documentation

There are three related but separate models:

1. **Physical (as-built)** in `world-model`. This is the authoritative world: placed entities (device instances by catalogue reference), terminals, conductors with routes (waypoints, length, gauge, insulation, colour, label), terminations (quality: strip length, torque, ferrule, conductor count), enclosures, raceways, environment (wet or dry, ambient temperature).
2. **Electrical (derived)** in `sim-core`. The **netlist compiler** turns the physical model into nodes and branches. It union-finds terminals joined by conductors and closed contacts, and turns every conductor into an impedance stamp: R from material, area, length and temperature, plus a contact resistance for each termination. It recompiles incrementally on edits or device state changes and caches factorisations by topology hash.
3. **Documentation (prints)** in `world-model/prints`. Ladder diagrams, wiring diagrams, panel layouts and the panel directory. In career jobs they're handed to the player and may be wrong ("as-built differs from print" is a fault type). In the sandbox the player can draw them or auto-generate an as-built print.

**Canonical units.** Geometry is stored as integer **millimetres**, in a right-handed coordinate system with +y up. Electrical values use SI floats (V, A, Ω, W, s, °C). AWG and inches are display-only and switched by the region profile.

### 4.5 Simulation engine (`sim-core`)

The design follows `docs/research/2026-10-circuit-simulation.md`. It reimplements, and never copies, the CircuitJS1 approach, plus the equations from the Modelica Standard Library (BSD) and OpenDSS (BSD).

- **Electrical layer: quasi-static MNA.**
  - DC islands use real-valued MNA. AC islands use **complex phasor MNA at 60 Hz** (50 Hz in the IEC profile).
  - There is one unknown per _conductor node_: L1, L2, L3, N and PE are separate. That gives unbalance, open neutrals, single-phasing and ground faults for free.
  - Closed switches are merged with union-find before assembly, so tiny resistances never wreck the matrix conditioning. A `gmin` from every node to ground handles islanded sections.
  - Dense LU below about 300 unknowns, sparse Gilbert–Peierls LU (CSC + AMD ordering) above. The MIT spice-ts and brownout code can be adapted with attribution.
  - Nonlinear loads use a warm-started outer loop: constant-power loads (`Y = conj(S)/|V|²`), lamp filament R(T) and motor slip.
- **Discrete layer.**
  - Relay and contactor state machines: `OPEN → PICKING → CLOSED → DROPPING`. Pickup is at least 85 % and dropout at most 60 % of the rated coil voltage, with realistic operate times, optional bounce, and mechanically linked contact sets.
  - Each tick iterates to a fixed point, capped at about 20 passes. If it doesn't settle, it reports a race or oscillation.
  - A wrong coil voltage leads to coil burnout (overvoltage) or chatter (undervoltage).
- **Continuous layer.**
  - Conductor and termination I²R heating against thermal mass, leading to insulation damage events.
  - Induction motors use the Steinmetz per-phase equivalent circuit with `J·dω/dt = Te(s,V) − T_load(ω)`. Inrush (about 6–8× FLA at s = 1), voltage-sag stall and single-phasing all _emerge_ from the model.
  - Process models (P8): tanks, pump and system curves, pneumatics.
- **Protection layer.**
  - Breakers: thermal state `dθ/dt = ((I/In)² − θ)/τ` plus a seeded magnetic band.
  - Fuses: melting-curve interpolation or I²t.
  - Overload relays: Class 10/20/30 with thermal memory and phase-loss sensitivity.
  - GFCI: residual current above 5 mA trips in under 25 ms (30 mA in the IEC profile).
  - A trip changes the topology and forces a re-solve.
- **Faults are stamps**: bolted short (about 1 mΩ), arcing fault (0.5–2 Ω, nonlinear), ground fault, open, high-resistance joint, lost neutral, open ground (which leaves the chassis floating at line voltage, so a shock hazard).
- **Instruments are devices too.** A DMM in V mode stamps a 10 MΩ input impedance, which produces ghost voltage. LoZ mode stamps about 3 kΩ. A clamp meter reads the vector sum of the branch currents it encloses.
- **Optional "scope bench" (post-P11):** a true transient simulation of a small isolated subcircuit using @spice-ts/core (MIT) for waveform lessons. It never runs in the main loop.
- **Performance budget:** a 2,000-node plant re-solves in under 2 ms after a topology change, and the per-tick discrete + continuous + protection work stays under 0.3 ms. `sim-cli bench` enforces both in CI.

### 4.6 Command system: one registry, four surfaces

Every change to the world and every UI action is a registered **Command**:

```ts
interface CommandDef<A> {
  id: string; // 'wire.connect', 'device.place', 'sim.setSpeed', 'view.focusPanel'
  title: string;
  category: string;
  args: z.ZodType<A>; // validates palette forms, console flags, script calls alike
  when?: ContextExpr; // 'mode == work && selection.kind == terminal'
  keybinding?: string; // default; user-rebindable
  undoable: boolean; // world mutations: apply/invert pair
  cheat?: boolean; // marks run "assisted" → disables career scoring/achievements
  run(ctx: CommandContext, args: A): CommandResult;
}
```

The four surfaces all use that registry:

1. **Command palette** (Ctrl+K or Ctrl+Shift+P). Fuzzy search, argument forms generated from the Zod schemas, recent commands.
2. **Keybinding service.** Rebindable, context-aware (`when`), detects conflicts, saved to settings. Tool belt slots 1–9.
3. **Dev/debug console** (the backtick key) with `verb.noun --flag value` syntax, tab-complete from the registry, and history. It's enabled in Sandbox and dev builds. Debug commands include `fault.inject`, `sim.speed 10`, `sim.step 50ms`, `netlist.dump`, `spawn contactor.nema-size1`, `tp panel-3`, `xray on`. Cheat commands mark the save as _assisted_.
4. **Scripting API** (`domain/scripting-api`). A typed `game.exec(id, args)` plus sim queries (`game.probe(a, b)`, `game.tag('PLC1:Motor.Run')`) and event subscriptions. It's used by `sim-cli` scenario tests, the console's `run` (console-line files only in the renderer, because the CSP bans eval; TypeScript scripts run in `sim-cli`), and (P13) sandboxed mods running in a worker or QuickJS-WASM, never in Node.

Every executed command is appended to the **replay log** (command id, args, sim tick). Together with the seed, that gives undo/redo, replays, bug-report repros and headless tests.

### 4.7 Content and device catalogue

A device definition is data in `content/devices/*.json`, validated by Zod:

- identity: id, version, fictional brand and model;
- category and the regions it applies to;
- **terminals**: id, label (A1/A2, 13/14, L1/T1, X1:3), position on the model, maximum conductors, gauge range, termination type;
- **electrical model**: a reference to a sim-core model kind plus its parameters (coil voltage and VA, contact ratings, curve tables, motor nameplate, sensor type);
- mechanical and visual data: a procedural-geometry recipe or a glTF reference, DIN width, label positions;
- `source` citations.

This is also the **mod-pack format** (finalised in P13). Wire, conduit and curve tables live in `content/tables/` with their sources.

**Geometry strategy.** Most electrical devices are boxes, cylinders, labels and terminals, so they're built **procedurally** from parametric recipes (DIN modules, contactors, terminal blocks, boxes, panels). That keeps asset cost low and the look consistent. Hero assets such as motors, pumps, meters and the PLC chassis are Blender-made glTF or CC0. Textures and labels are generated (see aquascape's `tools/generate-textures.mjs` for the pattern).

### 4.8 Save format (`.ctrl`)

The format is a ZIP containing `world.json`, `prints/*.json`, `plc/*.json`, `hmi/*.json`, `replay.log` (optional), `thumbnail.png` and `manifest.json`.

- An integer `schemaVersion` drives a pure, total **migration chain**. Published versions are never edited in place.
- The data is plain and serialisable: `JSON.parse(JSON.stringify(x))` must be lossless. Catalogue entries are stored as references (id + version), never inlined. An `extensions` bag keeps forward compatibility. The world-level `seed` is part of the state.
- Saves are written atomically (temp file, then rename) in the main process. Autosave keeps N rotating slots.
- `save-format-guardian` owns this format. Every schema change ships with a fixture and a round-trip test.

### 4.9 Rendering and interaction

- **Modes:**
  - **Walk**: first-person, WASD plus mouse look, pointer lock.
  - **Work**: focus a panel or box with an orbit or pan camera, a cursor and snapping.
  - **Editor**: the 3D viewport stays visible while a 2D editor is docked.
- **Wire routing UX** (highest UX risk, prototyped in P1 as a spike and built in P3):
  1. Pick the wire type from the spool.
  2. Click the source terminal.
  3. Optionally click waypoints, or snap to a duct, conduit or staple path.
  4. Click the destination terminal.
  5. Termination steps scale with difficulty: auto at Trainee; strip, ferrule and torque prompts at Realistic.

  The rope sags with Verlet physics while live, then bakes to a static mesh. Wires are labelled.

- **Probing:** each meter lead is a cursor tool that snaps to terminals and conductors. A meter HUD shows the reading. The CAT rating and input jack state are part of the tool state.
- **Overlays** (each a debug or difficulty toggle): voltage colouring, current-flow animation, heat map (also as an in-game IR camera tool from P9), X-ray wire tracing (Trainee only), netlist inspector.
- **Audio** (from P4): breaker click, contactor clunk, relay chatter, transformer hum, a motor hum that changes when single-phasing, an arc-fault crack. Sound is a big realism cue and part of diagnosis.
- **Performance budget:** 60 fps on a 2020-era integrated GPU at 1080p with a 500-device plant. Instanced meshes are used for terminals and wire segments.

### 4.10 Region profiles

A `RegionProfile` sets nominal voltages, frequency, conductor sizing (AWG vs mm²), colour codes, symbol set (ANSI/JIC vs IEC 60617), device families (NEMA vs IEC), protection defaults (GFCI 5 mA vs RCD 30 mA, breaker curves), and the inspector rule set. **NEC is the only profile shipped through 1.0.** The type exists from P1 and is threaded through the code so that adding IEC is content work, not a refactor.

### 4.11 Electron security posture

`contextIsolation`, `sandbox` and `webSecurity` are **on**, and `nodeIntegration` is **off**. Content is served from `app://` with a strict CSP (`script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:`). The preload exposes only a narrow typed bridge, using `invoke`/`handle` with payloads validated by Zod in main and `senderFrame` checked. `will-navigate` and window opening are blocked. Electron Fuses disable RunAsNode and NODE_OPTIONS and enable ASAR integrity. The optional real Modbus/OPC UA server (P12) is off by default, binds to 127.0.0.1, and shows an explicit warning before binding to the LAN.

---

## 5. Open-source references and licence policy

Because the game is **MIT**, we may depend on or adapt **MIT/BSD/ISC/Apache** code, with attribution in `THIRD_PARTY_NOTICES.md`. **GPL/AGPL/LGPL** projects are **reference-only**: we read their docs and design, then reimplement from papers and specs, and never paste or translate their code. Algorithms aren't copyrightable; code is.

| Project                                                                                                  | Licence               | How we use it                                                                                                                            |
| -------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Falstad **CircuitJS1** (now TS)                                                                          | GPL-2.0               | Reference only. Its `INTERNALS.md` solver design: LU reuse, wire merging, companion models                                               |
| **@spice-ts/core**, **brownout**                                                                         | MIT                   | Adapt the sparse LU and step-acceptance logic; spice-ts as a test oracle and the scope bench                                             |
| **ngspice** / **eecircuit-engine**                                                                       | BSD / MIT             | Dev-only **oracle** for solver golden tests                                                                                              |
| **Modelica Standard Library**                                                                            | BSD-3                 | Port induction machine, transformer and quasi-static equations                                                                           |
| **OpenDSS / dss_capi**, **pandapower**                                                                   | BSD-3                 | Unbalanced 3-phase phasor modelling, TCC curves, short-circuit method, ZIP loads                                                         |
| **CircuitVerse**                                                                                         | MIT                   | Event-queue ideas for discrete propagation                                                                                               |
| **OpenPLC Runtime v4**                                                                                   | MIT                   | Scan-cycle and located-variable (%IX/%QX/%MW) mapping concepts                                                                           |
| **OpenPLC Editor v4**, **STruC++**, **Beremiz/MatIEC**                                                   | GPL                   | Reference only. Editor UX, PLCopen XML project model, ST grammar coverage                                                                |
| **PLCopen TC6 XML / IEC 61131-10**                                                                       | Open spec             | Import/export format for LD, ST and FBD (P10–P11)                                                                                        |
| **FUXA** (Angular SCADA)                                                                                 | MIT                   | Patterns, and possibly adapted components, for the HMI editor/runtime split, tag model and widgets                                       |
| **Studomate**                                                                                            | AGPL-3.0              | UX ideas only. Do not read code for copying                                                                                              |
| **Rapid SCADA**, **ScadaBR**, **Node-RED Dashboard 2**                                                   | Apache / GPL / Apache | Architecture ideas: server/communicator split, event detectors, widget binding                                                           |
| **modbus-serial** (ISC), **node-opcua** (MIT)                                                            | permissive            | Optional real protocol servers in main (P12)                                                                                             |
| **maximegris/angular-electron**                                                                          | MIT                   | Reference for Angular-in-Electron wiring. We roll our own setup                                                                          |
| **Bitburner**, **shapez.io**                                                                             | Apache/GPL            | Reference only. How Electron games structure saves and modding                                                                           |
| Commercial: Factory I/O, CADe SIMU, LogixPro, Automation Studio, Electrician Simulator, Amatrol FaultPro | —                     | Inspiration only (`domain-realism`, Part A). We build none of them. Our differentiator is the physical-to-logic layer with a real solver |

---

## 6. Phased roadmap

Every phase has the same shape:

1. **Kickoff.** Use the Plan agent to write `plans/phase-N-<slug>.md`, breaking the scope into features `FN.x` with acceptance criteria. Create that phase's specialist agents.
2. **Build**, one feature per PR, each meeting the Definition of Done (§9.1).
3. **Close-out.** `docs-keeper` sync, then `version-keeper` bumps the minor version, then `release-engineer` cuts the release and smoke-tests the installers.

### P0 — Foundation (v0.1.0, "Hello, panel")

- **F0.1** Nx 24 + pnpm workspace, TS strict, ESLint flat config, Prettier, boundary tags, `.nvmrc` (Node 24). Check TypeScript and Angular compatibility and whether `tsgo` can be used.
- **F0.2** Electron 45 shell: esbuild main/preload, `app://` protocol with COOP/COEP (check that `crossOriginIsolated` is true), security posture and Fuses, typed IPC skeleton (`ipc-contract`).
- **F0.3** Angular 22 zoneless `apps/game`, running both inside Electron and in the browser harness (`platform-web`).
- **F0.4** Three.js viewport: WebGPU with WebGL2 fallback (show the active backend in the about box), rendering a procedural DIN rail and backplate; resize handling; renderer disposal.
- **F0.5** CI: `pr.yml` (format check, lint, typecheck, unit, Linux E2E) and `main.yml` (OS matrix). **`pnpm verify` runs exactly what CI runs, including `prettier --check`**, so a formatting failure can't slip through locally (a lesson from jansky-observe).
- **F0.6** Release pipeline: electron-builder config, `release.yml` triggered by `v*` tags, a build matrix producing a draft GitHub Release (NSIS, dmg/zip, AppImage/deb/rpm, `latest*.yml`), electron-updater wiring (no-op in dev). Signing is **off** for now (§9.3).
- **F0.7** Docs skeleton: README, `CHANGELOG.md` (Keep a Changelog), `docs/README.md` hub, `docs/history.md`, `docs/architecture/`, `docs/caveats/`, `docs/decisions/` (ADR 0001 stack, 0002 simulation architecture, 0003 licence policy, 0004 save format), `docs/glossary.md`, `THIRD_PARTY_NOTICES.md`, LICENSE (MIT). Move the research into `docs/research/` (already there).
- **F0.8** Claude setup (§10): `CLAUDE.md`, the **helper agents** `docs-keeper`, `version-keeper` and `release-engineer`, plus `electron-platform-engineer` and `test-engineer`; the skills `/verify`, `/docs-sync` and `/release`; `tools/check-version-sync.mjs`.
- **Acceptance:** `pnpm verify` is green on all three operating systems. Pushing `v0.1.0` produces a draft release whose installers launch on Windows, macOS and Linux and show the viewport. The `/release` dry run is documented in `docs/guides/releasing.md`.

### P1 — Game shell: UI, commands, cameras, save/load (v0.2.0)

- **F1.1** Shell UI: main menu, new/load/continue, settings (graphics, audio, controls, units, difficulty, region placeholder), docking workspace (pick dockview or custom in an ADR), HUD, notifications, theming, keyboard-first accessibility.
- **F1.2** **Command system** (§4.6): registry, bus, undo/redo, replay log.
- **F1.3** **Command palette**, with argument forms generated from Zod.
- **F1.4** **Keybinding service**: rebinding UI, contexts, conflict detection, saved bindings, tool belt slots.
- **F1.5** **Dev console** (CodeMirror 6): parser, completion, history, cheat flagging.
- **F1.6** **Scripting API v0** plus `apps/sim-cli` running scripts headlessly.
- **F1.7** Cameras and interaction: walk mode, work mode (focus/orbit), hover and selection via BVH, placement with snapping to DIN rail, backplate grid and wall studs.
- **F1.8** World document v1 and the `.ctrl` container: save/load/autosave, migration framework, `save-format-guardian` agent. Lands as two PRs: **F1.8a** (schemas and migrations, before F1.2) and **F1.8b** (container, I/O and autosave, after the shell).
- **F1.9** Sandbox "workshop" level: bench, wall section, backplate, generic placeable objects.
- **F1.10** Spike: throwaway wire-routing prototype to reduce UX risk before P3. Write up the findings in an ADR.
- **Agents created:** `angular-ui-engineer`, `renderer-engineer`, `save-format-guardian`.
- **Acceptance:** place, move and delete objects with undo/redo through mouse, palette, console _and_ a script, with identical resulting world state. Saving and reloading is lossless and passes a property test. E2E covers the palette and console.

### P2 — Circuit engine and power sources (v0.3.0)

- **F2.1** Netlist compiler: union-find, incremental recompile, topology hash.
- **F2.2** DC MNA and complex phasor MNA, island detection, gmin, dense and sparse LU, factorisation cache.
- **F2.3** Sim worker: 1 kHz fixed step, SharedArrayBuffer snapshot protocol, time control, seeded RNG, determinism test (same seed and log give byte-identical snapshots).
- **F2.4** **Power sources:**
  - battery (EMF, internal R, state of charge);
  - bench DC supply (constant-voltage/constant-current limiting);
  - DIN 24 VDC PSU (current limit, hiccup mode);
  - **utility service**, 120/240 split-phase behind a source impedance, which sets the available fault current;
  - three-phase 208Y/120 and 480Y/277 source models (used for gameplay in P6);
  - portable generator (stub).
- **F2.5** First loads and switching: resistor, heater, incandescent lamp (filament R(T), so cold-start inrush), SPST switch, fuse (I²t), basic thermal-magnetic breaker.
- **F2.6** Debug tools: voltage colour overlay, current animation, netlist inspector panel, `netlist.dump`.
- **F2.7** Oracle test harness: random small circuits solved by ngspice (dev dependency) and compared with sim-core. Hand-calculated golden fixtures. fast-check properties (KCL at every node, energy balance). `sim-cli bench` performance gate.
- **Agents created:** `sim-engine-engineer`, `electrical-realism-reviewer`.
- **Acceptance:** golden fixtures agree within 0.5 % and the oracle suite passes. Budgets from §4.5 are met. In-game demo: battery → switch → lamp on the bench, with the lamp's brightness following the solved power.

### P3 — Wires, terminations, enclosures and hand tools (v0.4.0)

- **F3.1** Conductor catalogue: THHN/THWN-2, NM-B cable assemblies (14/2, 12/2, 12/3 with ground, …), MTW, solid vs stranded, 18 AWG to 4/0. Resistance is computed from resistivity with a temperature coefficient. Ampacity comes from cited published data. Insulation colours follow the region profile.
- **F3.2** 3D wire routing (§4.9): Verlet sag and baking, length gives resistance, ducts, conduit (EMT-lite), staples, wire labels and numbers, cable stripping of NM jacket.
- **F3.3** Terminations: screw, spring-cage, wire nut, ferrule, ring/fork lug, back-stab. Quality (strip length, nicked strands, torque, conductor count, aluminium on non-CO/ALR) sets contact resistance, which leads to heat and then intermittent or arcing faults.
- **F3.4** **Hand tools** and the tool belt: strippers (gauge holes), cutters, screwdriver/torque driver, crimper (die selection), nut driver, drill/hole saw, fish tape (minigame), label maker. Owned tools carry into the career economy in P5.
- **F3.5** Enclosures and mounting: device boxes, junction boxes, DIN-rail panel, wire duct, backplate, knockouts.
- **F3.6** Conductor and termination thermal model, insulation damage events, voltage drop readout.
- **Agents created:** `content-designer`.
- **Acceptance:** the player builds a lamp circuit from supply through boxes using real tool steps. A deliberately bad termination produces a measurable voltage drop under load and heats up. The voltage drop over 30 m of 14 AWG matches a hand calculation.

### P4 — Lights, switches, receptacles, panels and protection: first playable sandbox (v0.5.0)

- **F4.1** Wiring devices: single-pole, 3-way and 4-way switches, dimmer (abstracted), lamp holders, LED fixtures (constant-power driver), receptacles (NEMA 5-15/5-20/6-20/14-30/14-50), GFCI receptacles (line/load terminals, test/reset), plug-in appliances with load profiles.
- **F4.2** Load centre: main breaker, bus, 1-pole and 2-pole breakers, GFCI/AFCI breakers, neutral and ground bars, main bonding jumper, panel directory labelling.
- **F4.3** Grounding and bonding: EGC, box bonding, GEC and ground rod (R_earth), neutral–ground bonding rules. A subpanel bond causes objectionable current. A lost EGC means a fault energises the enclosure.
- **F4.4** Multiwire branch circuits (MWBC) and the lost-neutral overvoltage effect.
- **F4.5** **Inspector** rules engine (data-driven, citing article numbers, not quoting them): conductor vs OCPD sizing, box fill, GFCI locations, colour/re-identification, bonding.
- **F4.6** Audio system v1. Residential sandbox map (a small house plus garage).
- **Acceptance:** in the house sandbox the player wires the panel and circuits, a 3-way works, and a bolted short trips the breaker within the curve band. A ground fault on a GFCI circuit trips in under 25 ms. The inspector flags an undersized conductor and a missing bond.

### P5 — Instruments, safety, faults and the Apprentice career (v0.6.0)

- **F5.1** **Test instruments**, each stamped into the circuit (§4.5):
  - DMM: V AC/DC, Ω, continuity, A through a fused jack, LoZ, CAT rating, leads left in the A jack;
  - NCVT, with false negatives and false positives;
  - clamp meter: inrush, reads ~0 around both conductors;
  - receptacle tester;
  - insulation tester (megger) at 500 or 1000 V, which damages electronics left connected.
- **F5.2** Safety systems:
  - shock model (body and contact resistance, wet conditions, let-go and fibrillation thresholds);
  - PPE inventory, arc-flash labels and PPE category, approach boundaries;
  - **LOTO** (locks, tags, release of stored energy, verifying zero energy);
  - **live–dead–live** test tracking.
- **F5.3** Difficulty presets (Trainee / Apprentice / Journeyman / Realistic) controlling hints, X-ray, termination detail and consequences.
- **F5.4** **Fault-injection framework** (data-driven specs, each with a measurable signature): open, short, ground fault, high-resistance joint, reversed polarity, open neutral, mislabelled breaker, tripped GFCI downstream.
- **F5.5** **Career framework**:
  - work orders (briefing, prints, customer notes), objectives, evaluation;
  - scoring modelled on FaultPro: time, number of tries, parts replaced needlessly, and safety violations weighted heaviest;
  - XP and licence progression, reputation, a light economy (wages, buying tools and meters).
- **F5.6** **Apprentice campaign**, about 10 jobs (see `domain-realism` starter scenarios 1–6 and others):
  - a dead kitchen outlet caused by a GFCI tripped in another room;
  - a 3-way with miswired travelers;
  - tracing and labelling a mislabelled panel;
  - a 240 V water heater on a 208 V service;
  - a garage subpanel with a neutral–ground bond;
  - a sump pump on a dedicated circuit;
  - …
- **Acceptance:** the Apprentice campaign can be completed end to end, and every job is solvable at Realistic difficulty with instruments alone. An automated `sim-cli` script solves each job, and the CI gate fails if a job becomes unsolvable. Safety violations are recorded and scored.

### P6 — Three-phase, control circuits, relays and timers (v0.7.0)

- **F6.1** Three-phase distribution: 208Y/120 and 480Y/277 panelboards, fused and non-fused disconnects, phase-rotation meter, high-leg delta (optional).
- **F6.2** Control power: control power transformers (480/240 to 120 V, fused secondary, one side grounded), 24 VDC PSUs, control fusing.
- **F6.3** Pilot devices: momentary and maintained pushbuttons with NO/NC contact blocks, mushroom E-stop with twist release, selector switches, pilot lights, stack lights.
- **F6.4** **Control relays**: ice-cube and DIN relays and sockets; coil voltage ratings, where a mismatch causes burnout or chatter; pickup and dropout; contact ratings and welding.
- **F6.5** **Timer relays**: on-delay, off-delay (true off-delay vs triggered), interval, recycle, multi-function dial. Dial settings are part of device state, so a mis-set timer is a fault.
- **F6.6** Discrete solver layer (§4.5): fixed-point iteration, race and oscillation detection.
- **F6.7** **Prints** v1:
  - 2D ladder-diagram viewer and editor with ANSI/JIC symbols, rung numbers, wire numbers, cross-references and terminal strips;
  - auto-generated as-built print;
  - print-vs-as-built mismatch as a fault type.
- **Acceptance:** build a 3-wire start/stop seal-in with pilot lights on a 120 VAC control transformer, from the print, and see it work. A timer sequence works. A 24 VDC coil on 120 VAC burns out, with audible and visible signs.

### P7 — Contactors, overloads and motors (v0.8.0)

- **F7.1** **Contactors**: NEMA sizes and IEC AC-3 ratings, auxiliary blocks, mechanical interlock kits, welding when undersized or jogged.
- **F7.2** **Overload relays**:
  - bimetal and electronic types; Class 10, 20 and 30;
  - an FLA dial, where setting it to the breaker rating instead of the FLA is a fault;
  - manual or auto reset, thermal memory, phase-loss sensitivity.

  Also motor protective circuit breakers (MPCBs).

- **F7.3** **Motors**:
  - three-phase induction motor (Steinmetz model plus mechanical ODE); nameplate with V, FLA, SF, code letter, RPM and frame;
  - 9-lead dual-voltage wye/delta connections; rotation reversal by swapping two phases;
  - single-phase capacitor-start motor (centrifugal switch failure);
  - small PMDC motor;
  - mechanical loads: fan (∝ω²), conveyor (constant torque).
- **F7.4** **Starters**: DOL, jog, forward/reverse with electrical and mechanical interlocks, star-delta (with a timer), 2-wire control with its auto-restart hazard.
- **F7.5** Motor diagnostics: winding resistance, megger to ground, clamp imbalance; the motor hum and stall sounds.
- **F7.6** **Journeyman campaign, part 1**:
  - a shop conveyor whose overload dial is set wrong;
  - a forward/reverse starter for an overhead door;
  - a humming motor that turns out to be a blown fuse (single-phasing);
  - meggering a motor wet from a flood before restart;
  - LOTO on a machine with a second energy source.
- **Acceptance:** `electrical-realism-reviewer` signs off that starting current and time are plausible. Single-phasing makes the motor hum, and the overload trips within its class band. The reversing interlock prevents both contactors closing. Swapping two phases reverses rotation.

### P8 — Pumps, actuators and process simulation (v0.9.0)

- **F8.1** Process layer in `sim-core`: lumped fluid network (tanks, pipes, check valves, pump curve vs system curve, level dynamics), pneumatics (compressor, receiver, regulator, air as a pressure resource), mechanical (linear travel, conveyors carrying parts).
- **F8.2** **Pumps**: centrifugal pump with a performance curve, dry-run seal damage, dead-head heating, water hammer (abstracted), sump and duplex lift station.
- **F8.3** **Actuators**:
  - solenoid valves: AC vs DC coils, inrush, burnout from a stuck spool;
  - 5/2 and 5/3 pneumatic valves, single- and double-acting cylinders;
  - motorised valves; linear actuators with limit switches.
- **F8.4** Process switches needed for pumping: float switches and pressure switches (the full sensor catalogue comes in P9). Alternating relay for duplex pumps.
- **F8.5** **Journeyman campaign, part 2**: replace a basement sump pump; a duplex lift station with alternation; a pneumatic clamp fixture.
- **Acceptance:** a duplex lift station with floats and an alternator runs on relay logic alone. A dry-run permissive protects the pump. Cylinder travel times respond to air pressure.

### P9 — Sensors and instrumentation (v0.10.0)

- **F9.1** Discrete sensors:
  - limit switches;
  - inductive proximity (metal only) and capacitive proximity (also detects the tank wall), each with a sensing range;
  - photoelectric (through-beam, retroreflective, diffuse, with lens contamination);
  - reed switches on cylinders.

  **NPN vs PNP** wiring, **2-wire vs 3-wire**, and 2-wire leakage current causing a false ON.

- **F9.2** Analog:
  - 4-20 mA transmitters, both 2-wire loop-powered and 4-wire, for level, pressure, flow and temperature;
  - Pt100 RTDs and J/K thermocouples (wrong extension wire, reversed polarity);
  - signal conditioners and panel meters.

  A broken loop reads 0 mA; 4 mA is the live zero.

- **F9.3** Instrument tools: loop calibrator (source, measure, simulate), IR thermometer and **thermal camera** (shows hot terminations from the P3 thermal model).
- **F9.4** Sensors driving relay logic before the PLC exists (photo-eye → relay → conveyor stop).
- **Acceptance:** the wrong-sensor-type puzzle is reproducible: a PNP sensor on a sinking input stays dark. A broken 4-20 mA wire reads 0 mA, and the calibrator can isolate it. The thermal camera finds a loose lug.

### P10 — PLC I: hardware, runtime and ladder (v0.11.0)

- **F10.1** PLC hardware catalogue (fictional brand):
  - CPU, power supply, modular or rack I/O;
  - DC inputs (sinking or sourcing, with commons), AC inputs;
  - relay and transistor outputs, with output fusing;
  - analog in/out; status LEDs.

  Physically wired like any other device.

- **F10.2** **Runtime**:
  - one worker per PLC, tag memory in a SharedArrayBuffer;
  - each scan: input image → execute → output image → comms/watch;
  - driven by sim-clock ticks;
  - RUN/PROGRAM/REMOTE modes, watchdog, major and minor faults, first-scan bit, retentive memory, behaviour on power loss.
- **F10.3** **Program model**: IR (compiled closures or a stack VM; never `eval`), tag database (controller and program scope), both tag-based and IEC located (%IX/%QX/%MW) addressing.
- **F10.4** **Ladder editor** (grid-based SVG):
  - rungs, branches, instruction palette, tag picker;
  - verify/compile errors, power-flow monitoring online, forcing, online edits ("accept rung");
  - cross-reference and search.
- **F10.5** **Instruction set v1**: XIC/XIO/OTE/OTL/OTU/ONS; TON/TOF/RTO/RES; CTU/CTD/CTUD; EQU/NEQ/GRT/LES/GEQ/LEQ/LIM; ADD/SUB/MUL/DIV/MOD/SQR; MOV/COP/CLR; SCP. IEC names shown as aliases.
- **F10.6** An in-world programming laptop, connected over a simulated Ethernet cable (the full network arrives in P12; here it's a point-to-point link).
- **F10.7** PLCopen TC6 XML export and import for LD. A round-trip test, plus a documented manual check against OpenPLC Editor.
- **F10.8** **Controls Technician campaign, part 1**: convert relay logic to a PLC; a PNP photo-eye on an old sinking card; a conveyor sort sequence.
- **Agents created:** `plc-engineer`.
- **Acceptance:** a conveyor sorting program written in ladder runs deterministically against the P8/P9 process models, with monitoring and forcing working. Scan time is shown and the watchdog fires on an infinite loop.

### P11 — PLC II: Structured Text, FBD, analog and drives (v0.12.0)

- **F11.1** Structured Text: a hand-written recursive-descent parser and type checker compiling to the same IR (IF/CASE/FOR/WHILE, function blocks, user-defined types, arrays), in a CodeMirror 6 editor with diagnostics.
- **F11.2** FBD editor, compiling to the same IR. User-defined function blocks are usable from LD, ST and FBD.
- **F11.3** Analog: scaling, PID (positional, anti-windup, auto/manual, bumpless transfer), alarm instructions.
- **F11.4** **Basic VFD**:
  - nameplate parameter entry, accel/decel, control from terminals or a keypad;
  - fault codes OC/OV/UV/GF;
  - rules: never megger through the drive, no contactor between drive and motor.

  Also a basic soft starter.

- **F11.5** PLCopen XML for ST and FBD.
- **Acceptance:** a tank-level PID loop with the pump on a VFD holds its setpoint through disturbances. The same function block works identically from LD and from ST.

### P12 — Industrial networking, SCADA and HMI (v0.13.0)

- **F12.1** Simulated network:
  - Ethernet switches, cables and IP configuration, where a broken cable or wrong subnet causes a timeout;
  - **Modbus TCP** at PDU level (function codes 1–6, 15 and 16, exception codes, latency, timeouts);
  - **Modbus RTU over RS-485**, with termination and biasing faults;
  - an OPC UA-style browse/read/write/subscribe model inside the game.

  VFDs and remote I/O can be accessed over the network.

- **F12.2** HMI hardware: a panel-mounted HMI in 3D and a SCADA PC in a control room.
- **F12.3** **HMI/SCADA builder**, following FUXA's editor/runtime split:
  - screen documents (`hmi-model`); a widget library (pushbutton, indicator, numeric, gauge, tank, motor and valve symbols, trend, alarm banner);
  - a properties panel generated from metadata; tag binding with expressions; navigation and faceplates; runtime mode.
- **F12.4** **Alarms**: the ISA-18.2 lifecycle, priority, deadband, on-delay, shelving, alarm summary and history.
- **F12.5** **Historian and trends** (uPlot): ring buffers, deadband logging, real-time and historical pens.
- **F12.6** **Optional real protocol exposure**: a modbus-serial `ServerTCP` and node-opcua in a utilityProcess, on 127.0.0.1, opt-in, with a warning. Players can connect real tools such as QModMaster, UaExpert or FUXA.
- **F12.7** **Controls Engineer campaign**: pump-station SCADA where a broken 4-20 mA loop floods the alarm list; commissioning a whole line.
- **Agents created:** `scada-engineer`.
- **Acceptance:** the player builds a lift-station HMI with alarms and a trend, and the HMI exposes communication faults realistically. With opt-in enabled, an external Modbus client reads and writes game tags.

### P13 — Campaign completion, polish and 1.0 (v1.0.0)

- **F13.1** Campaign pass: tutorials, pacing, licence "exams" (code-knowledge quizzes plus a practical), a master-tier taste (load calculations, service design, SCCR checklist).
- **F13.2** In-game **Field Guide**: a reference manual (tools, devices, procedures, symbols), generated from catalogue and content data plus authored pages. `docs-keeper` keeps it in sync.
- **F13.3** Polish: accessibility audit, performance pass, published minimum specs, localisation framework (English only), crash logs (local, opt-in sharing), settings migration.
- **F13.4** **Mod pack format v1**: data-only packs (devices, jobs, faults, tables) loaded from a user mods folder with validation. Scripts run only in a sandboxed worker.
- **F13.5** **Code signing**, per the §9.3 decision, and auto-update across all platforms.
- **Acceptance:** the full career is playable start to finish. No open P0 or P1 bugs. Installers are signed if that's been decided. 1.0.0 is released.

### Post-1.0 backlog (parked)

IEC region profile (230/400 V, mm², IEC 60617 prints, RCDs, Zs loop testing, IEC fittings) · safety relays and stop categories (dual channel, monitored reset) · SFC/GRAFCET · arc flash via IEEE 1584 · EtherNet/IP-style networking · advanced VFDs · generators, transfer switches and backfeed · solar PV, ESS and EV chargers · lineman and utility content · co-op multiplayer · gamepad and Steam Deck · Steam distribution · VR.

---

## 7. Gameplay systems

- **Career ladder.** Apprentice (residential/light commercial, P5) → Journeyman (commercial/industrial three-phase, motors and process, P7–P8) → Controls Technician (sensors, PLC, P9–P10) → Controls Engineer (PLC II, SCADA, commissioning, P11–P12) → Master taste (P13).
  - Early levels are supervised: a journeyman NPC catches mistakes, and the penalty is halved.
- **Work orders.** Each has a briefing, site, prints (possibly wrong), customer or foreman notes, the available parts and tools, a time budget, objectives, and _hidden_ faults generated from fault specs with a seed.
- **Evaluation.**
  - The objective check runs through `sim-cli` probes, so it's the same code as the automated solvability tests.
  - Scoring borrows from Amatrol FaultPro: time, tries, parts replaced needlessly, safety violations (weighted heaviest), and inspector findings.
- **Economy (light).** Wages, buying tools and instruments with CAT ratings that matter, reputation that unlocks clients. No grinding.
- **Sandbox.** Every catalogue item, a choice of maps (workshop, house, shop floor, pump station, control room), the console with cheats, and fault injection. Assisted saves are flagged.
- **Difficulty presets** set hints, X-ray, termination detail, injury consequences, tolerance spread and time pressure. They're independent of career level.

---

## 8. Testing strategy

| Layer         | Tooling                                                                              | What's tested                                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `domain/*`    | Vitest + fast-check                                                                  | Solvers against golden hand calculations; **ngspice oracle** on random circuits; KCL and energy properties; migrations (every fixture from every version loads); command apply/invert round-trips; determinism (same seed and log give an identical snapshot hash). Coverage ≥ 90 %. |
| Device models | Vitest + `content` fixtures                                                          | Each device has a datasheet-style test: trip times inside the curve band, pickup and dropout, motor inrush, sensor leakage. Reviewed by `electrical-realism-reviewer`.                                                                                                               |
| Scenarios     | `sim-cli` scripts                                                                    | Every career job has a **solver script** that diagnoses and fixes it using only player-available commands. CI fails if a job becomes unsolvable or trivially solvable.                                                                                                               |
| UI            | Vitest + Angular testing                                                             | Palette, console parser, keybinding conflicts, editors                                                                                                                                                                                                                               |
| E2E           | Playwright `_electron`                                                               | Launch the packaged app; menu → new sandbox → wire → probe; save/load; HMI runtime                                                                                                                                                                                                   |
| Visual        | Playwright screenshots (fixed seed, DPR and backend) plus scene-graph JSON snapshots | Renderer regressions, without depending only on pixels                                                                                                                                                                                                                               |
| Performance   | `sim-cli bench`, renderer frame-time probe                                           | The §4.5 and §4.9 budgets, as CI gates                                                                                                                                                                                                                                               |

---

## 9. Process: Definition of Done, documentation, versioning, releases

### 9.1 Definition of Done (each feature PR)

Typed public API · unit tests (plus property or oracle tests for solver code) · at least one UI or E2E test for player-facing features · `pnpm verify` green · keyboard-accessible · **docs updated in the same PR by `docs-keeper`** (README features/TODO, relevant `docs/architecture` and `docs/caveats` pages, glossary, CHANGELOG `[Unreleased]`, Field Guide entries for new devices) · `electrical-realism-reviewer` sign-off for any new device model or electrical constant.

### 9.2 Documentation surfaces (same discipline as aquascape)

- **`README.md`**: pitch, feature bullets grouped by category, platforms, quick start, TODO, docs table, licence.
- **`CHANGELOG.md`**: Keep a Changelog format. `[Unreleased]` is updated with each PR and rolled up at release time.
- **`docs/history.md`**: the phase-by-phase record plus the save-format and catalogue version history.
- **`docs/architecture/<subsystem>.md`** (with Mermaid diagrams), **`docs/caveats/<area>.md`** (each opening with "Load this when…"), **`docs/decisions/NNNN-*.md`** (ADRs), **`docs/glossary.md`**, **`docs/guides/`** (new developer, releasing, authoring content, writing jobs).
- **`CLAUDE.md`**: status line plus _the next concrete step_, invariants, DoD, commands, **agent routing table**, caveats index. Keep it short.
- **In-game Field Guide** (from P13): generated from `content/` and authored pages.

### 9.3 Versioning and releases

- **SemVer.** Each phase ships a **minor** release (`0.N.0`). Fixes are patches. **1.0.0** comes with P13. `schemaVersion` (save format) and `catalogVersion` are versioned **independently** and recorded in `docs/history.md`.
- **Version sources** kept in lockstep by `version-keeper`, and checked by `tools/check-version-sync.mjs` in CI:
  - root `package.json`;
  - `apps/desktop/package.json` (which electron-builder reads);
  - the generated `libs/domain/units/src/version.ts` (shown in the about box and the save manifest);
  - `CHANGELOG.md`;
  - the README badge and status;
  - the `CLAUDE.md` status line.
- **Release flow (`/release minor|patch`):**
  1. `version-keeper` picks or confirms the bump from the CHANGELOG, bumps every source, and rolls `[Unreleased]` into the new version.
  2. `release-engineer` runs `pnpm verify` plus a local package for the current OS, smoke-tests the installer with Playwright `_electron`, and prepares the tag.
  3. **The user confirms.** Then it pushes the tag. `release.yml` builds Windows, macOS and Linux into a **draft** GitHub Release with notes taken from the CHANGELOG.
  4. `release-engineer` checks the artifacts and `latest*.yml`. The user publishes the draft.
- **Signing.** Releases are **unsigned until a decision before P13**:
  - macOS: Developer ID + notarisation, US$99/yr. Without it, Gatekeeper warns and macOS auto-update is disabled.
  - Windows: Azure "Artifact Signing" (eligibility and price to be checked) or an OV certificate.
  - Linux: no signing needed. Linux auto-update works from v0.1 via AppImage.

---

## 10. Claude Code agents and skills

The pattern follows aquascape: project-level sub-agents in `.claude/agents/`, each owning one slice and pushing back rather than quietly violating an invariant. **Helper agents (requested)** are created in P0. **Specialists** are created at the kickoff of the phase that needs them, so they're written with real context.

### 10.1 Helper agents (P0)

#### `docs-keeper`

```markdown
---
name: docs-keeper
description: Use after any feature, fix, or refactor lands (or before a PR is opened) to bring documentation back in sync: README features/TODO, CHANGELOG [Unreleased], docs/history.md, docs/architecture/*, docs/caveats/*, docs/glossary.md, docs/guides/*, the CLAUDE.md status line and agent routing table, and (from P13) the in-game Field Guide. Also use when asked "are the docs up to date?" or to audit doc drift.
tools: Read, Write, Edit, Bash, Grep, Glob
---

You are the documentation steward for Controls. Documentation drift is a failing test.

## Inputs

Determine what changed: `git diff main...HEAD --stat`, commit messages, and the plan feature IDs (FN.x) referenced.

## Rules

1. README: grouped feature bullets (by category, not phase); when a TODO ships, remove the TODO line and add a feature bullet.
2. CHANGELOG.md: add entries under [Unreleased] (Added/Changed/Fixed/Removed/Security) in player-facing language. Never edit a released section.
3. docs/history.md: phase narrative only when a phase or milestone completes; record schemaVersion/catalogVersion bumps.
4. New subsystem → new docs/architecture page + hub link. New gotcha → matching docs/caveats file (lead with "Load this when…"). New term → glossary row. New one-time architectural choice → suggest an ADR (don't invent decisions).
5. CLAUDE.md: update the status line and "next concrete thing"; keep the agent routing table accurate when agents are added/renamed. Keep CLAUDE.md short — push area detail to caveats.
6. New device or job content → Field Guide page / content docs (P13+).
7. Never change code. Never fabricate behaviour — if docs and code disagree and you can't tell which is right, report it.

## Output

List each file touched and why, plus any drift you found but could not resolve.
```

#### `version-keeper`

```markdown
---
name: version-keeper
description: Use when bumping the project version (patch/minor/major), preparing a release, or when version sources disagree. Owns SemVer decisions, lock-step version updates across package.json files, the generated version.ts, CHANGELOG roll-up, README/CLAUDE.md status, and tools/check-version-sync.mjs. Also tracks schemaVersion and catalogVersion bumps (recorded, not decided — save-format-guardian decides those).
tools: Read, Write, Edit, Bash, Grep, Glob
---

You own the version number of Controls.

## Policy

- SemVer. Each completed phase = minor (0.N.0). Bug-fix-only = patch. 1.0.0 only at P13 completion with user approval.
- Pre-1.0, breaking save-format changes are allowed only with a migration (verify one exists; ask save-format-guardian if unsure).

## Procedure

1. Read CHANGELOG [Unreleased]; propose the bump with reasoning; confirm with the user if it differs from what they asked.
2. Update in lock-step: root package.json, apps/desktop/package.json, regenerate libs/domain/units/src/version.ts, README badge/status, CLAUDE.md status line.
3. Roll [Unreleased] into `## [x.y.z] - YYYY-MM-DD`; add a fresh empty [Unreleased]; update compare links.
4. Run `node tools/check-version-sync.mjs` and `pnpm verify`.
5. Commit as `chore(release): vX.Y.Z`. Do NOT tag or push — hand off to release-engineer.

Report the old→new version, every file changed, and verification output.
```

#### `release-engineer`

```markdown
---
name: release-engineer
description: Use to build, package, smoke-test, and publish a release, or for any change to electron-builder config, .github/workflows/release.yml, auto-update (electron-updater), code signing/notarization, installer targets, or release troubleshooting. Invoke after version-keeper has committed the bump. Also run at P0 kickoff to re-verify toolchain versions in the plan.
tools: Read, Write, Edit, Bash, Grep, Glob, WebFetch, WebSearch
---

You ship Controls to players on Windows, macOS, and Linux via GitHub Releases.

## Invariants

- Releases are built by CI from a tag on main — never upload locally built artifacts as the release.
- Releases are created as DRAFTS; the user publishes.
- Never push tags, publish releases, or change signing secrets without explicit user confirmation in this conversation.
- Electron security posture and Fuses must survive packaging (check fuses with @electron/fuses read).

## Procedure (`/release`)

1. Preflight: clean tree on main, version-keeper commit present, `check-version-sync` + `pnpm verify` green.
2. Local package for the current OS (`pnpm package:desktop`); run the Playwright `_electron` smoke suite against the packaged app (launch, new sandbox, save/load, about box shows the version).
3. Show the user the tag and draft notes (from CHANGELOG); on confirmation push `vX.Y.Z`.
4. Watch `release.yml` (`gh run watch`); on success verify the draft has every artifact (NSIS .exe, .dmg/.zip universal, AppImage/.deb/.rpm) plus latest*.yml/blockmaps and that the updater metadata points at the right files.
5. Report the draft URL and any failures with logs. Record lessons in docs/caveats/release.md.
```

### 10.2 Specialist agents (created at the listed phase)

| Agent                         | Phase | Owns, and the invariants it enforces                                                                                                                                                                                                                    |
| ----------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `electron-platform-engineer`  | P0    | `apps/desktop`, `platform/electron`, `ipc-contract`. Security posture, `app://` with COOP/COEP, Zod-validated IPC, atomic file I/O, utilityProcess                                                                                                      |
| `test-engineer`               | P0    | Test strategy (§8), Playwright `_electron`, visual baselines, CI gates, determinism tests                                                                                                                                                               |
| `angular-ui-engineer`         | P1    | `apps/game`, `ui`, `features/*`. Zoneless and signals, never mutating the world outside Commands, accessibility, palette, console and keybinding UX                                                                                                     |
| `renderer-engineer`           | P1    | `rendering/renderer`. Imperative Three.js, WebGPU with WebGL2 fallback, disposal, picking, cables, procedural geometry, frame budget                                                                                                                    |
| `save-format-guardian`        | P1    | `domain/save-format`, `world-model` serialisation. Schema and migration lockstep, fixtures, round-trip losslessness, `schemaVersion` decisions                                                                                                          |
| `sim-engine-engineer`         | P2    | `domain/sim-core`, `sim-worker`. MNA design, determinism, performance budgets, the oracle suite, the reimplement-don't-copy rule for GPL references                                                                                                     |
| `electrical-realism-reviewer` | P2    | Read-only reviewer. Checks every device model and constant against cited sources and the §3 realism charter; flags implausible values, missing `source` fields and copied NEC text. (Modelled on jansky-observe's `dsp-reviewer` / `science-reviewer`.) |
| `content-designer`            | P3    | `content/` catalogue, tables, jobs and fault specs. Schema validity, fictional brands, a solver script per job, difficulty tuning                                                                                                                       |
| `plc-engineer`                | P10   | `domain/plc`, PLC runtime. Scan semantics, IR, instruction-set accuracy, PLCopen XML round-trips                                                                                                                                                        |
| `scada-engineer`              | P12   | `hmi-model`, HMI editor/runtime, simulated network, alarms and historian, the opt-in real protocol servers                                                                                                                                              |

### 10.3 Skills (P0, in `.claude/skills/`)

- **`/verify`**: runs `pnpm verify` (format check, lint, typecheck, unit, build), which mirrors CI exactly.
- **`/docs-sync`**: invokes `docs-keeper` on the current branch diff.
- **`/release [patch|minor]`**: `version-keeper` → `release-engineer`, with a user confirmation gate before tagging.

### 10.4 Agent routing table (goes into CLAUDE.md)

| When you are…                                                       | Use                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Finishing any feature or fix, or before opening a PR                | `docs-keeper` (or `/docs-sync`)                                    |
| Bumping the version or preparing a release                          | `version-keeper`, then `release-engineer` (or `/release`)          |
| Touching packaging, `release.yml`, the updater or signing           | `release-engineer`                                                 |
| Changing save or world schemas or migrations                        | `save-format-guardian`                                             |
| Changing solvers, device electrical models or the worker protocol   | `sim-engine-engineer`, then `electrical-realism-reviewer`          |
| Adding devices, tables, jobs or faults                              | `content-designer`, then `electrical-realism-reviewer`             |
| Working on Three.js, cables, picking or audio                       | `renderer-engineer`                                                |
| Working on Angular UI, the palette, console, keybindings or editors | `angular-ui-engineer`                                              |
| Working on Electron main, preload or IPC                            | `electron-platform-engineer`                                       |
| Working on the PLC runtime, compilers or ladder/ST editors          | `plc-engineer`                                                     |
| Working on HMI/SCADA, networking or alarms                          | `scada-engineer`                                                   |
| Working on test infrastructure, CI gates or flaky E2E               | `test-engineer`                                                    |
| Starting a phase                                                    | Plan agent → `plans/phase-N-*.md`; create that phase's specialists |

Default to a single sub-agent. Reach for an agent team (as in aquascape's `team-playbooks/`) only when three or more areas must agree a new contract at the same time. Expected cases: P2 (sim ↔ worker ↔ renderer snapshot), P10 (PLC ↔ sim ↔ editor), P12 (network ↔ HMI ↔ PLC).

---

## 11. CLAUDE.md draft (written in F0.8)

```markdown
# CLAUDE.md

## Repository state

**Phase 0 in progress.** Next: see `plans/phase-0-foundation.md`. Version 0.0.0. Spec: `controls-development-plan.md`.

## What this project is

Controls — a realistic electrician → controls-engineer simulation game. Electron + Angular 22 (zoneless) + Three.js r186, TypeScript, Nx + pnpm. MIT. NEC/US first.

## Non-negotiable invariants

- The simulator runs what is wired, not what is drawn (physical → netlist; prints are separate and may be wrong).
- `domain/*` is framework-free; `sim-cli` must be able to run the game headless.
- Every world mutation is a registered Command (palette, keybinds, console, scripting API share one registry); UI never mutates world state directly.
- Determinism: integer sim ticks + seeded PRNG; seed + command log reproduces a session.
- Realism charter: every constant has a `source`; never copy NFPA/NEC text; fictional brands.
- Licence policy: MIT/BSD/ISC/Apache may be used with attribution; GPL/AGPL code is reference-only — reimplement, never paste.
- Save format: Zod schema is the source of truth; schemaVersion + total migration chain; lossless JSON round-trip.
- Electron: contextIsolation+sandbox on, typed Zod-validated IPC, app:// with COOP/COEP, strict CSP, Fuses.

## Definition of Done

(see plan §9.1) — includes docs updated in the same PR via `docs-keeper`.

## Commands

`pnpm verify` (== CI, includes prettier --check) · `pnpm start` (desktop dev) · `pnpm start:web` · `pnpm test` · `pnpm e2e` · `pnpm package:desktop`

## Agents — use them

(agent routing table from plan §10.4)

## Caveats index

`docs/caveats/<area>.md` — load the matching file before working in an area.
```

---

## 12. Risks and mitigations

| Risk                                                                                                         | Mitigation                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **The 3D wire-routing UX is fiddly.** Electrician Simulator was criticised for clipping and fiddly controls. | Spike in P1 (F1.10). Snap-to-raceway, auto-routing along ducts, generous terminal hit targets, and termination detail scaled by difficulty.     |
| **The solver is slow or unstable on big plants.**                                                            | Quasi-static phasor instead of 60 Hz transient, union-find merging, cached factorisations, a CI performance gate, and the ngspice oracle.       |
| **Scope creep.** 13 phases is a lot.                                                                         | Each phase is a shippable minor release. The post-1.0 backlog is parked. The P5 vertical slice proves the fun before the industrial phases.     |
| **Toolchain churn** (TypeScript 7 vs Angular compiler, WebGPU on Linux).                                     | Pin versions; the WebGL2 fallback is always tested in CI; `release-engineer` re-checks versions at each phase kickoff.                          |
| **SharedArrayBuffer and cross-origin isolation in Electron.**                                                | Verified in F0.2. The `postMessage` fallback is kept tested.                                                                                    |
| **Licence contamination** from GPL references.                                                               | Licence policy in CLAUDE.md, `THIRD_PARTY_NOTICES.md`, and reviewer checks. Sub-agents are told not to open GPL source files when implementing. |
| **NEC copyright, and realism errors.**                                                                       | Physics-derived and manufacturer-cited data, paraphrased rules with article citations, `electrical-realism-reviewer` sign-off.                  |
| **Unsigned builds scare users.**                                                                             | Document Gatekeeper and SmartScreen workarounds in the README. Decide on signing before P13.                                                    |
| **Asset production cost.**                                                                                   | Procedural parametric geometry for most devices; CC0 or authored glTF only for hero assets.                                                     |

---

## 13. Remaining open questions (defaults assumed until answered)

1. **Code-signing budget.** Default: unsigned until P13, then decide (macOS $99/yr; Windows Artifact Signing or OV).
2. **Minimum hardware.** Default: a 2020-era integrated GPU, 8 GB RAM, 1080p at 60 fps.
3. **Keep a browser build of the game** beyond the dev harness, such as a web demo? Default: dev harness only, not a supported product.
4. **3D assets.** Will you author Blender models, or should we stay procedural plus CC0? Default: procedural first.
5. **Gamepad and Steam Deck support.** Default: post-1.0.
6. **Real-world brands and PLC look-alikes.** Default: fictional, with industry-standard mnemonics only.
7. **Telemetry.** Default: none. Crash logs stay local, and sharing is opt-in.
8. **When to start the IEC profile.** Default: post-1.0. It could move earlier if European players are a target.
