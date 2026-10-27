# Development history

> **Looking for what the game can do today?** See the [feature list in the README](../README.md#features). This page is the historical record of _how_ the project got there: what each phase delivered and when, plus the version history of the app, the save format and the device catalogue. Load it when you need to know when something landed or why work was sequenced the way it was.

The roadmap is defined in [`controls-development-plan.md`](../controls-development-plan.md) §2 and §6 and broken down per phase in [`plans/`](../plans/README.md). Each phase ships one minor release.

## Phase summary

| Phase | Theme                                                                      | Release | Status         |
| ----- | -------------------------------------------------------------------------- | ------- | -------------- |
| P0    | Foundation: workspace, Electron shell, CI, release pipeline, docs, agents  | v0.1.0  | 🚧 In progress |
| P1    | Game shell: UI, commands, cameras, interaction, save/load                  | v0.2.0  | 📐 Planned     |
| P2    | Circuit engine and power sources                                           | v0.3.0  | 📐 Planned     |
| P3    | Wires, terminations, enclosures and hand tools                             | v0.4.0  | 📐 Planned     |
| P4    | Lights, switches, receptacles, panels, protection (first playable sandbox) | v0.5.0  | 📐 Planned     |
| P5    | Instruments, safety, faults, Apprentice career                             | v0.6.0  | 📐 Planned     |
| P6    | Three-phase, control circuits, relays, timers, prints                      | v0.7.0  | 📐 Planned     |
| P7    | Contactors, overloads, motors; Journeyman part 1                           | v0.8.0  | 📐 Planned     |
| P8    | Pumps, actuators, process simulation; Journeyman part 2                    | v0.9.0  | 📐 Planned     |
| P9    | Sensors and instrumentation                                                | v0.10.0 | 📐 Planned     |
| P10   | PLC I: hardware, runtime, ladder; Controls Technician                      | v0.11.0 | 📐 Planned     |
| P11   | PLC II: ST, FBD, analog/PID, basic VFD                                     | v0.12.0 | 📐 Planned     |
| P12   | Networking, SCADA/HMI, alarms, trends; Controls Engineer                   | v0.13.0 | 📐 Planned     |
| P13   | Campaign completion, polish, signing, modding v1                           | v1.0.0  | 📐 Planned     |

## Phase 0: Foundation ("Hello, panel")

**Started 2026-10-26.** Plan: [`plans/phase-0-foundation.md`](../plans/phase-0-foundation.md).

- The development plan and four research reports (tech stack, circuit simulation, PLC/SCADA, domain realism) were written on 2026-10-26 and are the starting spec.
- Toolchain checks at kickoff changed two plan assumptions: Angular 22 requires **TypeScript 6.0** (`>=6.0 <6.1`), so TypeScript 7 / `tsgo` is not used; and Angular 22's Vitest integration requires **Vitest 4** (the plan said Vitest 5). See [ADR 0001](decisions/0001-stack.md).
- `@nx/angular` refuses the TypeScript project-references ("solution") workspace style, so the workspace uses the integrated `tsconfig.base.json` paths style.
- `pnpm verify` was made identical to CI, including `prettier --check`, after a sibling project shipped a broken release because CI ran a format check that local verification didn't.

## Version history

### App releases

| Version | Date | Phase | Notes               |
| ------- | ---- | ----- | ------------------- |
| 0.0.0   | —    | P0    | Unreleased scaffold |

### Save format (`schemaVersion`)

The `.ctrl` save format ([ADR 0004](decisions/0004-save-format.md)) is introduced in P1 (F1.8). No versions yet.

| schemaVersion | App version | Change |
| ------------- | ----------- | ------ |
| —             | —           | —      |

### Device catalogue (`catalogVersion`)

The device catalogue in `content/` is introduced in P2–P3. No versions yet.

| catalogVersion | App version | Change |
| -------------- | ----------- | ------ |
| —              | —           | —      |
