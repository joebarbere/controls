# Release caveats

**Load this when:** bumping the version, running `/release`, editing `tools/check-version-sync.mjs`, `apps/desktop/electron-builder.config.cjs` or `.github/workflows/release.yml`, touching electron-updater, or making signing decisions.

- **Releases are drafts built by CI from a `v*` tag on `main`.** Never upload locally built artifacts as the release. The user publishes the draft; agents never do.
- **Never push a tag or publish without explicit user confirmation in the current conversation.** `/release` stops and asks.
- **Version sources move in lock-step:** root `package.json` (the source of truth), `apps/desktop/package.json` (read by electron-builder), the generated `libs/domain/units/src/lib/version.ts` (`APP_VERSION`: the web-harness about box, later the save manifest; the Electron about box reads `app.getVersion()`, which comes from `apps/desktop/package.json`), `CHANGELOG.md`, the README badge/status and the `CLAUDE.md` status line. `pnpm version:sync` writes the two generated ones from the root. `node tools/check-version-sync.mjs` (part of `pnpm verify`) fails if either generated file disagrees, or if a non-`0.0.0` version has no `## [x.y.z]` CHANGELOG section. **It doesn't check the README badge or the `CLAUDE.md` status line**, so `version-keeper` has to update those by hand.
- **`pnpm verify` mirrors CI exactly, including `prettier --check`.** jansky-observe shipped an inert release because CI's format check wasn't in local verify. Run `pnpm verify` before tagging, not just the tests.
- **Builds are unsigned until a decision before P13.** macOS: Gatekeeper warns and **macOS auto-update does not work** (Squirrel.Mac requires a signed app). Windows: SmartScreen warns; NSIS auto-update works. Linux: AppImage auto-update works unsigned. Document the workarounds in the README, don't hide them.
- **Targets:** NSIS (Windows), dmg + zip universal (macOS; the zip is what electron-updater uses on macOS), AppImage + deb + rpm (Linux). deb/rpm don't auto-update; that's expected.
- **Check `latest.yml`, `latest-mac.yml` and `latest-linux.yml`** on every draft: they must exist, reference files present in the release, and carry the new version. A missing or wrong one silently breaks auto-update for that OS.
- **electron-updater is a no-op in dev** (`app.isPackaged === false`). Test updates only with a packaged build against a real (draft or prerelease) GitHub Release.
- **The packaged app has no `node_modules`.** If a packaged build crashes on launch with "Cannot find module", a main-process dependency was left external in esbuild (see [electron caveats](electron.md)).
- **Changing the app id or product name after users install breaks their update path** and userData location. Treat `appId` in the electron-builder config as frozen once v0.1.0 ships.
- **Local deb/rpm builds on Fedora** fail with `ruby: … libcrypt.so.1` (electron-builder's bundled fpm) and need `rpmbuild` for rpm: `sudo dnf install libxcrypt-compat rpm-build`. The AppImage builds without them. Ubuntu CI runners have libcrypt; `release.yml` installs `rpm`.
- **No app icon yet:** builds use electron-builder's default Electron icon until `apps/desktop/build-resources/icon.png` (1024×1024) is added.
- **macOS universal** builds download both x64 and arm64 Electron; `CSC_IDENTITY_AUTO_DISCOVERY=false` in `release.yml` keeps the runner from trying to sign with a stray identity.
- **Packaged smoke tests must wait for the app to exit** between launches (`terminate()` in `apps/desktop-e2e/src/launch.ts`). The single-instance lock makes a second launch quit at once if the previous process is still shutting down; v0.1.0's first macOS release job failed this way (`connectOverCDP … ECONNREFUSED`).
- Record each release lesson here, in the same PR as the fix.
