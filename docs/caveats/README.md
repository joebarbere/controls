# Load-bearing caveats: index

> Looking for _how things work_ rather than gotchas? Start at the [documentation hub](../README.md) and the [architecture overview](../architecture/overview.md).

This directory holds the gotchas that bite contributors. They live here, not in [`CLAUDE.md`](../../CLAUDE.md), so Claude (and humans) can load only what's relevant to the area being touched.

**Cardinal rule:** the codebase tells you _what shipped_; these files tell you _why a non-obvious decision sticks_. Add to them when someone trips on something a reasonable reader couldn't have predicted.

## How to use

Each file opens with a one-sentence **"Load this when…"** trigger, followed by a flat list of independent invariants, policies and gotchas. Load the file(s) matching the area you're touching; cross-cutting work needs several.

A new area (new lib, new cross-cutting concern) gets a new file, a row below, **and** a row in the `CLAUDE.md` caveats table.

## Files

| File                               | Load when working on…                                                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`workspace.md`](workspace.md)     | Dependencies, `package.json`, `pnpm-workspace.yaml`, `nx.json`, tsconfig, ESLint/Prettier, new libs, Nx tags, `pnpm verify`.                              |
| [`electron.md`](electron.md)       | `apps/desktop`, `apps/desktop-e2e`, `libs/platform/electron`, `libs/ipc-contract`, the `app://` protocol, CSP, Fuses.                                     |
| [`release.md`](release.md)         | Versioning, `tools/check-version-sync.mjs`, electron-builder config, `release.yml`, auto-update, signing, `/release`.                                     |
| [`save-format.md`](save-format.md) | `libs/domain/save-format` (schemas, migrations, fixtures, settings, JSON Schema), world serialisation, command ids/args in the replay log, load failures. |
