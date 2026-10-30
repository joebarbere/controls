# New-developer guide

> **Load this when:** you're setting up the repo for the first time or making your first contribution.

Controls has completed **Phase 1** (the game shell): a keyboard-first Angular shell in Electron, a 3D workshop you can place props in, one command registry behind the palette, keybindings, dev console and scripting API, and `.ctrl` saves. There is no circuit simulation yet (Phase 2). This guide stays short until there's more to tour.

## 1. Prerequisites

- **Node 24 LTS** (the exact version is in `.nvmrc`; `nvm use` or `fnm use` picks it up).
- **pnpm 11** through Corepack: `corepack enable`. The version comes from `package.json#packageManager`.
- Git, and for packaging on your OS the usual electron-builder prerequisites. On Linux, deb/rpm need `rpmbuild`, and on Fedora also `libxcrypt-compat` (`sudo dnf install libxcrypt-compat rpm-build`). The AppImage and `package:desktop:dir` work without them.
- On Linux, WebGPU depends on your GPU driver and Vulkan setup. If it isn't available the viewport falls back to WebGL2, and the about box tells you which one is active.

## 2. Setup

```bash
git clone https://github.com/joebarbere/controls.git
cd controls
corepack enable
pnpm install
pnpm exec playwright install chromium   # once; Playwright browsers aren't in node_modules
pnpm verify        # should be green before you change anything
```

If `pnpm install` complains about build scripts or release age, read the [workspace caveats](../caveats/workspace.md).

## 3. Everyday commands

| Command                    | What it does                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm start`               | Build the game and the desktop shell, then launch Electron                                        |
| `pnpm start:web`           | Browser dev harness (`nx serve game`), fastest for UI and renderer iteration                      |
| `pnpm test`                | Unit tests (Vitest) for all projects                                                              |
| `pnpm e2e`                 | Playwright against the web harness (`apps/game-e2e`)                                              |
| `pnpm build:desktop`       | Build `dist/apps/desktop` (Angular build + bundled main/preload)                                  |
| `pnpm e2e:desktop`         | Playwright `_electron` smoke test against the built app (`apps/desktop-e2e`); builds first        |
| `pnpm package:desktop`     | electron-builder installers for the current OS, into `dist/release/`                              |
| `pnpm package:desktop:dir` | Unpacked app directory only (faster; good for smoke testing)                                      |
| `pnpm verify`              | Exactly what CI runs: `prettier --check`, lint, typecheck, test, build, version-sync check        |
| `pnpm format`              | Prettier `--write` across the repo                                                                |
| `pnpm version:sync`        | Copy the root version into `apps/desktop/package.json` and `libs/domain/units/src/lib/version.ts` |

`pnpm verify` doesn't run the e2e suites. CI runs them after verify, so run `pnpm e2e` and `pnpm e2e:desktop` before you push.

### E2E environment variables

| Variable                           | Effect                                                                                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTROLS_E2E_HEADLESS=1`          | Electron smoke runs with `--ozone-platform=headless`, so no window opens on your desktop (CI uses `xvfb-run` instead).                                                                                                                        |
| `CONTROLS_E2E_EXECUTABLE=<binary>` | Smoke-test a packaged build (e.g. `dist/release/linux-unpacked/controls` after `pnpm package:desktop:dir`). The launcher starts the binary with `--remote-debugging-port` and attaches over CDP, because the release Fuses block `_electron`. |
| `CONTROLS_DISABLE_UPDATES=1`       | Skips the electron-updater check in a packaged build. The e2e launcher always sets it.                                                                                                                                                        |

Per-project work goes through Nx: `pnpm nx show projects` lists them, then `pnpm nx test <project>`, `pnpm nx lint <project>`, or `pnpm nx graph` to browse dependencies.

## 4. Mental model

Read the [architecture overview](../architecture/overview.md). The short version:

- `libs/domain/*` is **framework-free TypeScript**. It will hold the world model, commands, save format and the simulator, and must run in plain Node.
- `libs/rendering/renderer` is **framework-free Three.js**. Angular only hands it a canvas.
- `apps/game` (Angular, selector prefix `ctl`) is the UI. It talks to the OS only through `@controls/platform-api` interfaces, implemented by `platform-electron` (via the typed preload bridge) or `platform-web` (browser harness).
- `apps/desktop` is the Electron main process and preload. Content is served from `app://` with COOP/COEP so `SharedArrayBuffer` works. The preload imports only `@controls/ipc-contract/preload`.
- Two e2e projects: `apps/game-e2e` drives the browser harness, and `apps/desktop-e2e` drives the built Electron app.
- Nx tags (`type:app|feature|ui|domain|rendering|platform|contract|e2e`) enforce these boundaries at lint time.

The project's rules ("the simulator runs what is wired", "every mutation is a Command", determinism, the realism charter, the licence policy) are in [`CLAUDE.md`](../../CLAUDE.md) and the [spec](../../controls-development-plan.md).

## 5. Making a change

1. Find the feature in the current phase plan under [`plans/`](../../plans/README.md). One feature (`FN.x`) per PR.
2. Load the [caveat file](../caveats/README.md) for the area you're touching.
3. Write the code and tests. Meet the Definition of Done in `CLAUDE.md`.
4. Update docs in the same PR: README features/TODO, `CHANGELOG.md` `[Unreleased]`, caveats, glossary, architecture pages as needed. With Claude Code, `/docs-sync` does this.
5. Run `pnpm verify` (or `/verify`). If only formatting fails, `pnpm format` and re-run.

## 6. Licence hygiene

New dependencies must be MIT, BSD, ISC or Apache-2.0 and get a row in [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md). Don't open GPL/AGPL source files (CircuitJS1, OpenPLC Editor, Studomate…) while implementing; see [ADR 0003](../decisions/0003-licence-policy.md).
