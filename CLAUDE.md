# CLAUDE.md

Guidance for Claude Code working in this repository.

## Repository state

**Phase 1 (Game shell) in progress, kickoff 2026-10-27. Version 0.1.0.** Plan: [`plans/phase-1-game-shell.md`](plans/phase-1-game-shell.md); P1 specialists `angular-ui-engineer`, `renderer-engineer` and `save-format-guardian` created. Landed: kickoff boundary hardening, F1.8a, F1.1, F1.2 (commands, world model, session), F1.3 palette, F1.4 keybindings, F1.5 console, F1.6 (scripting API + `sim-cli`), F1.7 (placement via commands), F1.9 (workshop level + new-game seed). Next: F1.8b (`.ctrl` container, autosave, Continue/Load), the phase-acceptance E2E, then the F1.10 wire-routing spike. Spec: [`controls-development-plan.md`](controls-development-plan.md).

## What this project is

Controls: a realistic electrician → controls-engineer simulation game. Electron 45 + Angular 22 (zoneless, signals) + Three.js r186, TypeScript 6.0 strict, Nx 24 + pnpm 11. MIT. NEC/US first. Docs hub: [`docs/README.md`](docs/README.md).

## Non-negotiable invariants

- **The simulator runs what is wired, not what is drawn.** Physical as-built → netlist; prints are a separate document and may be wrong.
- **`type:domain` libs are framework-free** (no Angular, DOM or Electron). `sim-cli` must be able to run the game headless.
- **Every world mutation is a registered Command.** The palette, keybinds, console and scripting API share one registry; the UI never mutates world state directly.
- **Determinism:** integer sim ticks + seeded PRNG; seed + command log reproduces a session exactly.
- **Realism charter (plan §3):** every constant has a `source`; never copy NFPA/NEC text or tables; fictional brands only.
- **Licence policy ([ADR 0003](docs/decisions/0003-licence-policy.md)):** MIT/BSD/ISC/Apache may be used with a row in `THIRD_PARTY_NOTICES.md`; GPL/AGPL/LGPL code is reference-only. Reimplement, never paste or translate, and don't open GPL source while implementing.
- **Save format ([ADR 0004](docs/decisions/0004-save-format.md)):** Zod schema is the source of truth; integer `schemaVersion` + total migration chain; lossless JSON round-trip; catalogue entries by reference.
- **Electron:** `contextIsolation` + `sandbox` + `webSecurity` on, `nodeIntegration` off; typed, Zod-validated IPC via `@controls/ipc-contract`; `app://` with COOP/COEP; strict CSP; Fuses.
- **Module boundaries** are enforced by Nx tags (`type:app|feature|ui|domain|rendering|platform|contract|e2e`). Features never depend on a concrete platform.
- **`pnpm verify` == CI.** Never add a CI-only check.

## Definition of Done (each feature PR, plan §9.1)

Typed public API · unit tests (plus property/oracle tests for solver code) · at least one UI or E2E test for player-facing features · `pnpm verify` green · keyboard-accessible · **docs updated in the same PR by `docs-keeper`** (README features/TODO, `docs/architecture` and `docs/caveats` pages, glossary, CHANGELOG `[Unreleased]`, Field Guide entries for new devices from P13) · `electrical-realism-reviewer` sign-off for any new device model or electrical constant.

## Development commands

```bash
corepack enable && pnpm install   # Node 24 (.nvmrc), pnpm 11 (packageManager)
pnpm verify            # == CI: prettier --check, nx lint/typecheck/test/build (all), check-version-sync
pnpm format            # prettier --write (fixes verify format failures)
pnpm start             # build game + desktop, launch Electron
pnpm start:web         # browser dev harness (nx serve game)
pnpm test              # unit tests (Vitest 4.1)
pnpm exec playwright install chromium   # once, before the first e2e run
pnpm e2e               # Playwright, web harness (apps/game-e2e)
pnpm build:desktop     # dist/apps/desktop
pnpm e2e:desktop       # Playwright _electron smoke against the built app (apps/desktop-e2e); CONTROLS_E2E_EXECUTABLE=<binary> attaches to a packaged build over CDP
pnpm package:desktop   # electron-builder installers for this OS (package:desktop:dir = unpacked)
pnpm version:sync      # root version -> apps/desktop/package.json + libs/domain/units/src/lib/version.ts
pnpm sim run <script>  # headless: a .ts module exporting (game) => … or a .console file; prints world.hash (--seed, --world, --log, --expect)
pnpm sim replay <log>  # replay a replay-log JSON, print the hash; `pnpm sim hash <world.json>` hashes a world (.ctrl from F1.8b)
```

Run Nx through pnpm (`pnpm nx …`), never a global `nx`. Use `pnpm --silent sim …` when piping (stdout is data only). Guide: [`docs/guides/scripting.md`](docs/guides/scripting.md).

## Documentation discipline

Documentation drift is a failing test. Update docs in the same PR as the change (`docs-keeper` or `/docs-sync`):

- **`README.md`**: pitch, feature bullets grouped by category (not phase), platforms, quick start, TODO (remove a line when it ships, add a feature bullet), docs table, licence.
- **`CHANGELOG.md`**: Keep a Changelog. Add to `[Unreleased]` with each PR; never edit a released section.
- **`docs/history.md`**: phase narrative at phase/milestone completion, plus `schemaVersion` and `catalogVersion` history.
- **`docs/architecture/<subsystem>.md`** (Mermaid), **`docs/caveats/<area>.md`** (opens with "Load this when…"), **`docs/decisions/NNNN-*.md`** (ADRs), **`docs/glossary.md`**, **`docs/guides/`**.
- **`CLAUDE.md`** (this file): status line + next step, invariants, DoD, commands, routing, caveats index. Keep it short; area detail goes in caveats.

## Agents: use them

Project agents live in `.claude/agents/`. Specialists not yet created are made at their phase kickoff.

| When you are…                                                                                    | Use                                                                            |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Finishing any feature or fix, or before opening a PR                                             | `docs-keeper` (or `/docs-sync`)                                                |
| Bumping the version or preparing a release                                                       | `version-keeper`, then `release-engineer` (or `/release`)                      |
| Touching packaging, `release.yml`, the updater or signing                                        | `release-engineer`                                                             |
| Working on Electron main, preload or IPC                                                         | `electron-platform-engineer`                                                   |
| Working on test infrastructure, CI gates or flaky E2E                                            | `test-engineer`                                                                |
| Working on Angular UI, the palette, console, keybindings or editors                              | `angular-ui-engineer`                                                          |
| Working on Three.js, cables, picking or audio                                                    | `renderer-engineer`                                                            |
| Working on `commands`, `world-model`, `scripting-api`, `feature-session`, `sim-cli` or a Command | main agent until P2; `save-format-guardian` reviews world ops and command args |
| Changing save or world schemas or migrations                                                     | `save-format-guardian`                                                         |
| Changing solvers, device electrical models or the worker protocol                                | `sim-engine-engineer`, then `electrical-realism-reviewer` (both created in P2) |
| Adding devices, tables, jobs or faults                                                           | `content-designer` (created in P3), then `electrical-realism-reviewer`         |
| Working on the PLC runtime, compilers or ladder/ST editors                                       | `plc-engineer` (created in P10)                                                |
| Working on HMI/SCADA, networking or alarms                                                       | `scada-engineer` (created in P12)                                              |
| Starting a phase                                                                                 | Plan agent → `plans/phase-N-*.md`; create that phase's specialists             |

Until a specialist exists, do the work directly and follow the plan section for that area. Default to a single sub-agent; use an agent team only when three or more areas must agree a new contract at once (expected: P2 sim ↔ worker ↔ renderer, P10 PLC ↔ sim ↔ editor, P12 network ↔ HMI ↔ PLC).

**Skills:** `/verify` (run `pnpm verify`, fix formatting, report honestly) · `/docs-sync` (docs-keeper on the branch diff) · `/release patch|minor|major [dry-run]` (version-keeper → release-engineer; stops for your confirmation before any tag or publish).

## Caveats index

Load the matching file before working in an area. The code tells you what shipped; caveats tell you why. Full index: [`docs/caveats/README.md`](docs/caveats/README.md).

| File                                                         | Load when working on…                                                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| [`docs/caveats/workspace.md`](docs/caveats/workspace.md)     | Dependencies, Nx/pnpm/tsconfig/ESLint/Prettier config, new libs, tags, `pnpm verify`                                       |
| [`docs/caveats/electron.md`](docs/caveats/electron.md)       | `apps/desktop`, `apps/desktop-e2e`, `platform/electron`, `ipc-contract`, `app://`, CSP, Fuses                              |
| [`docs/caveats/release.md`](docs/caveats/release.md)         | Versioning, version sync, electron-builder, `release.yml`, updater, signing, `/release`                                    |
| [`docs/caveats/save-format.md`](docs/caveats/save-format.md) | `save-format` schemas, migrations, fixtures, settings; world serialisation; command ids/args (persisted in the replay log) |
| [`docs/caveats/commands.md`](docs/caveats/commands.md)       | `commands`, `world-model`, `feature-session`; adding a command; `world.hash`, PRNG, replay determinism                     |
| [`docs/caveats/rendering.md`](docs/caveats/rendering.md)     | `libs/rendering/renderer`: cameras, BVH picking, selection, snap maths, disposal, viewport host                            |
| [`docs/caveats/scripting.md`](docs/caveats/scripting.md)     | `scripting-api`, the console-line parser, `apps/sim-cli` and scenarios, changing a command's args shape                    |
| [`docs/caveats/ui.md`](docs/caveats/ui.md)                   | `apps/game`, `libs/ui`, `libs/features/*`, focus, dialogs, theming, Angular component tests                                |

## Working with the planning artifacts

- `controls-development-plan.md` is the spec. If a request conflicts with it, raise the conflict instead of quietly deviating; change the plan first, then the code.
- Each phase has a plan in `plans/phase-N-<slug>.md` with features `FN.x` and acceptance criteria. Reference the feature ID in commits and PRs, and tick its checklist when it lands.
- Known plan corrections (recorded in [ADR 0001](docs/decisions/0001-stack.md)): TypeScript 6.0 not 7, Vitest 4.1 not 5 (kept by choice through P1), Node follows Electron's embedded Node, and E2E split into `apps/game-e2e` (web harness) and `apps/desktop-e2e` (`_electron`).
- `docs/research/` holds dated research reports. Don't edit them; supersede with a new dated report.
