# Releasing

> **Load this when:** cutting a release, rehearsing one (dry run), or checking what the `/release` skill will do. Gotchas are in [release caveats](../caveats/release.md).

## Policy

- **SemVer.** Each completed phase ships a **minor** (`0.N.0`); bug-fix-only releases are **patches**; **1.0.0** only at P13 completion, with user approval.
- Releases are **built by CI** (`.github/workflows/release.yml`) from a `v*` tag on `main`, into a **draft** GitHub Release. **The user publishes the draft.**
- Nothing is tagged, pushed or published without explicit confirmation from the user in the current conversation.
- Builds are **unsigned** until a decision before P13 (see the [README](../../README.md#platforms) for the user-facing workarounds).

## Version sources

All of these carry the same version. `node tools/check-version-sync.mjs` (part of `pnpm verify`) checks the two generated files against the root, and checks that a non-`0.0.0` version has its CHANGELOG section. The README badge and the `CLAUDE.md` status line aren't checked, so `version-keeper` updates them by hand:

| Source                                 | Updated by                                                           |
| -------------------------------------- | -------------------------------------------------------------------- |
| root `package.json`                    | `version-keeper` (source of truth)                                   |
| `apps/desktop/package.json`            | `pnpm version:sync` (read by electron-builder)                       |
| `libs/domain/units/src/lib/version.ts` | `pnpm version:sync` (web-harness about box, later the save manifest) |
| `CHANGELOG.md` (`## [x.y.z] - date`)   | `version-keeper`                                                     |
| README version badge and status        | `version-keeper`                                                     |
| `CLAUDE.md` status line                | `version-keeper`                                                     |

## The flow (`/release patch|minor|major`)

```mermaid
sequenceDiagram
    actor U as User
    participant VK as version-keeper
    participant RE as release-engineer
    participant CI as release.yml
    U->>VK: /release minor
    VK->>VK: read [Unreleased], propose bump
    VK->>VK: bump all sources, roll CHANGELOG, version:sync
    VK->>VK: check-version-sync + pnpm verify
    VK->>VK: commit "chore(release): vX.Y.Z" (no tag)
    VK->>RE: hand off
    RE->>RE: preflight (clean main, verify green)
    RE->>RE: pnpm package:desktop + e2e:desktop smoke
    RE->>U: show tag + draft notes, ask to confirm
    U->>RE: confirm
    RE->>CI: git push origin main vX.Y.Z
    CI->>CI: build Windows, macOS, Linux; create draft
    RE->>RE: check artifacts + latest*.yml
    RE->>U: draft URL
    U->>U: publish the draft on GitHub
```

1. **`version-keeper`** reads `CHANGELOG.md` `[Unreleased]`, proposes the bump (and asks if it differs from the requested one), updates every version source, rolls `[Unreleased]` into `## [x.y.z] - YYYY-MM-DD` with a fresh empty `[Unreleased]` and updated compare links, runs `pnpm version:sync`, `node tools/check-version-sync.mjs` and `pnpm verify`, and commits `chore(release): vX.Y.Z`. It does not tag.
2. **`release-engineer`** preflights (clean tree on `main`, the release commit at `HEAD`, verify green), runs `pnpm package:desktop`, runs the smoke suite against the packaged app (`CONTROLS_E2E_EXECUTABLE=<unpacked binary> pnpm e2e:desktop`), and checks the Fuses.
3. It shows you the tag name and the draft notes, and **waits for your confirmation**.
4. On confirmation it pushes the commit and the `vX.Y.Z` tag, then watches the run (`gh run watch`). `release.yml` (triggered by `v*.*.*` tags):
   - a `verify` job fails if the tag isn't `v` + the root `package.json` version, then runs `pnpm verify`;
   - a `build` matrix (ubuntu, macOS, Windows, unsigned, `CSC_IDENTITY_AUTO_DISCOVERY=false`) runs `pnpm build:desktop` and `electron-builder --publish never`;
   - each OS smoke-tests its own unpacked app (`linux-unpacked/controls`, `win-unpacked/Controls.exe`, `mac-universal/Controls.app`) through `CONTROLS_E2E_EXECUTABLE`, and **only then** runs `electron-builder --publish always` to upload into the draft, so a build that fails its smoke test never reaches the release.
5. It verifies the draft has every artifact: NSIS `.exe`, universal `.dmg` and `.zip`, `.AppImage`, `.deb`, `.rpm`, blockmaps, and `latest.yml` / `latest-mac.yml` / `latest-linux.yml` pointing at files in the release with the new version.
6. **You publish the draft** on GitHub. Then install the previous version on one machine and confirm it offers the update (Linux AppImage or Windows; macOS won't auto-update unsigned).

## Dry run (`/release minor dry-run`)

A dry run rehearses everything that can be undone and stops before anything leaves your machine. Use it for the P0 acceptance check and before the first real release of each phase. For packaging changes, also rehearse on CI with **Actions → release → Run workflow** (`workflow_dispatch`), which packages and smoke-tests all three OSes and uploads nothing; it was run before both v0.1.0 and v0.2.0 ([release caveats](../caveats/release.md)).

1. `version-keeper` works on a throwaway branch (`release-dry-run/vX.Y.Z`): it bumps, rolls the CHANGELOG, runs `version:sync`, `check-version-sync` and `pnpm verify`, and reports the diff. **It does not commit to `main`.**
2. `release-engineer` packages for the current OS (`pnpm package:desktop`), runs the smoke suite against the packaged binary (`CONTROLS_E2E_EXECUTABLE=… pnpm e2e:desktop`), reads the Fuses, and prints the tag and notes it **would** push.
3. Nothing is tagged or pushed. Delete the branch afterwards (`git switch main && git branch -D release-dry-run/vX.Y.Z`) and discard the build output.

Manual equivalent:

```bash
git switch -c release-dry-run/v0.1.0
# edit root package.json version to 0.1.0, roll CHANGELOG [Unreleased]
pnpm version:sync
node tools/check-version-sync.mjs
pnpm verify
pnpm package:desktop
CONTROLS_E2E_EXECUTABLE=dist/release/linux-unpacked/controls pnpm e2e:desktop   # Linux; see release.yml for macOS/Windows paths
npx @electron/fuses read --app dist/release/linux-unpacked/controls
git switch main && git branch -D release-dry-run/v0.1.0
```

## When it goes wrong

- **CI build fails after the tag is pushed:** delete the draft, fix on `main` with a patch bump (never move or re-push a published tag; an unpublished tag may be deleted with the user's confirmation), and release again.
- **An artifact or `latest*.yml` is missing:** don't publish. Fix the electron-builder config or `release.yml`, then re-release.
- Record what happened in [release caveats](../caveats/release.md).
