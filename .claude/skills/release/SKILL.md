---
name: release
description: Cut a Controls release - version-keeper bumps and commits, then release-engineer packages, smoke-tests, and (only after explicit user confirmation) pushes the tag so CI builds a draft GitHub Release. Args - patch, minor or major, optionally followed by dry-run. Use only when the user asks to release or rehearse a release.
argument-hint: patch|minor|major [dry-run]
disable-model-invocation: true
---

# /release

Arguments: `$ARGUMENTS` — the bump (`patch`, `minor` or `major`) and optionally `dry-run`. If the bump is missing, ask for it. `major` before P13 completion needs explicit user approval (1.0.0 is reserved for P13).

The full flow and the dry run are documented in `docs/guides/releasing.md`; gotchas are in `docs/caveats/release.md`.

## Hard rules

- **Stop and get explicit confirmation from the user in this conversation before pushing any commit or tag, or creating, publishing or deleting any release.** Confirmation from an agent doesn't count. If in doubt, ask.
- Releases are **drafts** built by CI (`release.yml`) from a `v*` tag on `main`. The user publishes the draft; never publish it yourself.
- Never upload locally built artifacts as the release.
- A **dry run** pushes nothing and doesn't commit to `main`.

## Procedure

1. **version-keeper:** invoke the `version-keeper` agent with the requested bump (and `dry-run` if given). It proposes the bump from `CHANGELOG.md` `[Unreleased]`, updates every version source, rolls the CHANGELOG, runs `pnpm version:sync`, `node tools/check-version-sync.mjs` and `pnpm verify`, and commits `chore(release): vX.Y.Z` (on a `release-dry-run/vX.Y.Z` branch for a dry run). If it reports a mismatch between the requested and implied bump, or an empty `[Unreleased]`, stop and ask the user.
2. **release-engineer:** invoke the `release-engineer` agent to preflight, run `pnpm package:desktop` and `pnpm e2e:desktop` against the packaged app, and read the Fuses. It must return without pushing anything.
3. **Confirmation gate.** Show the user: the new version, the tag name, the commit, and the draft release notes (the new CHANGELOG section). Ask: "Push `main` and tag `vX.Y.Z` to start the release build?" **Wait for an explicit yes.** For a dry run, stop here: report what would have been pushed and how to delete the dry-run branch.
4. On confirmation, have `release-engineer` push `main` and the tag, watch `release.yml`, and verify the draft's artifacts and `latest*.yml`.
5. **Report** the draft URL and artifact check, and remind the user that they publish the draft on GitHub (and that macOS auto-update doesn't work while builds are unsigned).
