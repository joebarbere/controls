# ADR 0001: Technology stack

**Status:** Accepted
**Date:** 2026-10-26 (Phase 0, F0.1)
**Sources:** plan §1, §4.1; [tech-stack research](../research/2026-10-tech-stack.md)

## Context

Controls is a cross-platform desktop game with a 3D world, docked 2D editors (prints, ladder, HMI) and a CPU-heavy circuit simulator in a worker. It needs Windows, macOS and Linux installers with auto-update from GitHub Releases, an MIT-compatible dependency tree, and a pure-TypeScript domain layer that can also run headless in Node for scenario tests. The author already runs a sibling project (aquascape) on Electron + Angular + Nx + pnpm.

## Options

1. **Electron + Angular + Three.js** (imperative), Nx + pnpm, electron-builder.
2. **Tauri + a web front end.** Smaller binaries, but a different WebView per OS (WebKitGTK on Linux, where WebGPU and `SharedArrayBuffer` support lag), and the main process would be Rust rather than TypeScript.
3. **A game engine (Godot / Unity).** Strong 3D tooling, but the 2D editors (ladder, ST in a code editor, HMI builder) and the TypeScript domain layer shared with a headless CLI would have to be rebuilt in the engine.
4. **Angular + angular-three** for declarative 3D.
5. **Electron Forge** instead of electron-builder.

## Decision

- **Electron 45** (Chromium 156, Node 24), main and preload bundled with **esbuild**, content served from a custom **`app://`** protocol.
- **Angular 22**, standalone, **zoneless**, signals, `@angular/build`. Angular state is UI-only.
- **Three.js r186**, plain imperative, behind a framework-free `@controls/renderer`. `WebGPURenderer` with automatic WebGL2 fallback.
- **Nx 24 + pnpm 11**, integrated `tsconfig.base.json` paths style, module boundaries enforced by tags.
- **TypeScript 6.0.x**, `strict`. **Vitest 4.1** + fast-check for unit and property tests, **Playwright 1.64** for the web harness and `_electron`.
- **Zod 4** as the schema source of truth (IPC now; saves, catalogue and command arguments later).
- **electron-builder 26 + electron-updater** via GitHub Releases. Unsigned until a decision before P13.
- **Node 24 LTS** for tooling (`.nvmrc`); move when Electron's embedded Node moves (amended at P1 kickoff, see below).

## Why not the others

- **angular-three** peers stop at `@angular/core <22` and `three <0.183`, so it can't be the foundation. Imperative Three.js also keeps the renderer testable and liftable into a worker with `OffscreenCanvas`.
- **Electron Forge** auto-updates through Squirrel and update.electronjs.org, which covers macOS and Windows only (no AppImage) and lacks NSIS differential updates.
- **Tauri** and **engines** were rejected for the reasons in Options.

## Deviations from the plan found at F0.1

- **TypeScript 7 / `tsgo` is not used.** Angular 22 requires TypeScript `>=6.0 <6.1`. The plan hoped to use `tsgo` for framework-free libs; mixing two compilers isn't worth it in P0. Revisit when Angular supports TS 7.
- **Vitest 4.1, not 5.** Angular 22.0's Vitest integration required `vitest@^4`. The plan and research both said Vitest 5.
- **No `baseUrl`** (deprecated in TS 6), and **no TS project references** (`@nx/angular` refuses the "solution" setup).

## Amendments at P1 kickoff (2026-10-27)

- **Node stays on 24.** Node 26 reaches LTS on 2026-10-28, but Electron 45, 46 and 47 all embed Node 24 and `@types/node` is `^24`. Tooling Node now moves when Electron's embedded Node moves, so the toolchain and the shipped runtime agree.
- **Vitest 4.1 is kept by choice.** Since 22.2.0, `@angular/build` accepts `vitest ^4.0.8 || ^5.0.0` (and `@nx/vitest` 24 accepts `^5`), so the F0.1 constraint no longer holds. Moving to 5 is deferred past P1 to avoid churn while the test layers are being built.
- **pnpm 12** (`latest` since 2026-08-26) is deferred past P1; P1 takes 11.x patch releases only.

## Consequences

- One language (TypeScript) across main, renderer, workers and the headless CLI.
- Installers are large (Chromium is bundled); accepted for a desktop game.
- The Electron security posture (plan §4.11) must be actively maintained; see [electron caveats](../caveats/electron.md).
- WebGPU on Linux is driver-dependent, so the WebGL2 path must always be tested.
- `release-engineer` re-checks every pinned version at each phase kickoff (plan §12, toolchain churn).
