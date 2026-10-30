# Development history

> **Looking for what the game can do today?** See the [feature list in the README](../README.md#features). This page is the historical record of _how_ the project got there: what each phase delivered and when, plus the version history of the app, the save format and the device catalogue. Load it when you need to know when something landed or why work was sequenced the way it was.

The roadmap is defined in [`controls-development-plan.md`](../controls-development-plan.md) §2 and §6 and broken down per phase in [`plans/`](../plans/README.md). Each phase ships one minor release.

## Phase summary

| Phase | Theme                                                                      | Release | Status     |
| ----- | -------------------------------------------------------------------------- | ------- | ---------- |
| P0    | Foundation: workspace, Electron shell, CI, release pipeline, docs, agents  | v0.1.0  | ✅ Done    |
| P1    | Game shell: UI, commands, cameras, interaction, save/load                  | v0.2.0  | ✅ Done    |
| P2    | Circuit engine and power sources                                           | v0.3.0  | 📐 Planned |
| P3    | Wires, terminations, enclosures and hand tools                             | v0.4.0  | 📐 Planned |
| P4    | Lights, switches, receptacles, panels, protection (first playable sandbox) | v0.5.0  | 📐 Planned |
| P5    | Instruments, safety, faults, Apprentice career                             | v0.6.0  | 📐 Planned |
| P6    | Three-phase, control circuits, relays, timers, prints                      | v0.7.0  | 📐 Planned |
| P7    | Contactors, overloads, motors; Journeyman part 1                           | v0.8.0  | 📐 Planned |
| P8    | Pumps, actuators, process simulation; Journeyman part 2                    | v0.9.0  | 📐 Planned |
| P9    | Sensors and instrumentation                                                | v0.10.0 | 📐 Planned |
| P10   | PLC I: hardware, runtime, ladder; Controls Technician                      | v0.11.0 | 📐 Planned |
| P11   | PLC II: ST, FBD, analog/PID, basic VFD                                     | v0.12.0 | 📐 Planned |
| P12   | Networking, SCADA/HMI, alarms, trends; Controls Engineer                   | v0.13.0 | 📐 Planned |
| P13   | Campaign completion, polish, signing, modding v1                           | v1.0.0  | 📐 Planned |

## Phase 0: Foundation ("Hello, panel")

**Started and completed 2026-10-26.** Plan: [`plans/phase-0-foundation.md`](../plans/phase-0-foundation.md).

- The development plan and four research reports (tech stack, circuit simulation, PLC/SCADA, domain realism) were written on 2026-10-26 and are the starting spec.
- Toolchain checks at kickoff changed two plan assumptions: Angular 22 requires **TypeScript 6.0** (`>=6.0 <6.1`), so TypeScript 7 / `tsgo` is not used; and Angular 22's Vitest integration requires **Vitest 4** (the plan said Vitest 5). See [ADR 0001](decisions/0001-stack.md).
- `@nx/angular` refuses the TypeScript project-references ("solution") workspace style, so the workspace uses the integrated `tsconfig.base.json` paths style.
- `pnpm verify` was made identical to CI, including `prettier --check`, after a sibling project shipped a broken release because CI ran a format check that local verification didn't.
- First CI run on GitHub failed on Windows (CRLF checkouts failing `prettier --check`; fixed with `.gitattributes`) and Linux (no GPU, so no WebGL; fixed with `--enable-unsafe-swiftshader` for test launches). macOS passed first time.
- The release gate caught a test-harness bug twice before anything shipped: relaunching the packaged app in one job never came up on macOS/Windows. Fixed with a fresh `CONTROLS_USER_DATA_DIR` profile per launch and one launch per smoke file; `release.yml` gained a no-upload `workflow_dispatch` rehearsal. The incomplete v0.1.0 drafts were deleted and the tag re-cut on the fixed commit.
- **v0.1.0** shipped as a draft GitHub Release with every installer (NSIS, universal dmg/zip, AppImage/deb/rpm) and all three `latest*.yml`, each smoke-tested before upload (published 2026-10-29).

## Phase 1: Game shell ("Hands on the panel")

**Kickoff 2026-10-27, completed 2026-10-28; shipped as v0.2.0 on 2026-10-29.** Plan: [`plans/phase-1-game-shell.md`](../plans/phase-1-game-shell.md).

- **Kickoff** created the P1 specialists (`angular-ui-engineer`, `renderer-engineer`, `save-format-guardian`) and hardened the `type:domain` boundary, which P0 had only proved against a workspace import: banned framework and UI imports, no DOM lib or Node built-ins in domain source, a determinism lint (no `Math.random`, wall clock, `performance` or `crypto`), a `scope:headless` tag for `sim-cli`, and a 90 % coverage gate run by `pnpm verify`. Vitest stayed on 4.1, Node on 24 and pnpm on 11 by choice; axe-core was ruled out under the licence policy (MPL-2.0), so accessibility is covered by keyboard-only Playwright tests.
- **Delivered:** a keyboard-first shell (main menu, custom split-pane docking workspace, HUD, notifications, themes, settings with their own `settingsVersion`; [ADR 0005](decisions/0005-docking-workspace.md)); one command registry with undo/redo, a replay log and a pure-TypeScript SHA-256 `world.hash` that matches in Node and Chromium ([ADR 0006](decisions/0006-command-system.md), [ADR 0007](decisions/0007-world-document-v1.md)); four surfaces over it: rebindable keybindings and the tool belt, the command palette with Zod-generated argument forms, the CodeMirror 6 dev console, and the scripting API with the headless `sim-cli` ([ADR 0008](decisions/0008-console-and-scripts.md)); walk and work cameras, BVH picking and integer-millimetre snapping with sourced constants; the workshop sandbox level as data with a new-game seed; and the `.ctrl` save format at `schemaVersion` 1 with save I/O behind opaque handles, atomic writes, autosave, Continue and Load ([ADR 0009](decisions/0009-save-io-boundary.md)).
- **F1.8 landed as separate PRs** (schemas first, then the container, platform I/O and the in-game UI), an accepted exception to one feature per PR. F1.9 added `fixtures` to `WorldV1` without a `schemaVersion` bump because v1 was unpublished; every golden hash was re-pinned together. The DIN rail module moved from 18 mm to 17.5 mm (DIN 43880) at the same time.
- **The F1.10 wire-routing spike** was measured and recorded as [ADR 0010](decisions/0010-wire-routing-spike.md) (two-click auto-routed connections, instanced wire segments, screen-space terminal picking, a deterministic bake for P3). Its code stays on the unmerged `spike/wire-routing` branch.
- **CI flakes that turned out to be real bugs:**
  - The settings-persistence test failed intermittently on macOS because the 300 ms settings debounce was never flushed on quit (Angular's `onDestroy` doesn't run when Electron closes the window). Fixed with a flush-before-quit handshake between main and the page ([electron caveats](caveats/electron.md)).
  - Long web e2e tests hit the 30 s timeout on Windows CI. Under SwiftShader every frame blocks the page's main thread, and the viewport redrew continuously, so every Playwright call waited for one. The tests were split into one flow per test, and the viewport now renders on demand (web e2e 1.9 min to 42 s locally).
  - Continue resumed the newest autosave rather than the game last played, because loading over unsaved changes autosaves the game being left. Fixed by `settingsVersion` 2's `saves.lastPlayed` pointer ([ADR 0009](decisions/0009-save-io-boundary.md#continue-and-the-last-played-save)).
- **Test-harness lessons:** pull requests now run the same three-OS reusable workflow as `main`. The web e2e project emulates Desktop Chrome, whose user agent is Windows, so the app binds `Mod` to Ctrl on every runner and the tests press `Control`, not Playwright's `ControlOrMeta` (which presses Cmd on a macOS runner). A flaky property test had a wrong reference builder, not a wrong hash.
- **Acceptance:** one scenario (`apps/sim-cli/scenarios/phase-acceptance.*`) places, moves and deletes with undo and redo through the mouse, the palette, the console and `sim-cli`, all reaching one `world.hash`; save → reload reaches the same hash in the web harness and in Electron.
- **Release:** the first v0.2.0 run failed its packaged smoke tests on macOS and Linux: `connectOverCDP` hung after its WebSocket connected, because attaching while the app is still starting is racy (Windows uploaded a partial draft). The launcher now waits for the app page in `/json/list` before attaching ([release caveats](caveats/release.md)); after a passing rehearsal on all three OSes the partial draft and tag were deleted and v0.2.0 re-cut on the fixed commit. v0.2.0 was published with every installer and `latest*.yml`, and is the first release an installed 0.1.0 can auto-update to (AppImage and Windows; not macOS while unsigned).
- **Open follow-ups** (listed in the [plan](../plans/phase-1-game-shell.md#open-follow-ups-not-done-in-p1)): placement overlap checks, keybinding conflict detection on AZERTY, the 2020-era integrated-GPU frame budget, a manual WebGPU check on a real GPU, delete and thumbnails in the Load list, and two save fixes from the pre-release save-format review (the replay log never shrinks; Continue's case-insensitive name fallback).

## Version history

### App releases

| Version | Date       | Phase | Notes                                             |
| ------- | ---------- | ----- | ------------------------------------------------- |
| 0.1.0   | 2026-10-26 | P0    | Walking skeleton (published 2026-10-29)           |
| 0.2.0   | 2026-10-29 | P1    | Game shell: sandbox, commands, cameras, save/load |

### Save format (`schemaVersion`)

The `.ctrl` save format ([ADR 0004](decisions/0004-save-format.md)) is introduced in P1 (F1.8). Version 1 is frozen as of 0.2.0; any change from here needs a new `schemaVersion` and a migration.

| schemaVersion | App version | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1             | 0.2.0       | First version (F1.8a, [ADR 0007](decisions/0007-world-document-v1.md)): `manifest.json`, `world.json` (seed, tick, `nextEntityId`, region, difficulty, `assisted`, entities with catalogue refs and integer-mm/millidegree transforms, `extensions`) and `replay.log` (initial world plus `{ seq, tick, id, args }` entries). F1.9 added `fixtures` to the world (no bump; v1 unpublished). F1.8b added the `.ctrl` ZIP container: those three entries plus an optional `thumbnail.png`, empty `prints/`, `plc/` and `hmi/` reserved, deterministic bytes, and fixtures under `fixtures/v1/ctrl/`. |

Settings are versioned separately (`settingsVersion`):

| settingsVersion | App version | Change                                                                                                                                                                                                                                                                                             |
| --------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1               | 0.2.0       | First version (F1.8a): graphics, audio, controls and keybinding overrides, palette recents, console history, display, gameplay defaults, workspace layout, autosave, tool belt.                                                                                                                    |
| 2               | 0.2.0       | Adds `saves.lastPlayed` (a manual save by name, an autosave slot, or `null`) for Continue ([ADR 0009](decisions/0009-save-io-boundary.md#continue-and-the-last-played-save)). v1 migrates with `lastPlayed: null`. Bumped rather than edited in place so settings written since F1.1 keep loading. |

### Device catalogue (`catalogVersion`)

The device catalogue (`content/devices/*.json`, loaded by `@controls/catalog`) is introduced in P2. Like a schema version, a catalogue version may still change until the release that ships it and is frozen from then on. Saves written before the catalogue existed carry `catalogVersion` 0.

| catalogVersion | App version     | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1              | 0.3.0 (planned) | First version (P2 kickoff, decision D4): the catalogue entry format (`DeviceDefinition`: identity, fictional brand and model name, category, size, terminals, model `{ kind, params }`, controls, `sources`), the `MODEL_KINDS` registry (`battery`, `lamp.incandescent`, `switch.spst`, `lead`) and four entries: a 12 V 7 Ah sealed lead-acid battery, a 12 V 5 W incandescent lamp, an SPST toggle switch and a 1 m test lead. `prop.*` stays built in. |
