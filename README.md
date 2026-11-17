# Controls

![version](https://img.shields.io/badge/version-0.4.0-blue) ![status](https://img.shields.io/badge/status-Phase%203%20complete-green) ![licence](https://img.shields.io/badge/licence-MIT-green)

**Controls** is a realistic simulation game about the electrical trade, from apprentice electrician to controls engineer. You do the physical work in a 3D world (mount devices, pull and terminate wire, probe with meters, lock out equipment) and the engineering work in docked 2D editors (prints, ladder logic, HMI screens). One physically grounded circuit simulator runs underneath both: **it runs what you wired, not what the print says**.

> **Status: Phase 3 (wires, terminations, enclosures and hand tools) complete on 2026-11-16 and released as [v0.4.0](https://github.com/joebarbere/controls/releases). Next: the Phase 4 kickoff (lights, switches, receptacles, panels and protection).** You can start a sandbox in the workshop, mount boxes and a DIN-rail panel, run NM-B cable along the studs, strip and land every conductor with real tools, and flip the breaker to light a 120 V lamp, from the mouse, keyboard, command palette, dev console or a headless script. Wires heat with the current, and a loose screw shows a measurable voltage drop, runs hot and degrades. See [`plans/phase-3-wiring.md`](plans/phase-3-wiring.md).

## Features

What exists today (Phases 0 to 3):

### Platform

- Electron 45 desktop shell serving the game over a custom `app://` protocol with COOP/COEP and a strict CSP, so the page is `crossOriginIsolated` and `SharedArrayBuffer` is available.
- Hardened defaults: `contextIsolation`, `sandbox` and `webSecurity` on, `nodeIntegration` off, navigation and pop-ups blocked, Electron Fuses set (no RunAsNode, no `NODE_OPTIONS`, ASAR integrity on). The preload exposes a single narrow, typed bridge call whose response is Zod-validated.
- A browser dev harness (`pnpm start:web`) that runs the same Angular 22 zoneless app without Electron.
- An About dialog in the main menu showing the app version, platform, active render backend and whether the page is cross-origin isolated.

### Interface

- A main menu over the live 3D view (Resume and Save game while playing, New sandbox, Continue, Load, Settings, About, Quit). Escape returns to it from the game.
- A docking workspace: the 3D viewport with an Inspector panel and a Console panel. Panels resize with the mouse or keyboard, collapse, and reset to defaults.
- A HUD showing the interaction mode, the selection and an **Assisted** badge for worlds where cheats were used.
- Settings for theme, reduced motion, renderer, pixel-ratio cap, volumes, look sensitivity, invert Y, display units, default difficulty and autosave (on or off, how often, how many slots); region is fixed to NEC. Settings are saved and survive a restart.
- Light and dark themes that follow your system, and reduced motion.
- Keyboard-first: everything works without a mouse, with visible focus, and focus returns to where it was after a dialog. Notifications are announced to screen readers and can be dismissed from the keyboard.
- Rebindable keys for every command and every movement key (Settings → Key bindings…), with conflicts shown rather than hidden and `Mod` as Cmd on macOS. Keys never fire while you type.
- A tool belt: keys 1–9 or the belt bar at the bottom of the viewport pick a slot, and the HUD shows what it holds. A prop is placed; a hand tool (wire and NM cable strippers, diagonal cutters, screwdriver, two torque screwdrivers, crimper, nut driver, label printer, drill bits, hole saws, a knockout punch, a fish tape) is held, and a driver must fit the screw it turns. Choose what each slot holds in Settings → Tool belt.
- Time control: the simulation runs in its own worker, off the page, and a new game starts paused. **P** pauses and resumes, **Shift+1**, **Shift+2** and **Shift+3** run at 1×, 10× and 60× real time, and **.** and **Shift+.** step 10 ms and 1 s; the palette and the console reach the same commands (`sim.setSpeed`, `sim.resume`, `sim.step`). The HUD shows the sim time, the speed as a radio group and the speed actually achieved, says when the simulation is falling behind or catching up, and suspends it while the window is hidden. If the simulation fails, it pauses with a **Restart simulation** button and your world is untouched.
- A command palette (Ctrl+K or Ctrl+Shift+P, Cmd on macOS): fuzzy search over every command, recent commands first, unavailable ones shown with the reason, and a form for each command's arguments with inline validation. Cheats ask before they mark your world as assisted. Works with the arrow keys, Enter and Esc alone.
- A dev console (backtick) in Sandbox and dev builds: type `verb.noun --flag value` lines with Tab completion for commands, flags and values, recall earlier lines with ↑/↓ (kept across restarts), read `help [id]` generated from the commands themselves, print `world.hash` or `netlist.dump`, and `run` a console-line file you pick or drop. Errors point at the column, and a banner warns before a cheat marks the save as assisted.

### Rendering

- Three.js r186 viewport using `WebGPURenderer` with automatic WebGL2 fallback.
- A workshop sandbox level: an open 2×4 stud wall at 16 in centres, a plywood backboard with a backplate and two TS35 DIN rails, and a workbench, all built procedurally from a level document (`content/levels/workshop.json`). New sandbox asks for a seed (a fresh random one, or type your own to replay a world).
- Two camera modes. Work mode focuses a target and orbits and pans within limits. Walk mode is first person, with WASD, mouse look and pointer lock. V switches mode and F focuses the selection, both through logged commands (`view.mode`, `view.focus`); all of these keys can be rebound.
- The viewport draws the world document by entity id: placed objects appear, move and disappear as commands run (undo and redo included), as procedural props that share geometry, and removing them returns GPU memory to where it was.
- Placement with a snapping ghost preview: pick a prop (1–9), aim, click or press Enter to place it; drag an object (or select it, M, Enter) to move it; Delete removes it; Escape cancels. Each commit is exactly one command, so the mouse reaches the same `world.hash` as the equivalent console lines.
- Hover and click selection through BVH picking, with keyboard cycling (`[` and `]`). The viewport draws only when something changes (idle behind the menu); a frame-time HUD shows in dev builds.
- Procedural 3D models of the bench battery, the bench supply and the DIN-rail supply, sized from their catalogue entries and labelled with their fictional brands.
- The lamp glows with its solved light output; a lamp whose circuit isn't solved is shown as unknown, never as an off lamp.
- Debug overlays (sandbox and dev builds): `view.overlay voltage|current|heat` colours leads, wires and terminals by voltage on a fixed scale per nominal system, animates current along the leads (direction for DC, magnitude for AC), or colours wires and leads by temperature (each half by its hottest point, a loose termination lighting its own end) on a scale from ambient through the insulation rating and the overheat point to melting, with a text legend; unsolved circuits show "no reading", never 0 V, and reduced motion keeps the arrows still.
- Netlist inspector (sandbox and dev builds): `view.netlistInspector` docks a keyboard-navigable tree of every circuit's nodes (with their terminals) and branches in the side panel, with live voltage and current up to ten times a second and each circuit's status and voltage class; selecting a node highlights its terminals in 3D. T on a branch draws a live trace of its current, sampled at every solve, so the lamp's cold-filament inrush shows (a text summary of peak and latest; still under reduced motion).
- Integer-millimetre snap maths for DIN rails (17.5 mm modules), the backplate grid, wall studs and bench tops, with a cited source for every real-world dimension. It lives in the world model and reads the level's fixtures, so scripts snap exactly like the mouse.

### Wiring

- Real building wire in the catalogue: THHN/THWN-2 copper from 14 AWG to 4/0 (solid and stranded), MTW from 18 to 10 AWG, aluminium XHHW-2, and NM-B cable from 14/2 to 6/3 with ground, plus insulated ferrules and ring and fork lugs, all under fictional brands with a source for every value. A conductor's resistance is worked out from its metal, size, cut length and temperature, never looked up in a table, and so is its ampacity.
- Boxes and a panel to wire into: 1-gang and 2-gang device boxes, a 4 in square junction box, a round ceiling box and a DIN-rail panel enclosure with a backplate and two rails, each with its knockouts and cable clamps. Slotted wire duct with covers, EMT conduit (sticks cut to length, elbows and connectors that snap into an open knockout), screw, spring-cage and ground DIN terminal blocks, and wire nuts.
- Place catalogue devices with the mouse or the reticle: they snap onto DIN-rail module slots, the backplate grid or a box's yoke and record what they are mounted on; nothing can be placed overlapping a box or a mounted device, and a box or panel that still holds devices or cables can't be moved or deleted.
- Route a wire with two picks: put a spool of building wire on the tool belt (Settings → Tool belt → Spools), pick its number, then click two terminals. The viewport previews the route the router proposes (through the ducts where there are some) and adds exactly one `wire.add`, so the mouse, the keyboard, the palette and the console make the same wire. Click off any terminal to add a waypoint, Backspace steps back and Escape cancels (again to put the spool away). Keyboard: `[`/`]` pick a device, Tab and Shift+Tab cycle its terminals and Enter picks; where terminals are too close together to aim at, Z zooms in on them. A hint says what the next pick does, and every pick, waypoint and finished wire is announced.
- Land each end of a wire with your tools: above Trainee every terminal you pick opens a termination prompt, one strip-and-finish step (the method, a hole in your strippers, the strip length, an optional ferrule or lug with the crimper's die) and one tighten step (your screwdriver, and the torque setting if it is a torque screwdriver; a plain screwdriver is tightened by feel). Apprentice fills in the right hole, die and torque for you to confirm; Journeyman and Realistic leave them blank. The terminal's marked strip length and torque are shown, a mistake the command won't accept (the wrong driver, a setting outside the tool's range, a lug that doesn't fit) is explained in the prompt before anything is logged, and the route is still exactly one `wire.add`. Trainee lands both ends automatically. Keyboard-operable: Enter goes on, Escape backs out of the pick.
- Run NM-B cable by hand: put a cable spool on the tool belt, click a box's open entry (or select the box, Tab to an entry, Enter), staple it along the studs with a click on each stud, and click the far box or panel. The support rule is shown as you go, and the run is checked before it is cut. Then strip each end's jacket in the prompt that follows (J reopens it), and land each conductor's tail on a terminal (L, or the palette) with the same termination prompts as a wire; the next conductor follows. Label a wire or cable with the label printer (Shift+L, or a click with the printer in hand).
- NM-B in stud walls follows the code's support rules: stapled within 12 in of each box and every 4-1/2 ft, bored only with bits a stud can take, and a stripped tail only reaches as far as it was stripped.
- Pull wire through conduit with the fish tape: select a conduit run and press U (or use the palette, or click it with the fish tape in hand), choose the conductors and colours, then feed the tape: F feeds, T twists it round each elbow, R pulls it back, and once it is through P pulls the conductors. Jam it at one spot too often and the tape kinks (nothing is pulled; try again); Trainee can skip the game. Only a successful pull is logged, as one `wire.pull`. With a screwdriver, knockout punch, hole saw or drill bit in hand, click a box's entry (or Tab to it and press Enter) to open it, while a click anywhere else still selects; a hole saw or punch that doesn't fit the entry's trade size is refused before anything happens.
- Wires drawn where they are routed: every conductor and cable follows the routing bake out of its terminals, along its lane in the ducts and conduit, with a slight sag across open spans and a coil where it was cut well long, in its insulation colour and finish and at its catalogue size, with sleeve markers on labelled wires. NM-B cable is drawn flat at its real size, its jacket ending where it was stripped and each conductor's tail running on to its terminal. A panel's wires cost one draw per insulation type, however many there are.
- A 120 V lamp circuit built the way an electrician builds it, in the game or headless: a DIN-rail panel with a breaker and terminal blocks, 14/2 NM-B stapled to the studs and bored through them, wire-nut splices in a junction box, every knockout, strip and torque done with its tool, and the breaker lights the lamp; its voltage drop and a loose screw's hot spot match hand calculations, and it reaches the same `world.hash` in Node, the browser and the desktop app.

### Simulation

- Batteries that run down: the EMF follows the state of charge (a new 12 V lead-acid battery rests at 12.9 V), behind its internal resistance, and the charge delivered is counted every millisecond and kept in saves.
- A bench DC supply (0–30 V, 0–5 A) with a voltage setpoint, a current limit and an output switch, and a clean constant-voltage/constant-current crossover; a 24 V DIN-rail supply whose overload protection hiccups (off for a second, then retry).
- Mains supplies, placed from the console or scripts for now and drawn as a service cabinet with a lug per terminal: a 120/240 V split-phase utility service and 208Y/120 V and 480Y/277 V three-phase services, each behind its transformer's impedance (so a short draws its real fault current), and the ANSI C84.1 voltage ranges.
- An incandescent lamp with a real tungsten filament: its resistance rises as it heats, so switching on a cold lamp draws a surge of about 14 times its running current, and its light follows the filament's temperature. Switched off, the filament cools by radiation and through its lead-in wires, so a lamp switched back on five seconds later already surges nearly as much as a cold one. A power resistor that says when it is over its rating, and a 12 V heater element.
- Protection that behaves like the real thing: a 1 A fast-acting fuse that heats with the current and blows (in under a millisecond on a dead short, never below its minimum fusing current) and stays blown until replaced, and a 15 A thermal-magnetic breaker with a slow thermal trip on overload, an instantaneous magnetic trip on a short, and a handle that must go off and on again to reset it.
- Wires, test leads and their terminations heat with the current (the heat overlay shows it): a screw landed loose runs hot, degrades for good once it passes 149 °C, then glows, flickers open and shut, arcs and burns open; a wire or lead driven to its metal's melting point fuses, and its insulation is flagged damaged past its rating. An overheating termination or damaged insulation is reported as a sim event.
- `wire.info <id>` in the dev console and in scripts: a wire's or test lead's current, resistance at its temperature, the voltage drop along it and at each end, each end's temperature and state, the same text headless and in the game; the netlist inspector shows the same drops and temperatures on each wire's row.
- Wire readout (sandbox and dev builds): in work mode, hover a wire (or select one with N and Shift+N) to see its current, the drop along it and at each end, its conductor's and each end's temperature, and its state (normal, overheating, degrading, intermittent, arcing, open, fused, insulation damaged). A gap never reads 0 V, and nothing is shown as a value without a reading.
- Honest readings: a device's record says whether its circuit was solved, and an unsettled solve is never shown as a steady value.
- `netlist.dump` in the dev console and in scripts: the compiled netlist, why each island was or wasn't solved, and its voltage class (12 V or 24 V DC, 120/240 V, 208Y/120 V, 480Y/277 V, from its sources' nameplates), the same text headless and in the game.

### Commands and world

- One command registry for every way of changing the world. Commands validate their arguments, and invalid ones change nothing. Undo and redo cover every world change, and deleting then undoing brings an object back with the same id.
- A replay log of every successful command (undo, redo and view actions included). Replaying it from the starting world reproduces the session exactly, which is what makes bug reports and headless tests reproducible.
- `world.hash`: a SHA-256 fingerprint of the world that is identical in Node and in the browser. Seeded randomness (sfc32) means the same seed and commands always give the same world.
- World commands so far: place, move, rotate and delete objects, in integer millimetres and millidegrees, and mount them on a rail, backplate or box; connect devices with test leads; operate a device (flip a switch, set a supply); add, route, land, unland, re-route, label and delete wires and cables, strip a cable's jacket, open a box's entries, cut duct and conduit to length and pull conductors through conduit (`wire.*`, `cable.*`, `enclosure.openEntry`, `raceway.cut`); every one done with a tool checks that the tool can do it. The mouse, keybindings, the command palette, the dev console and scripts all drive them: select a switch and press E, or double-click it, to flip it.
- A scripting API: TypeScript scripts and console-line files (`entity.move 1 --positionMm.x 150 …`) drive the game through the same registry as the UI, which itself runs on the same `Game` object, so every surface reaches the same `world.hash`.

### Saves

- Versioned save-format schemas (`schemaVersion` 3: manifest, world, replay log; the world holds devices, test leads, wires, cables and how each end was terminated, with its temperatures) and a settings schema, validated with Zod. They come with a total migration chain from version 1, fixtures that must load forever, lossless JSON round-trip property tests and exported JSON Schema. Saves from 0.3.0 load and continue with a fresh replay log.
- Save and load in the game: name a save from the menu or with Ctrl+S, pick one from the Load list (Ctrl+L), save to or open a file anywhere (Ctrl+Shift+S, Ctrl+O; Cmd on macOS), or Continue the game you were last in. A loaded game carries on with the same replay log and an empty undo history, and a save that can't be loaded is refused with a plain reason, leaving your game as it was. However long the session, a save's log starts at a checkpoint taken every 10 s of sim time, so loading checks it (replays the last few seconds) instead of skipping the check.
- Autosave to rotating slots on a timer, when you return to the menu, before another game is loaded and when you quit, only when there are unsaved changes (a game opened from a file elsewhere is copied in, so Continue can resume it). Continue skips a damaged save and says so.
- Crash recovery in the desktop app: if the game window crashes it reloads, and the menu offers Continue from your latest autosave; repeated crashes stop with a Retry or Quit prompt, and a window that stops responding offers Wait or Reload.
- `.ctrl` save files: a ZIP of the save's JSON documents plus a small picture of the view, with byte-identical output for the same game and a reader that refuses damaged, oversized, malicious or newer-version files with a clear reason. Scripts and `pnpm sim` can write, load, hash and replay them too.
- Save storage underneath it: a save folder in the desktop app's user data (named saves and rotating autosave slots), native Open and Save As dialogs, atomic writes that leave the previous save intact if anything fails, and no file paths ever exposed to the game. The browser harness keeps saves in the browser's private file storage.

### Tooling

- Nx 24 + pnpm 11 monorepo with enforced module boundaries.
- `pnpm verify` runs exactly what CI runs, including the Prettier format check.
- `sim-cli` runs the game headless in plain Node: `pnpm sim run <script>` (TypeScript or console lines; `--world content/levels/workshop.json` to run on the workshop, `--difficulty journeyman` for a harder start), `pnpm sim replay <log>` and `pnpm sim hash <world>` print the world hash, and `--expect` turns any of them into a check. See the [scripting guide](docs/guides/scripting.md).
- `sim-cli` runs the circuit engine headless too (P2, F2.3a): scripts and console files let sim time pass (`game.advance`, `sim.step`), probe the circuit they wired with an ideal voltmeter (`game.probe('1:pos', '1:neg')`), and pin byte-identical snapshots of the simulation, the same in Node and in the browser. `game.device(id)` reads a device's record (a lamp's light output, a resistor's power). Circuits the simulator can't solve (a mixed AC and DC circuit, or one it can't settle) are reported as unsolved or unsettled, never as a 0 V reading.
- An ngspice oracle for the circuit solvers: 500 DC and 500 AC random circuits with ngspice's results, checked in and compared with sim-core's DC and phasor solvers on every `pnpm verify`, so it needs no ngspice; `pnpm sim oracle regen` refreshes them. `pnpm sim bench` times the netlist compiler and the re-solve after a switch toggle (compile plus sparse solve, warm and cold factorisation cache) on a 2,000-node synthetic plant inside `pnpm verify`, reporting each case's median and p90, and gates the wired plant too: a tick with 2,000 heating conductors, the re-solve after an intermittent connection toggles, baking 500 wire routes and the costliest single `cable.add`. See the [oracle guide](docs/guides/oracle.md).
- Playwright end-to-end tests: the browser harness (`apps/game-e2e`) and an Electron smoke suite (`apps/desktop-e2e`). The smoke suite can also attach to a packaged build.
- GitHub Actions: `pr.yml` and `main.yml` both call one reusable workflow, `ci.yml` (verify and both e2e suites on Windows, macOS and Linux), so a pull request runs exactly what `main` runs; and `release.yml` (tag → installers for all three OSes in a draft GitHub Release, each smoke-tested, with auto-update metadata).

## Platforms

Windows (NSIS installer), macOS (universal dmg/zip) and Linux (AppImage, deb, rpm), distributed through [GitHub Releases](https://github.com/joebarbere/controls/releases) with auto-update.

**Builds are unsigned for now.** Windows SmartScreen will warn ("More info" → "Run anyway"). macOS Gatekeeper will block the first launch (right-click the app → Open, or allow it under System Settings → Privacy & Security), and macOS auto-update is disabled until the app is signed. Linux AppImage auto-update works unsigned. A signing decision is due before 1.0.

## Quick start

Requires Node 24 LTS (see `.nvmrc`) and pnpm 11 via Corepack.

```bash
corepack enable
pnpm install
pnpm exec playwright install chromium   # once, for the e2e tests
pnpm start          # build the game + desktop shell and launch Electron
pnpm start:web      # browser dev harness (nx serve game)
pnpm verify         # everything CI runs: format check, lint, typecheck, test, build, bench, version sync
pnpm e2e            # Playwright against the browser harness
pnpm e2e:desktop    # Playwright smoke test against the built Electron app
```

More in the [new-developer guide](docs/guides/new-developer-guide.md).

### Try the wiring

A new sandbox starts in the workshop with tool-belt slots 1–3 holding props (box, crate, spool); the wiring tools go in slots 4 and up.

- **See a finished circuit:** press **Ctrl+O** and open a frozen save from `libs/domain/save-format/fixtures/v3/ctrl/`, for example `lamp-circuit-engine-7-catalog-2.ctrl` (supply → DIN panel and breaker → NM-B cable → junction box → lamp). Its breaker is off: press **`** for the console, run `device.operate --control on --id 3 --value true`, then press **P** to run the sim. Hover a wire for its readout; **Ctrl+K** → "Show or hide a debug overlay" switches on the voltage, current or heat overlay. `bad-termination-…ctrl` has a loose screw that runs hot.
- **Wire it yourself:** in **Settings**, set _Default for new games_ to _Trainee_ (no strip and torque prompts) and put a spool, such as 14 AWG THHN, in tool-belt slot 4. Start a new sandbox, place two terminal blocks (`entity.place --ref.id tb.quennick-st4 --ref.version 1 --positionMm.x -100 --positionMm.y 0 --positionMm.z 40` in the console, then again at `x -88`), press **4** and click one terminal, then the other. **Z** zooms in on crowded terminals, **Backspace** steps back and **Esc** cancels. At Journeyman and Realistic each end opens a strip-and-torque prompt.
- **Keyboard only:** **4** arms the spool, **[** and **]** pick a device, **Tab** cycles its terminals and **Enter** picks one.
- **Scripted:** every scenario in [`apps/sim-cli/scenarios/`](apps/sim-cli/scenarios/) runs in the game console with `run` (choose the `.console` file) or headless with `pnpm sim run <file> --world content/levels/workshop.json`.

## TODO

The roadmap is in [`controls-development-plan.md`](controls-development-plan.md) §6. Each phase ships a minor release.

- [ ] **P4 Lights, switches, receptacles, panels, protection** (v0.5.0): first playable sandbox
- [ ] **P5 Instruments, safety, faults, Apprentice career** (v0.6.0)
- [ ] **P6 Three-phase, control circuits, relays, timers, prints** (v0.7.0)
- [ ] **P7 Contactors, overloads, motors, starters** (v0.8.0)
- [ ] **P8 Pumps, actuators, process simulation** (v0.9.0)
- [ ] **P9 Sensors and instrumentation** (v0.10.0)
- [ ] **P10 PLC I: hardware, runtime, ladder** (v0.11.0)
- [ ] **P11 PLC II: Structured Text, FBD, PID, VFD** (v0.12.0)
- [ ] **P12 Networking, SCADA/HMI, alarms, trends** (v0.13.0)
- [ ] **P13 Campaign completion, polish, signing, modding** (v1.0.0)
- [ ] **After 1.0:** the IEC region profile, then the power-systems expansions X0–X9 (lineworkers, industrial plants, substations, renewables, AI datacenters, high-rises, big-science and pulsed-power sites, power plants and small modular reactors, and future cities out to 3026), proposed in [`plans/expansion-power-systems.md`](plans/expansion-power-systems.md)

## Documentation

| Where                                                          | What                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`docs/README.md`](docs/README.md)                             | Documentation hub: start here                                       |
| [`controls-development-plan.md`](controls-development-plan.md) | The spec: vision, realism charter, architecture, roadmap            |
| [`docs/architecture/`](docs/architecture/overview.md)          | How it fits together (process model, module boundaries)             |
| [`docs/decisions/`](docs/decisions/)                           | Architecture decision records                                       |
| [`docs/caveats/`](docs/caveats/README.md)                      | Per-area gotchas; read before changing an area                      |
| [`docs/research/`](docs/research/)                             | Background research: stack, solvers, PLC/SCADA, domain realism      |
| [`plans/`](plans/)                                             | Per-phase plans with feature checklists, and the expansion proposal |
| [`CHANGELOG.md`](CHANGELOG.md)                                 | Release notes (Keep a Changelog)                                    |
| [`CLAUDE.md`](CLAUDE.md)                                       | Working agreements for AI-assisted development                      |

## Project layout

```
apps/
  game/            Angular 22 zoneless app: assembles the features and injects the platform
  game-e2e/        Playwright tests against the browser harness
  desktop/         Electron main + preload (esbuild), app:// protocol, electron-builder config
  desktop-e2e/     Playwright _electron smoke tests against the built app
  sim-cli/         headless Node CLI (esbuild bundle): run scripts, replay logs, hash worlds, bench, oracle; scenarios/
libs/
  domain/units/    framework-free domain lib: length and angle conversions, the generated app version
  domain/save-format/  save and settings schemas (Zod), migrations, fixtures, JSON Schema
  domain/commands/     command registry, bus, undo/redo, replay log, `when` expressions
  domain/world-model/  world commands (wiring, mounting, tools), routing maths and bake, snapping, world.hash (SHA-256), seeded PRNG (sfc32)
  domain/catalog/      the device, conductor, cable, tool and accessory catalogue and its tables, loaded from content/
  domain/sim-core/     the circuit simulator: netlist compiler, DC and phasor solvers, device models, contact and thermal models
  domain/sim-protocol/ the worker contract: messages, snapshot layout, records, events
  domain/scripting-api/  the Game facade shared by the UI session and scripts, console-line files
  ipc-contract/    IPC channel names, Zod schemas and the preload bridge type
  sim-worker/      the Web Worker that runs sim-core off the page
  rendering/renderer/  framework-free Three.js scene
  ui/              Angular design system: tokens, dialog, focus trap, splitter, toasts
  features/        Angular features: shell (menu, HUD, notifications), workspace (docking, viewport), settings, session (world signal, exec), palette, console (dev console), saves (save, load, autosave)
  platform/        api (interfaces), electron and web implementations
content/           catalogue data (devices/, cables/, accessories/, tools/, tables/) and levels (levels/workshop.json)
docs/  plans/  tools/  .claude/
```

## Licence

[MIT](LICENSE) © 2026 Joe Barbere. Third-party components are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Device brands, PLC families and model numbers in the game are fictional.
