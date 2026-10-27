# Glossary

> **Load this when:** you hit a term you don't know: trade jargon, a simulation technique, a codebase type or a tooling name. Terms are grouped by area; use Ctrl/Cmd+F for direct lookup. Add a row in the same PR that introduces a new term.

**Jump to:** [Electrical trade](#electrical-trade) · [Controls and automation](#controls-and-automation) · [Simulation](#simulation) · [Game and codebase](#game-and-codebase) · [Workspace and tooling](#workspace-and-tooling)

---

## Electrical trade

| Term               | Meaning                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AFCI**           | Arc-fault circuit interrupter. A breaker that trips on arcing signatures. Abstracted in the game as a probabilistic trip (realism charter §3.2).                                  |
| **Ampacity**       | The current a conductor can carry continuously without exceeding its temperature rating. Taken from cited published data, never copied NEC tables.                                |
| **AWG**            | American Wire Gauge. Display-only in the game; geometry and physics use SI (mm², metres).                                                                                         |
| **CAT rating**     | A meter's overvoltage category (CAT II–IV). Part of the instrument's tool state; using a low-CAT meter on service equipment is a safety violation.                                |
| **EGC**            | Equipment grounding conductor: the bare or green wire that bonds metal parts so a fault trips the breaker. A lost EGC leaves an enclosure live during a fault.                    |
| **FLA**            | Full-load amps, from a motor nameplate. Overload relays are set to FLA, not to the breaker rating.                                                                                |
| **GEC**            | Grounding electrode conductor: connects the service to the ground rod or other electrode.                                                                                         |
| **GFCI**           | Ground-fault circuit interrupter. Trips when residual current exceeds about 5 mA (NEC profile).                                                                                   |
| **Ghost voltage**  | A misleading reading on a high-impedance (10 MΩ) meter caused by capacitive coupling to an open conductor. Emerges from the solver because the meter is stamped into the circuit. |
| **LoZ**            | Low-impedance meter mode (about 3 kΩ) that loads the circuit and makes ghost voltage disappear.                                                                                   |
| **LOTO**           | Lockout/tagout: isolating, locking and verifying zero energy before work. A mechanic, not a cutscene.                                                                             |
| **Live–dead–live** | Testing a meter on a known live source, then the de-energised circuit, then the live source again. Tracked by the safety system.                                                  |
| **MWBC**           | Multiwire branch circuit: two hots sharing one neutral. Losing the neutral causes overvoltage on one leg.                                                                         |
| **NEC**            | National Electrical Code (NFPA 70), the US installation code. The game paraphrases requirements and cites article numbers; it never reproduces NEC text or tables.                |
| **OCPD**           | Overcurrent protective device: a breaker or fuse.                                                                                                                                 |
| **Single-phasing** | A three-phase motor losing one phase. It hums, draws high current on the remaining phases and should trip its overload.                                                           |
| **Split-phase**    | The residential US service: 120/240 V from a centre-tapped transformer.                                                                                                           |

## Controls and automation

| Term                  | Meaning                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| **4–20 mA**           | The analog current-loop standard. 4 mA is the live zero; a broken loop reads 0 mA.                           |
| **FBD**               | Function Block Diagram, an IEC 61131-3 language (P11).                                                       |
| **HMI**               | Human-machine interface: an operator screen bound to PLC tags (P12).                                         |
| **Ladder logic (LD)** | The relay-diagram-style PLC language, with instructions such as XIC, XIO, OTE and TON (P10).                 |
| **PLC**               | Programmable logic controller. Each simulated PLC runs in its own worker, scanning on sim-clock ticks (P10). |
| **PLCopen TC6 XML**   | The open interchange format for IEC 61131 programs; used for import/export.                                  |
| **PNP / NPN**         | Sourcing / sinking transistor sensor outputs. A PNP sensor on a sinking input card never turns the input on. |
| **SCADA**             | Supervisory control and data acquisition: plant-wide HMI, alarms and trends (P12).                           |
| **Scan cycle**        | A PLC's loop: read inputs → execute program → write outputs → housekeeping.                                  |
| **ST**                | Structured Text, the Pascal-like IEC 61131-3 language (P11).                                                 |

## Simulation

| Term                 | Meaning                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **gmin**             | A tiny conductance from every node to ground so islanded sections still produce a solvable matrix.                                                               |
| **Island**           | A set of nodes connected to each other but not to the rest of the circuit. DC and AC islands are solved separately.                                              |
| **MNA**              | Modified nodal analysis: the standard way to assemble circuit equations into a matrix. Controls uses real-valued MNA for DC and complex phasor MNA for 60 Hz AC. |
| **Netlist**          | The electrical graph (nodes and branches) compiled from the physical as-built wiring.                                                                            |
| **Netlist compiler** | The `sim-core` step that union-finds connected terminals and turns conductors and terminations into impedance stamps (P2).                                       |
| **Oracle test**      | A test comparing `sim-core` results with ngspice on random small circuits (P2).                                                                                  |
| **Phasor**           | A complex number representing a sinusoid's magnitude and phase at a fixed frequency. Lets the AC solver skip time-stepping.                                      |
| **Quasi-static**     | Solving steady-state phasors at each update rather than a full time-domain transient. See [ADR 0002](decisions/0002-simulation-architecture.md).                 |
| **Stamp**            | A device's contribution to the MNA matrix. Meters are stamped too, which is why readings are truthful.                                                           |
| **Tick**             | One integer step of sim time (1 kHz). Sim time is always an integer tick count for determinism.                                                                  |
| **Union-find**       | A disjoint-set structure used to merge terminals joined by wires and closed contacts before matrix assembly.                                                     |

## Game and codebase

| Term                    | Meaning                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **As-built**            | The physical wiring the player (or job author) actually installed. The simulator runs the as-built, not the print.                                                        |
| **`.ctrl`**             | The save file: a ZIP of JSON documents with a manifest. See [ADR 0004](decisions/0004-save-format.md).                                                                    |
| **Assisted**            | A world flag set once a cheat command has run (palette, console or script). It persists in the save and is never cleared; assisted runs are excluded from career scoring. |
| **Catalogue reference** | How a save points at a device or prop: `{ id, version }` (e.g. `prop.crate` at version 1), never an inlined copy, so catalogue fixes reach old saves.                     |
| **`catalogVersion`**    | Version of the device catalogue in `content/`. Versioned independently of the app.                                                                                        |
| **Command**             | A registered, Zod-typed action (`wire.connect`, `sim.setSpeed`). The only way the world changes; shared by the palette, keybinds, console and scripting API (P1).         |
| **`extensions` bag**    | A JSON object on the world, each entity, the manifest and settings for data the current schema doesn't model. It must round-trip untouched.                               |
| **Fixture**             | A checked-in example document for a given `schemaVersion` (`libs/domain/save-format/fixtures/`). Every fixture of every version must load forever.                        |
| **Migration chain**     | The pure `n → n+1` steps that upgrade any older document to the current `schemaVersion`. Total: every known version reaches the current one.                              |
| **Print**               | A schematic, wiring diagram or panel layout. A separate document that may be wrong.                                                                                       |
| **Realism charter**     | Plan §3: simulate what can be measured, abstract what can't, cite a `source` for every constant.                                                                          |
| **Region profile**      | The bundle of voltages, frequency, sizing units, colours, symbols and rules for a code region. NEC only through 1.0.                                                      |
| **Replay log**          | The ordered list of executed commands with their sim tick. With the seed, it reproduces a session exactly.                                                                |
| **`schemaVersion`**     | Integer version of the save format, driving the migration chain.                                                                                                          |
| **`settingsVersion`**   | Integer version of the settings document, independent of the save's `schemaVersion`.                                                                                      |
| **Web harness**         | The browser build of `apps/game` (`pnpm start:web`) using `@controls/platform-web`. For development and Playwright, not a shipped product.                                |
| **World document**      | The persistent, serialisable game state (physical model, prints, PLC and HMI documents).                                                                                  |
| **World hash**          | SHA-256 of the canonical JSON (sorted keys, normalised `-0`) of the world document. The same commands from any surface give the same hash (ADR 0007).                     |

## Workspace and tooling

| Term                      | Meaning                                                                                                                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ADR**                   | Architecture decision record, in [`docs/decisions/`](decisions/).                                                                                                                                                                             |
| **`app://`**              | The custom Electron protocol serving the Angular build. Used instead of `file://` so it can send COOP/COEP and CSP headers.                                                                                                                   |
| **CDP attach**            | How `apps/desktop-e2e` tests a packaged build: it starts the binary with `--remote-debugging-port` and connects over the Chrome DevTools Protocol, because the Fuses block Playwright's `_electron`. Selected with `CONTROLS_E2E_EXECUTABLE`. |
| **COOP / COEP**           | Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers. Together they make a page `crossOriginIsolated`.                                                                                                                         |
| **`crossOriginIsolated`** | A browser flag that must be true for `SharedArrayBuffer` to exist.                                                                                                                                                                            |
| **DoD**                   | Definition of Done: the checklist every feature PR meets (plan §9.1, [`CLAUDE.md`](../CLAUDE.md)).                                                                                                                                            |
| **electron-builder**      | Packages the app into installers (NSIS, dmg/zip, AppImage/deb/rpm) and writes `latest*.yml` update metadata.                                                                                                                                  |
| **electron-updater**      | Reads `latest*.yml` from GitHub Releases and applies updates.                                                                                                                                                                                 |
| **Fuses**                 | Electron build-time switches (`@electron/fuses`). Controls disables RunAsNode, `NODE_OPTIONS` and the Node CLI inspect flags, and enables cookie encryption, embedded ASAR integrity and OnlyLoadAppFromAsar.                                 |
| **Module boundaries**     | Nx lint rule `@nx/enforce-module-boundaries` checking imports against project tags (`type:domain` etc.).                                                                                                                                      |
| **`pnpm verify`**         | The one command that runs exactly what CI runs (CI then also runs the e2e suites).                                                                                                                                                            |
| **Preload entry**         | `@controls/ipc-contract/preload`: the narrow import for the sandboxed preload, with channel names and the bridge type only (no Zod).                                                                                                          |
| **SAB**                   | `SharedArrayBuffer`: memory shared between the renderer and workers; used for sim snapshots (P2).                                                                                                                                             |
| **Smoke test**            | `apps/desktop-e2e`: launches the real Electron app and checks `app://`, the version, cross-origin isolation, the CSP, the sandbox and that the viewport starts.                                                                               |
| **Zoneless**              | Angular without zone.js. Change detection runs only when signals change.                                                                                                                                                                      |
