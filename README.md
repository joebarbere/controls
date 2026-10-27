# Controls

![version](https://img.shields.io/badge/version-0.1.0-blue) ![status](https://img.shields.io/badge/status-Phase%200%20complete-green) ![licence](https://img.shields.io/badge/licence-MIT-green)

**Controls** is a realistic simulation game about the electrical trade, from apprentice electrician to controls engineer. You do the physical work in a 3D world (mount devices, pull and terminate wire, probe with meters, lock out equipment) and the engineering work in docked 2D editors (prints, ladder logic, HMI screens). One physically grounded circuit simulator runs underneath both: **it runs what you wired, not what the print says**.

> **Status: Phase 0 (Foundation) complete, version 0.1.0.** Nothing playable yet. The workspace, Electron shell, 3D viewport, CI (green on Windows, macOS and Linux) and draft-release pipeline are in place. Next: Phase 1, the game shell (UI, commands, cameras, save/load). See [`plans/phase-0-foundation.md`](plans/phase-0-foundation.md).

## Features

What exists today (Phase 0 scaffold):

### Platform

- Electron 45 desktop shell serving the game over a custom `app://` protocol with COOP/COEP and a strict CSP, so the page is `crossOriginIsolated` and `SharedArrayBuffer` is available.
- Hardened defaults: `contextIsolation`, `sandbox` and `webSecurity` on, `nodeIntegration` off, navigation and pop-ups blocked, Electron Fuses set (no RunAsNode, no `NODE_OPTIONS`, ASAR integrity on). The preload exposes a single narrow, typed bridge call whose response is Zod-validated.
- A browser dev harness (`pnpm start:web`) that runs the same Angular 22 zoneless app without Electron.
- An about box showing the app version, platform, active render backend and whether the page is cross-origin isolated.

### Rendering

- Three.js r186 viewport using `WebGPURenderer` with automatic WebGL2 fallback, showing a procedurally built sub-panel with two TS35 DIN rails.
- Two camera modes. Work mode focuses a target and orbits and pans within limits. Walk mode is first person, with WASD, mouse look and pointer lock. Press V to switch and F to focus the selection; movement keys are rebindable input actions.
- Hover and click selection through BVH picking, with keyboard cycling (`[` and `]`). A frame-time HUD shows in dev builds.
- Integer-millimetre snap maths for DIN rails, the backplate grid and wall studs, with a cited source for every real-world dimension. Placement through commands follows.

### Saves

- Versioned save-format schemas (`schemaVersion` 1: manifest, world, replay log) and a settings schema, validated with Zod. They come with a total migration chain, fixtures that must load forever, lossless JSON round-trip property tests and exported JSON Schema. Saving and loading in the game arrive later in P1.

### Tooling

- Nx 24 + pnpm 11 monorepo with enforced module boundaries.
- `pnpm verify` runs exactly what CI runs, including the Prettier format check.
- Playwright end-to-end tests: the browser harness (`apps/game-e2e`) and an Electron smoke suite (`apps/desktop-e2e`). The smoke suite can also attach to a packaged build.
- GitHub Actions: `pr.yml` (verify and both e2e suites on Linux), `main.yml` (the same on Windows, macOS and Linux) and `release.yml` (tag → installers for all three OSes in a draft GitHub Release, each smoke-tested, with auto-update metadata).

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

- [ ] **P0 Foundation** (v0.1.0): workspace, Electron shell, viewport, CI, release pipeline, docs, Claude agents
- [ ] **P1 Game shell** (v0.2.0): UI, command palette, keybinds, dev console, scripting API, cameras, save/load
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
  game/            Angular 22 zoneless app (HUD, menus, editors)
  game-e2e/        Playwright tests against the browser harness
  desktop/         Electron main + preload (esbuild), app:// protocol, electron-builder config
  desktop-e2e/     Playwright _electron smoke tests against the built app
libs/
  domain/units/    framework-free domain lib; today only the generated app version
  domain/save-format/  save and settings schemas (Zod), migrations, fixtures, JSON Schema
  ipc-contract/    IPC channel names, Zod schemas and the preload bridge type
  rendering/renderer/  framework-free Three.js scene
  platform/        api (interfaces), electron and web implementations
docs/  plans/  tools/  .claude/
```

## Licence

[MIT](LICENSE) © 2026 Joe Barbere. Third-party components are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Device brands, PLC families and model numbers in the game are fictional.
