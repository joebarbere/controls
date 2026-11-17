> Research snapshot gathered 2026-11-16 by `release-engineer` for the P4 kickoff (step 5 of [`plans/phase-4-residential.md`](../../plans/phase-4-residential.md), PR 2 of the kickoff stack). Versions and dates were read from the npm registry, nodejs.org, the Electron releases feed and GitHub on that date; re-verify before relying on them. It supersedes nothing: the [2026-10 tech-stack report](2026-10-tech-stack.md) stays as it was.

# P4 toolchain re-check (2026-11-16)

## Summary

| Tool                    | Pinned before (lockfile)                    | Latest (2026-11-16)                                                                           | Status                                                                                                   | Action in this PR                                       |
| ----------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Electron                | 45.0.0                                      | 45.3.3 (2026-11-16 05:55 UTC); 45.3.2 (2026-11-13)                                            | **Behind** (patch line); 45.3.3 **blocked by** pnpm's 24-hour minimum release age                        | **45.0.0 → 45.3.2**                                     |
| three                   | 0.186.1 (r186), `@types/three` 0.186.0      | 0.187.0 (r187, 2026-10-30), `@types/three` 0.187.0                                            | **Behind** one release                                                                                   | None (report only; see below)                           |
| Angular                 | `~22.2.0` → 22.2.3 core / 22.2.4 CLI, build | 22.2.6 core / 22.2.7 CLI, build; 22.3.0-rc.0 in `next`                                        | **Behind** (patch)                                                                                       | **22.2.6 / 22.2.7** (lockfile, `~` lower bounds raised) |
| Nx                      | 24.0.2                                      | 24.0.6 (2026-11-10); 24.1.0-beta.1 in `next`                                                  | **Behind** (patch)                                                                                       | **24.0.2 → 24.0.6** (`nx migrate`: no migrations)       |
| Playwright              | `^1.64.1` → 1.64.1                          | 1.65.1 (2026-11-13)                                                                           | Current on 1.64 (no newer 1.64.x); **behind** by a minor                                                 | None (a minor, not a patch)                             |
| Vitest                  | `~4.1.12` → 4.1.12                          | 5.1.0 (2026-11-02); 4.1.12 is the newest 4.1.x                                                | Current on 4.1 by choice ([ADR 0001](../decisions/0001-stack.md)); Angular 22.2 accepts `^4.0.8 \|\| ^5` | None                                                    |
| TypeScript              | `~6.0.3` → 6.0.3                            | 7.0.2; 6.0.3 is the newest 6.0.x                                                              | Current on 6.0; 7 **blocked by** Angular (`@angular/compiler-cli` 22.2.6 peer: `typescript >=6.0 <6.1`)  | None                                                    |
| electron-builder        | 26.18.1                                     | 26.18.1 (`v26` tag; `latest` still points at 26.18.0); 27.0.0-alpha.14 in `next` (2026-10-29) | Current; **27 is not out**                                                                               | None (the `WasmTrapHandlers` item stays open)           |
| electron-updater        | 6.8.12                                      | 6.8.12 (`latest` tag points at 6.8.11); 7.0.0-alpha.13 in `next`                              | Current                                                                                                  | None                                                    |
| Node (`.nvmrc` `v24`)   | 24 LTS                                      | 24.22.3 "Krypton" LTS (2026-11-10); 26.13.1 "Lithium" is LTS since 26.13.0 (2026-10-28)       | Current: Node follows Electron's embedded Node (45.3.2 embeds 24.22.2)                                   | None                                                    |
| pnpm (`packageManager`) | 11.28.8                                     | 12.21.0; 11.28.12 is the newest 11.x                                                          | **Behind** (11.x patch, and a major)                                                                     | None (not in scope; see follow-ups)                     |

Shipped runtime set: only Electron (the binary) and `@angular/*` (22.2.3 → 22.2.6) change. No package was added or removed, so `THIRD_PARTY_NOTICES.md` (which lists packages, not versions) is unchanged. The other lockfile movement is build tooling pulled by Nx and `@angular/build`: oxc-parser 0.150 → 0.156, rolldown 1.2.8 → 1.2.16, a duplicate vite 8.3.0 deduplicated to 8.3.5, undici 7.30.1 and `@emnapi`/`@napi-rs/wasm-runtime` (oxc's optional WASI binding).

## Electron 45.0.0 → 45.3.2

Release notes 45.0.0 → 45.3.2 ([compare](https://releases.electronjs.org/release/compare/v45.0.0/v45.3.2)): Chromium 156.0.8078.48 → 156.0.8078.100, Node 24.22.0 → 24.22.2, V8 15.6.75.19 → 15.6.75.57. Nothing is labelled breaking. Nothing touches fuses, `contextIsolation`, the CSP, `SharedArrayBuffer`, WebGPU or CDP attach. Relevant to us:

- 45.1.0 fixes asar archives whose size fields don't match the file length, and inconsistent asar path handling between the main and child processes. Our app is one `app.asar` with embedded integrity validation, so the packaged Fuses check covers it.
- 45.1.0: `protocol.registerSource` schemes now follow the same fetch rules as `protocol.handle` schemes. We use `protocol.handle` for `app://`, so nothing changes for us.
- 45.2.0: repeated `net.fetch()` of `file:` URLs is faster. Our `app://` handler serves files exactly that way (`net.fetch` on a `file:` URL), so the change is on our path; behaviour and headers are unchanged, and the `crossOriginIsolated` checks passed on all three OSes.
- 45.1.0: `utilityProcess` now emits `exit` when the app quits while the process is still starting. Unused today; relevant to P12's opt-in protocol servers.
- 45.2.2 fixes a Wayland crash with a hidden parent window. 45.3.2 fixes a browser crash in DevTools Fetch interception (Playwright doesn't use it in our specs) and cookies lost shortly before quitting.
- 45.1.0, 45.2.0 and 45.3.0 are minor releases inside the 45 line (new extension and menu APIs we don't use). Electron ships features in minors of a stable major, so this is still "the latest 45.x" the plan asks for.

**Why 45.3.2 and not 45.3.3:** 45.3.3 was published at 05:55 UTC today. pnpm 11's minimum release age (24 hours by default; [workspace caveats](../caveats/workspace.md)) refuses it, and committing a `minimumReleaseAgeExclude` is not allowed. Take 45.3.3 or later in the next dependency PR.

**Checked locally on Linux (Fedora, Node 24.12.0) with 45.3.2:** `pnpm verify` green (82 tasks, bench included). `pnpm e2e:desktop` against the dev build gave 29 passed and 1 skipped (`sim-worker.spec.ts`'s minimised-window check, which this window system can't report). `pnpm package:desktop:dir`: the binary reports `Chrome/156.0.8078.100 Electron/45.3.2`. The same suite against the unpacked package over CDP (`CONTROLS_E2E_EXECUTABLE`, headless) gave 19 passed and 11 skipped (the dev-build-only specs). Fuses, read with `pnpm dlx @electron/fuses@2.1.3 read --app dist/release/linux-unpacked/controls` from a scratch directory: RunAsNode, EnableNodeOptionsEnvironmentVariable, EnableNodeCliInspectArguments, LoadBrowserProcessSpecificV8Snapshot and GrantFileProtocolExtraPrivileges are disabled; EnableCookieEncryption, EnableEmbeddedAsarIntegrityValidation, OnlyLoadAppFromAsar and WasmTrapHandlers are enabled. That is the same as at 45.0.0. macOS and Windows are covered by PR CI. Packaging on them needs a `release.yml` rehearsal (`workflow_dispatch`).

## three r186 → r187 (not upgraded)

This answers the open P3 kickoff item 7: **r186 is no longer current.** r187 shipped on 2026-10-30 ([release](https://github.com/mrdoob/three.js/releases/tag/r187), [migration guide 186 → 187](https://github.com/mrdoob/three.js/wiki/Migration-Guide#186--187)). Licence unchanged (MIT). three-mesh-bvh 0.9.18 accepts `three >= 0.159.0`. It is a 0.x minor with behaviour changes, so it gets its own PR with `renderer-engineer`, not a patch-level bump here:

- **`WebGPURenderer`'s internal animation loop now starts on first use, and `setAnimationLoop(null)` no longer starts it.** `stopInternalAnimationLoop` in `libs/rendering/renderer/src/lib/viewport-renderer.ts` exists because r186's `init()` started a rAF loop by itself. Under r187 the workaround may be unnecessary, or it may stop a loop that has not started yet. Check the idle wake-up and on-demand drawing after the bump.
- Code deprecated in r177 is removed. Our renderer uses no API from the changed list (`getProjectionDepth`, `getSharedDataFromNode`, `iridescenceThicknessRange`, `count` with `dispatchSize`); none was found by search.
- `WebGLRenderer` applies the pixel ratio only in `setViewport()` and `setScissor()`. We use `WebGPURenderer` (`setPixelRatio` once), so it affects only its WebGL2 backend if the backend shares the path. `?renderer=webgl2` in `game-e2e` covers it.
- Disposal: WebGPU now disposes storage buffer attributes and all buffer attributes. The P3 wire renderer gives every pool mesh its own geometry because r186 freed a large mesh's interleaved instance buffers only on a geometry dispose. Re-run the `renderer.info.memory` baseline e2e after the bump.
- The WebGL2 fallback's `PMREMGenerator` uses cube render targets instead of the CubeUV atlas. We use no PMREM or environment maps today.
- `three/tsl` is now tree-shakeable. Measure the initial bundle against the 2.00 MB budget (P4 D19) after the bump.

## electron-builder 27 and `WasmTrapHandlers`

electron-builder 27 is still alpha (27.0.0-alpha.14, 2026-10-29). The P2 item carries forward unchanged: when we move to 27 (stable), set `wasmTrapHandlers: true` in `electronFuses` so the choice is explicit ([electron caveats](../caveats/electron.md)).

## Follow-ups (not done here)

- **Electron 45.3.3+** once it is a day old.
- **three r187** in its own PR (`renderer-engineer`), with the checks above.
- **Playwright 1.65** (a minor: new browser builds) in its own PR with both e2e suites on three OSes.
- **pnpm 11.28.12** (patch) is low-risk. pnpm 12 is a major and also changes `pnpm/action-setup` behaviour: decide it separately.
- **Vitest 5** stays a choice for the user (ADR 0001 keeps 4.1). Angular 22.2's unit-test builder already accepts it.
- **Local Node:** the development machine used for this check runs Node 24.12.0. Angular 22.2's engines need `^24.15.0` (already true of the 22.2.3 that was locked before this PR), so pnpm warns. CI resolves `.nvmrc` `v24` to the newest 24.x. Update the local Node to 24.22.x to match Electron's embedded Node.

## Sources

- npm registry metadata (`npm view <pkg> dist-tags`, `versions`, `time`, `peerDependencies`, `engines`), read 2026-11-16, for every package above.
- Electron: [45.0.0 → 45.3.2 release notes](https://releases.electronjs.org/release/compare/v45.0.0/v45.3.2); [releases feed](https://releases.electronjs.org).
- three.js: [r187 release](https://github.com/mrdoob/three.js/releases/tag/r187); [migration guide](https://github.com/mrdoob/three.js/wiki/Migration-Guide#186--187).
- Node.js: [release index](https://nodejs.org/dist/index.json).
- Angular: `@angular/compiler-cli@22.2.6` and `@angular/build@22.2.7` peer ranges (TypeScript `>=6.0 <6.1`, Vitest `^4.0.8 || ^5.0.0`), `@angular/core@22.2.6` engines.
- electron-builder: `dist-tags` (`latest` 26.18.0, `v26` 26.18.1, `next` 27.0.0-alpha.14).
