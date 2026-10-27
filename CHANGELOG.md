# Changelog

All notable changes to Controls are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each phase ships a minor release (`0.N.0`); fixes ship as patches. The save-format `schemaVersion` and the `catalogVersion` are versioned independently and recorded in [`docs/history.md`](docs/history.md).

## [Unreleased]

## [0.1.0] - 2026-10-26

Phase 0, "Hello, panel": the cross-platform walking skeleton. Nothing playable yet.

### Added

- The first desktop build: an Electron 45 window titled "Controls" showing a 3D view of a white sub-panel with two TS35 DIN rails. The view is built procedurally, uses WebGPU when available and WebGL2 otherwise, can be orbited with the mouse, and resizes with the window.
- An about box showing the app version, platform (with the Electron version), active render backend (`webgpu` or `webgl2`) and whether the page is cross-origin isolated.
- Installers for Windows (NSIS), macOS (universal dmg and zip) and Linux (AppImage, deb, rpm). They are unsigned, and packaged builds check GitHub Releases for updates (not on macOS while builds are unsigned).
- Security hardening for the desktop shell. The game is served from a custom `app://` origin with COOP/COEP and a strict CSP (no `unsafe-eval`), path traversal is refused, and the sandboxed renderer has no Node access. Navigation, pop-ups, `<webview>` and permission requests are denied, and `https://` links open in the system browser. Electron Fuses disable RunAsNode, `NODE_OPTIONS` and the inspect flags, and turn on cookie encryption and ASAR integrity. Only one instance of the app can run at a time.
- A typed, Zod-validated IPC skeleton (`@controls/ipc-contract`). One `app:info` channel, which accepts calls only from the app's own origin, is exposed to the renderer as `window.controls.getAppInfo()`. The preload imports a narrow `@controls/ipc-contract/preload` entry, so Zod stays out of it.
- A browser dev harness (`pnpm start:web`) that runs the same Angular 22 zoneless app with `@controls/platform-web` instead of the Electron bridge.
- Developer workspace: Nx 24 + pnpm 11, TypeScript 6.0 strict, ESLint flat config with module-boundary tags (`type:app`, `type:feature`, `type:ui`, `type:domain`, `type:rendering`, `type:platform`, `type:contract`, `type:e2e`), Prettier, and Node 24 pinned in `.nvmrc`.
- `pnpm verify`, which runs exactly what CI runs: Prettier check, lint, typecheck, unit tests, build and the version-sync check. `pnpm version:sync` copies the root version into the desktop app and `@controls/units`.
- End-to-end tests: `apps/game-e2e` (Playwright against the web harness, including a check that the viewport isn't blank) and `apps/desktop-e2e` (an Electron smoke suite that runs against the built app, or against a packaged binary via `CONTROLS_E2E_EXECUTABLE`).
- GitHub Actions: `pr.yml` (verify and both e2e suites on Linux), `main.yml` (the same on Windows, macOS and Linux) and `release.yml` (on a `v*.*.*` tag: check the tag matches the version, verify, package each OS, smoke-test the packaged app, and only then upload it to a **draft** GitHub Release with `latest*.yml`). All three share the `.github/actions/setup` composite action.
- Documentation skeleton: README, this changelog, the docs hub, architecture overview, caveats, ADRs 0001–0004, glossary, history, new-developer and releasing guides, `THIRD_PARTY_NOTICES.md` and the MIT licence.
- Claude Code setup: `CLAUDE.md`, the `docs-keeper`, `version-keeper`, `release-engineer`, `electron-platform-engineer` and `test-engineer` agents, and the `/verify`, `/docs-sync` and `/release` skills.

[Unreleased]: https://github.com/joebarbere/controls/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/joebarbere/controls/releases/tag/v0.1.0
