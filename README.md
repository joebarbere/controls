# Controls

![version](https://img.shields.io/badge/version-0.2.0-blue) ![status](https://img.shields.io/badge/status-Phase%201%20shipped-green) ![licence](https://img.shields.io/badge/licence-MIT-green)

**Controls** is a realistic simulation game about the electrical trade, from apprentice electrician to controls engineer. You do the physical work in a 3D world (mount devices, pull and terminate wire, probe with meters, lock out equipment) and the engineering work in docked 2D editors (prints, ladder logic, HMI screens). One physically grounded circuit simulator runs underneath both: **it runs what you wired, not what the print says**.

> **Status: Phase 1 (Game shell) shipped as v0.2.0 on 2026-10-29.** You can start a sandbox in the workshop, look around, place, move and delete props, and save and load, from the mouse, keyboard, command palette, dev console or a headless script. There is no circuit simulation yet. Next: Phase 2, the circuit engine and power sources. See [`plans/phase-1-game-shell.md`](plans/phase-1-game-shell.md).

## Features

What exists today (Phases 0 and 1):

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
- A tool belt: keys 1–9 pick a slot, and the HUD shows what it holds. The viewport places the slot's prop.
- A command palette (Ctrl+K or Ctrl+Shift+P, Cmd on macOS): fuzzy search over every command, recent commands first, unavailable ones shown with the reason, and a form for each command's arguments with inline validation. Cheats ask before they mark your world as assisted. Works with the arrow keys, Enter and Esc alone.
- A dev console (backtick) in Sandbox and dev builds: type `verb.noun --flag value` lines with Tab completion for commands, flags and values, recall earlier lines with ↑/↓ (kept across restarts), read `help [id]` generated from the commands themselves, print `world.hash`, and `run` a console-line file you pick or drop. Errors point at the column, and a banner warns before a cheat marks the save as assisted.

### Rendering

- Three.js r186 viewport using `WebGPURenderer` with automatic WebGL2 fallback.
- A workshop sandbox level: an open 2×4 stud wall at 16 in centres, a plywood backboard with a backplate and two TS35 DIN rails, and a workbench, all built procedurally from a level document (`content/levels/workshop.json`). New sandbox asks for a seed (a fresh random one, or type your own to replay a world).
- Two camera modes. Work mode focuses a target and orbits and pans within limits. Walk mode is first person, with WASD, mouse look and pointer lock. V switches mode and F focuses the selection, both through logged commands (`view.mode`, `view.focus`); all of these keys can be rebound.
- The viewport draws the world document by entity id: placed objects appear, move and disappear as commands run (undo and redo included), as procedural props that share geometry, and removing them returns GPU memory to where it was.
- Placement with a snapping ghost preview: pick a prop (1–9), aim, click or press Enter to place it; drag an object (or select it, M, Enter) to move it; Delete removes it; Escape cancels. Each commit is exactly one command, so the mouse reaches the same `world.hash` as the equivalent console lines.
- Hover and click selection through BVH picking, with keyboard cycling (`[` and `]`). The viewport draws only when something changes (idle behind the menu); a frame-time HUD shows in dev builds.
- Integer-millimetre snap maths for DIN rails (17.5 mm modules), the backplate grid, wall studs and bench tops, with a cited source for every real-world dimension. It lives in the world model and reads the level's fixtures, so scripts snap exactly like the mouse.

### Commands and world

- One command registry for every way of changing the world. Commands validate their arguments, and invalid ones change nothing. Undo and redo cover every world change, and deleting then undoing brings an object back with the same id.
- A replay log of every successful command (undo, redo and view actions included). Replaying it from the starting world reproduces the session exactly, which is what makes bug reports and headless tests reproducible.
- `world.hash`: a SHA-256 fingerprint of the world that is identical in Node and in the browser. Seeded randomness (sfc32) means the same seed and commands always give the same world.
- World commands so far: place, move, rotate and delete objects, in integer millimetres and millidegrees. The mouse, keybindings, the command palette, the dev console and scripts all drive them.
- A scripting API: TypeScript scripts and console-line files (`entity.move 1 --positionMm.x 150 …`) drive the game through the same registry as the UI, which itself runs on the same `Game` object, so every surface reaches the same `world.hash`.

### Saves

- Versioned save-format schemas (`schemaVersion` 1: manifest, world, replay log) and a settings schema, validated with Zod. They come with a total migration chain, fixtures that must load forever, lossless JSON round-trip property tests and exported JSON Schema.
- Save and load in the game: name a save from the menu or with Ctrl+S, pick one from the Load list (Ctrl+L), save to or open a file anywhere (Ctrl+Shift+S, Ctrl+O; Cmd on macOS), or Continue the game you were last in. A loaded game carries on with the same replay log and an empty undo history, and a save that can't be loaded is refused with a plain reason, leaving your game as it was.
- Autosave to rotating slots on a timer, when you return to the menu, before another game is loaded and when you quit, only when there are unsaved changes (a game opened from a file elsewhere is copied in, so Continue can resume it). Continue skips a damaged save and says so.
- `.ctrl` save files: a ZIP of the save's JSON documents plus a small picture of the view, with byte-identical output for the same game and a reader that refuses damaged, oversized, malicious or newer-version files with a clear reason. Scripts and `pnpm sim` can write, load, hash and replay them too.
- Save storage underneath it: a save folder in the desktop app's user data (named saves and rotating autosave slots), native Open and Save As dialogs, atomic writes that leave the previous save intact if anything fails, and no file paths ever exposed to the game. The browser harness keeps saves in the browser's private file storage.

### Tooling

- Nx 24 + pnpm 11 monorepo with enforced module boundaries.
- `pnpm verify` runs exactly what CI runs, including the Prettier format check.
- `sim-cli` runs the game headless in plain Node: `pnpm sim run <script>` (TypeScript or console lines; `--world content/levels/workshop.json` to run on the workshop), `pnpm sim replay <log>` and `pnpm sim hash <world>` print the world hash, and `--expect` turns any of them into a check. See the [scripting guide](docs/guides/scripting.md).
- An ngspice oracle for the circuit solvers: 500 DC and 500 AC random circuits with ngspice's results, checked in and compared with sim-core's DC and phasor solvers on every `pnpm verify`, so it needs no ngspice; `pnpm sim oracle regen` refreshes them. `pnpm sim bench` times the netlist compiler and the re-solve after a switch toggle (compile plus sparse solve, warm and cold factorisation cache) on a 2,000-node synthetic plant inside `pnpm verify`, reporting each case's median and p90. See the [oracle guide](docs/guides/oracle.md).
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
pnpm verify         # everything CI runs: format check, lint, typecheck, test, build, version sync
pnpm e2e            # Playwright against the browser harness
pnpm e2e:desktop    # Playwright smoke test against the built Electron app
```

More in the [new-developer guide](docs/guides/new-developer-guide.md).

## TODO

The roadmap is in [`controls-development-plan.md`](controls-development-plan.md) §6. Each phase ships a minor release.

- [ ] **P2 Circuit engine and power sources** (v0.3.0): netlist compiler, DC and phasor MNA in a worker
- [ ] **P3 Wires, terminations, enclosures, hand tools** (v0.4.0)
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

## Documentation

| Where                                                          | What                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------- |
| [`docs/README.md`](docs/README.md)                             | Documentation hub: start here                                  |
| [`controls-development-plan.md`](controls-development-plan.md) | The spec: vision, realism charter, architecture, roadmap       |
| [`docs/architecture/`](docs/architecture/overview.md)          | How it fits together (process model, module boundaries)        |
| [`docs/decisions/`](docs/decisions/)                           | Architecture decision records                                  |
| [`docs/caveats/`](docs/caveats/README.md)                      | Per-area gotchas; read before changing an area                 |
| [`docs/research/`](docs/research/)                             | Background research: stack, solvers, PLC/SCADA, domain realism |
| [`CHANGELOG.md`](CHANGELOG.md)                                 | Release notes (Keep a Changelog)                               |
| [`CLAUDE.md`](CLAUDE.md)                                       | Working agreements for AI-assisted development                 |

## Project layout

```
apps/
  game/            Angular 22 zoneless app: assembles the features and injects the platform
  game-e2e/        Playwright tests against the browser harness
  desktop/         Electron main + preload (esbuild), app:// protocol, electron-builder config
  desktop-e2e/     Playwright _electron smoke tests against the built app
  sim-cli/         headless Node CLI (esbuild bundle): run scripts, replay logs, hash worlds; scenarios/
libs/
  domain/units/    framework-free domain lib: length and angle conversions, the generated app version
  domain/save-format/  save and settings schemas (Zod), migrations, fixtures, JSON Schema
  domain/commands/     command registry, bus, undo/redo, replay log, `when` expressions
  domain/world-model/  world commands, world.hash (SHA-256), seeded PRNG (sfc32)
  domain/scripting-api/  the Game facade shared by the UI session and scripts, console-line files
  ipc-contract/    IPC channel names, Zod schemas and the preload bridge type
  rendering/renderer/  framework-free Three.js scene
  ui/              Angular design system: tokens, dialog, focus trap, splitter, toasts
  features/        Angular features: shell (menu, HUD, notifications), workspace (docking, viewport), settings, session (world signal, exec), palette, console (dev console), saves (save, load, autosave)
  platform/        api (interfaces), electron and web implementations
content/           level data (levels/workshop.json)
docs/  plans/  tools/  .claude/
```

## Licence

[MIT](LICENSE) © 2026 Joe Barbere. Third-party components are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Device brands, PLC families and model numbers in the game are fictional.
