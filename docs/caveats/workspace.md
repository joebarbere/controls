# Workspace caveats

**Load this when:** adding or upgrading dependencies, editing `package.json`, `pnpm-workspace.yaml`, `nx.json`, `tsconfig*.json` or ESLint/Prettier config, generating a new app or lib, changing Nx tags, or when `pnpm verify` and CI disagree.

- **`pnpm verify` is CI.** It runs `prettier --check`, `nx run-many -t lint typecheck test build` for every project, and `node tools/check-version-sync.mjs`. If you add a CI step, add it to `verify` in the same PR (and vice versa). Lesson from jansky-observe: CI ran a `ruff format --check` that local verify didn't, and a release went out broken.
- **Format failures:** run `pnpm format` (Prettier `--write`), then re-run `pnpm verify`. Prettier checks Markdown too, so docs-only PRs can fail CI.
- **TypeScript is pinned to 6.0.x.** Angular 22's compiler requires `>=6.0 <6.1`. TypeScript 7 (the Go-native compiler, `tsgo`) is **not** usable for Angular projects; don't upgrade or add a second compiler without an ADR.
- **No `baseUrl`.** It is deprecated in TypeScript 6. `tsconfig.base.json` declares `paths` with paths relative to the config file and no `baseUrl`.
- **Integrated paths style, not project references.** `@nx/angular` refuses the TypeScript project-references ("solution") setup, so libraries are resolved through `tsconfig.base.json` `paths` (`@controls/units`, `@controls/ipc-contract`, `@controls/renderer`, `@controls/platform-api`, …). Generators must be run in that style.
- **Vitest is 4.1, not 5.** Angular 22's Vitest integration requires `vitest@^4`. The plan and the tech-stack research say Vitest 5; that was wrong.
- **pnpm 11 install scripts need `allowBuilds`.** Any dependency with a `postinstall`/build script (Electron, esbuild, `@swc/core`, nx, …) must be listed under `allowBuilds` in `pnpm-workspace.yaml`, or its script is skipped silently and things break later (for example a missing Electron binary).
- **pnpm 11 enforces a minimum release age.** A version published very recently can refuse to install. Pin the previous version or wait; don't turn the check off to get around it.
- **Node 24 LTS** is pinned in `.nvmrc`; pnpm via `packageManager` (`pnpm@11.15.0`), picked up by `corepack enable`.
- **Nx tags** are `type:app`, `type:feature`, `type:ui`, `type:domain`, `type:rendering`, `type:platform`, `type:contract`, `type:e2e`. Every new project needs exactly one `type:*` tag, or the boundary rule can't place it. The constraints are in the root `eslint.config.mjs`; see the [architecture overview](../architecture/overview.md#module-boundaries).
- **`type:domain` libs stay framework-free**: no `@angular/*`, DOM types or `electron` imports. `sim-cli` must be able to run them in plain Node.
- **`apps/desktop/package.json` is not a workspace package** (`'!apps/desktop'` in `pnpm-workspace.yaml`): it is the template for the packaged app's `package.json` and shares the root's name.
- **Playwright browsers are not in `node_modules`**: run `pnpm exec playwright install chromium` once (CI uses `--with-deps`). The web e2e project is Chromium-only on purpose, since Electron is Chromium.
- **`@nx/web:file-server` (`serve-static`) ignores the `headers` option**, so it isn't cross-origin isolated. The CI web e2e serves `game:serve:production` through the Angular dev server instead.
- **E2E projects are tagged `type:e2e`** and may not import workspace libs (`onlyDependOnLibsWithTags: []`). Both e2e projects have the tag and a `typecheck` target.
- **Nx generators add other-agent config** (`.cursor`, `.gemini`, `AGENTS.md`, …) and an Nx block in `CLAUDE.md`. Delete them after generating; don't run `nx configure-ai-agents`.
- **Angular selector prefix is `ctl`.**
- Run Nx through pnpm (`pnpm nx …`, `pnpm exec nx …`), never a globally installed `nx`.
