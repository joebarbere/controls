# Development history

> **Looking for what the game can do today?** See the [feature list in the README](../README.md#features). This page is the historical record of _how_ the project got there: what each phase delivered and when, plus the version history of the app, the save format and the device catalogue. Load it when you need to know when something landed or why work was sequenced the way it was.

The roadmap is defined in [`controls-development-plan.md`](../controls-development-plan.md) §2 and §6 and broken down per phase in [`plans/`](../plans/README.md). Each phase ships one minor release.

## Phase summary

| Phase | Theme                                                                      | Release | Status     |
| ----- | -------------------------------------------------------------------------- | ------- | ---------- |
| P0    | Foundation: workspace, Electron shell, CI, release pipeline, docs, agents  | v0.1.0  | ✅ Done    |
| P1    | Game shell: UI, commands, cameras, interaction, save/load                  | v0.2.0  | 📐 Planned |
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
- **v0.1.0** shipped as a draft GitHub Release with every installer (NSIS, universal dmg/zip, AppImage/deb/rpm) and all three `latest*.yml`, each smoke-tested before upload.

## Version history

### App releases

| Version | Date       | Phase | Notes                            |
| ------- | ---------- | ----- | -------------------------------- |
| 0.1.0   | 2026-10-26 | P0    | Walking skeleton (draft release) |

### Save format (`schemaVersion`)

The `.ctrl` save format ([ADR 0004](decisions/0004-save-format.md)) is introduced in P1 (F1.8). Version 1 is frozen when v0.2.0 ships; until then it may still change with its fixtures.

| schemaVersion | App version        | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1             | 0.2.0 (unreleased) | First version (F1.8a, [ADR 0007](decisions/0007-world-document-v1.md)): `manifest.json`, `world.json` (seed, tick, `nextEntityId`, region, difficulty, `assisted`, entities with catalogue refs and integer-mm/millidegree transforms, `extensions`) and `replay.log` (initial world plus `{ seq, tick, id, args }` entries). F1.9 added `fixtures` to the world (no bump; v1 unpublished). F1.8b added the `.ctrl` ZIP container: those three entries plus an optional `thumbnail.png`, empty `prints/`, `plc/` and `hmi/` reserved, deterministic bytes, and fixtures under `fixtures/v1/ctrl/`. |

Settings are versioned separately (`settingsVersion`):

| settingsVersion | App version        | Change                                                                                                                                                                          |
| --------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1               | 0.2.0 (unreleased) | First version (F1.8a): graphics, audio, controls and keybinding overrides, palette recents, console history, display, gameplay defaults, workspace layout, autosave, tool belt. |

### Device catalogue (`catalogVersion`)

The device catalogue in `content/` is introduced in P2–P3. No versions yet.

| catalogVersion | App version | Change |
| -------------- | ----------- | ------ |
| —              | —           | —      |
