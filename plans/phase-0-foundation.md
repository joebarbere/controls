# Phase 0: Foundation ("Hello, panel")

**Release:** v0.1.0 · **Status:** ✅ Done (2026-10-26) · **Spec:** [plan §6 P0](../controls-development-plan.md#p0--foundation-v010-hello-panel)

> **Status (2026-10-26, later):** pushed to GitHub; `main.yml` is green on all three OSes (verify, web e2e, Electron smoke). v0.1.0 bumped and awaiting its first tag-driven draft release.
>
> **Earlier status (2026-10-26):** F0.1–F0.6 are implemented and verified locally on Linux: `pnpm verify` exits 0, the web-harness e2e (3 tests) and the Electron smoke e2e (2 tests) pass, and the packaged unpacked Linux build passes the same smoke suite over CDP. Not done yet: the repo isn't pushed to GitHub, so no workflow has run (no macOS/Windows evidence), there is no tag or draft release, the `/release` dry run hasn't been run, and nobody has launched `pnpm start` / `pnpm start:web` by hand. Unticked items below say what is missing.

## Goal

A green, cross-platform walking skeleton: an Nx workspace, an Electron shell serving an Angular zoneless app over `app://` with cross-origin isolation, a Three.js viewport showing a DIN rail on a backplate, CI that `pnpm verify` mirrors exactly, a tag-driven draft-release pipeline, the documentation skeleton and the Claude Code setup. No gameplay.

## Phase acceptance

- [x] `pnpm verify` is green on Windows, macOS and Linux (CI `main.yml` matrix). _(run 40434999754, after fixing CRLF checkouts and GPU-less WebGL)_
- [x] Pushing `v0.1.0` produces a **draft** GitHub Release whose installers launch on Windows, macOS and Linux and show the viewport.
- [x] The `/release` dry run is documented in [`docs/guides/releasing.md`](../docs/guides/releasing.md) and has been run once. _(Rehearsed for real via `release.yml` `workflow_dispatch` (run 40441020062: package + smoke on all three OSes, no upload), then v0.1.0 cut from a tag.)_

## Features

### F0.1 Workspace

Nx 24 + pnpm 11 workspace, TypeScript strict, ESLint flat config, Prettier, module-boundary tags, `.nvmrc` (Node 24). Check TypeScript/Angular compatibility and whether `tsgo` can be used.

Acceptance:

- [x] `pnpm install` works from a clean clone with Node 24 and Corepack; packages with install scripts are in `pnpm-workspace.yaml` `allowBuilds`. _(Every CI job does a clean-clone `pnpm install --frozen-lockfile` on Windows, macOS and Linux.)_
- [x] Projects carry `type:*` tags and `@nx/enforce-module-boundaries` fails on a forbidden import (for example a `type:domain` lib importing Angular). _(A `type:domain` lib importing `@controls/renderer` fails lint; both e2e projects are `type:e2e`.)_
- [x] `tsconfig.base.json` uses `paths` without `baseUrl`; all projects typecheck under `strict`. _(Every project, including both e2e suites, has a `typecheck` target in `pnpm verify`.)_
- [x] Findings recorded: TypeScript pinned to 6.0.x (Angular 22 requires `>=6.0 <6.1`; `tsgo` not used); Vitest 4.1 (Angular 22 requires `^4`); integrated paths style because `@nx/angular` refuses project references. → [ADR 0001](../docs/decisions/0001-stack.md), [workspace caveats](../docs/caveats/workspace.md).

### F0.2 Electron shell

esbuild main/preload, `app://` protocol with COOP/COEP, security posture and Fuses, typed IPC skeleton (`@controls/ipc-contract`).

Acceptance:

- [x] `apps/desktop` main and preload are bundled by esbuild with all dependencies; the packaged app has no `node_modules`.
- [x] The renderer loads from `app://`, and an automated check asserts `crossOriginIsolated === true` and that the CSP header is present. _(`apps/desktop-e2e/src/smoke.spec.ts`)_
- [x] `contextIsolation`, `sandbox`, `webSecurity` on; `nodeIntegration` off; navigation and `window.open` blocked.
- [x] Fuses: RunAsNode and `NODE_OPTIONS` disabled, ASAR integrity on (verified with `@electron/fuses read` on a packaged build). _(Linux unpacked build. NodeCliInspect is also disabled, and cookie encryption and OnlyLoadAppFromAsar are enabled.)_
- [x] One round-trip IPC call (for example `app.getVersion`) validated by a Zod schema from `@controls/ipc-contract` in main. _(`app:info`, validated with `AppInfoSchema` in main and again in `platform-electron`.)_

### F0.3 Angular app

Angular 22 zoneless `apps/game` (prefix `ctl`), running inside Electron and in the browser harness (`@controls/platform-web`).

Acceptance:

- [x] No `zone.js` in the bundle; change detection is signal-driven.
- [x] The app talks to the OS only through `@controls/platform-api`; Electron gets `platform-electron`, `pnpm start:web` gets `platform-web`. _(The `PLATFORM` token in `apps/game/src/app/platform.token.ts` picks one depending on whether the preload bridge is present.)_
- [ ] `pnpm start` launches Electron with the app; `pnpm start:web` serves it in a browser. _(Not launched by hand yet. The e2e suites cover the same builds: `game:serve` and `dist/apps/desktop`.)_
- [x] An about box shows the version from `@controls/units` `version.ts`. _(The web harness shows `APP_VERSION` from `libs/domain/units/src/lib/version.ts`. Electron shows `app.getVersion()` from `apps/desktop/package.json`. `pnpm version:sync` writes both from the root version, and `check-version-sync` keeps them equal.)_

### F0.4 Three.js viewport

WebGPU with WebGL2 fallback (the about box shows the active backend), a procedural DIN rail and backplate, resize handling, renderer disposal.

Acceptance:

- [x] `@controls/renderer` is framework-free (`type:rendering`) and owns the renderer, scene and animation loop; Angular hands it a canvas.
- [x] `WebGPURenderer` used when `navigator.gpu` is available, WebGL2 otherwise; the about box shows which. _(This is `WebGPURenderer`'s built-in fallback. `ViewportRenderer` reads the backend it ended up with.)_
- [x] DIN rail and backplate are built procedurally (no asset files).
- [x] Resizing the window resizes the canvas without distortion; destroying the component disposes the renderer, geometries and materials (unit test). _(The unit test covers `disposeScene` (each geometry and material disposed once). Resize, done with a `ResizeObserver` plus a camera aspect update, and `ViewportRenderer.dispose()` have no unit tests of their own.)_
- [x] A Playwright test asserts the canvas renders non-blank content in the web harness (WebGL2 path). _(`apps/game-e2e/src/harness.spec.ts`: a non-blank check, plus `/?renderer=webgl2` pinning the fallback backend and asserting `webgl2`.)_

### F0.5 CI

`pr.yml` (format check, lint, typecheck, unit, Linux E2E) and `main.yml` (OS matrix). **`pnpm verify` runs exactly what CI runs, including `prettier --check`.**

Acceptance:

- [x] `pnpm verify` = `prettier --check` + `nx run-many -t lint typecheck test build` + `node tools/check-version-sync.mjs`, and CI calls the same steps (no CI-only checks).
- [x] PRs run verify plus web-harness E2E on Linux. _(`pr.yml` also runs the Electron smoke under `xvfb-run`. Configured only: nothing has run on GitHub yet.)_
- [x] `main` runs verify on ubuntu, macOS and Windows, plus the `_electron` smoke test. _(`main.yml` is configured. It hasn't run yet, so the green matrix is still open under phase acceptance.)_
- [x] Workflows use pnpm (version from `packageManager`) and Node from `.nvmrc`. _(Through the composite action `.github/actions/setup`.)_

### F0.6 Release pipeline

electron-builder config, `release.yml` on `v*` tags, a build matrix producing a draft GitHub Release (NSIS, dmg/zip, AppImage/deb/rpm, `latest*.yml`), electron-updater wiring (no-op in dev). Signing off.

Acceptance:

- [x] `apps/desktop/electron-builder.config.cjs` defines NSIS, universal dmg + zip, AppImage, deb and rpm targets and the GitHub publish provider.
- [ ] `pnpm package:desktop` and `pnpm package:desktop:dir` work locally on the current OS. _(`package:desktop:dir` works and the AppImage builds. On the Fedora dev host, deb fails because `libcrypt.so.1` is missing and rpm fails because `rpmbuild` is missing (see [release caveats](../docs/caveats/release.md)). Tick this once `libxcrypt-compat` and `rpm-build` are installed and a full run passes.)_
- [x] `release.yml` builds all three OSes from a `v*` tag and creates a **draft** release with every artifact and `latest*.yml`. _(Run 40441773977: draft v0.1.0 with NSIS, universal dmg/zip, AppImage/deb/rpm, blockmaps and all three `latest*.yml`, each smoke-tested before upload.)_
- [x] electron-updater checks for updates only when packaged; no-op in dev. _(It is also skipped on macOS while builds are unsigned, and when `CONTROLS_DISABLE_UPDATES=1`.)_
- [x] `pnpm version:sync` writes the root version into `apps/desktop/package.json` and `libs/domain/units/src/lib/version.ts`; `tools/check-version-sync.mjs` fails on drift (unit-tested or exercised in CI).

### F0.7 Docs skeleton

README, `CHANGELOG.md` (Keep a Changelog), `docs/README.md` hub, `docs/history.md`, `docs/architecture/`, `docs/caveats/`, `docs/decisions/` (ADRs 0001–0004), `docs/glossary.md`, `THIRD_PARTY_NOTICES.md`, `LICENSE` (MIT). Research already in `docs/research/`.

Acceptance:

- [x] `README.md`: pitch, grouped features, platforms (with unsigned-build workarounds), quick start, TODO, docs table, licence.
- [x] `CHANGELOG.md` with `[Unreleased]` listing the P0 scaffold under Added.
- [x] `docs/README.md` hub, `docs/history.md`, `docs/glossary.md`.
- [x] `docs/architecture/overview.md` with Mermaid process/thread and module-boundary diagrams, marked as target architecture with what P0 implements.
- [x] `docs/caveats/README.md`, `workspace.md`, `electron.md`, `release.md`, each opening with "Load this when…".
- [x] ADRs 0001 stack, 0002 simulation architecture, 0003 licence policy, 0004 save format.
- [x] `docs/guides/new-developer-guide.md` and `docs/guides/releasing.md` (including the `/release` dry run).
- [x] `THIRD_PARTY_NOTICES.md` and `LICENSE` (MIT, © 2026 Joe Barbere).
- [x] All of the above pass `prettier --check` in `pnpm verify`.

### F0.8 Claude Code setup

`CLAUDE.md`, the helper agents `docs-keeper`, `version-keeper`, `release-engineer`, plus `electron-platform-engineer` and `test-engineer`; the skills `/verify`, `/docs-sync`, `/release`; `tools/check-version-sync.mjs`.

Acceptance:

- [x] `CLAUDE.md`: status line + next step, invariants, Definition of Done, commands, documentation discipline, agent routing table, caveats index, working with the planning artifacts.
- [x] `.claude/agents/` has `docs-keeper`, `version-keeper`, `release-engineer`, `electron-platform-engineer`, `test-engineer`.
- [x] `.claude/skills/` has `verify`, `docs-sync`, `release` (the release skill stops for user confirmation before any tag or publish).
- [x] `tools/check-version-sync.mjs` exists and runs in `pnpm verify` (built with F0.6).
- [ ] `/verify` exercised once on a real branch.
- [x] `/docs-sync` exercised once (2026-10-26, on the working tree before the first commit).

## Status

| Feature | Description       | Status                                                          |
| ------- | ----------------- | --------------------------------------------------------------- |
| F0.1    | Workspace         | 🚧 `game-e2e` tag + typecheck gap; clean-clone install unproven |
| F0.2    | Electron shell    | ✅ Done locally                                                 |
| F0.3    | Angular app       | 🚧 Manual `pnpm start` / `start:web` launch pending             |
| F0.4    | Three.js viewport | ✅ Done locally                                                 |
| F0.5    | CI                | 🚧 Workflows written; first GitHub run pending                  |
| F0.6    | Release pipeline  | 🚧 Full local package (deb/rpm) + first tagged draft pending    |
| F0.7    | Docs skeleton     | ✅ Done                                                         |
| F0.8    | Claude Code setup | 🚧 `/verify` on a real branch pending                           |

## Close-out

1. `docs-keeper` sync (README features, CHANGELOG, history).
2. `version-keeper`: `0.0.0 → 0.1.0`.
3. `release-engineer`: package, smoke test, tag on confirmation, verify the draft. The user publishes.
4. Mark P0 shipped in [`plans/README.md`](README.md) and [`docs/history.md`](../docs/history.md); P1 kickoff writes `plans/phase-1-game-shell.md` and creates `angular-ui-engineer`, `renderer-engineer` and `save-format-guardian`.
