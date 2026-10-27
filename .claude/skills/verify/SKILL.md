---
name: verify
description: Run the full local verification that mirrors CI exactly (pnpm verify - prettier --check, nx lint/typecheck/test/build for all projects, and the version-sync check). Use before committing, before opening a PR, after a refactor, or whenever asked to "verify", "check everything" or "make sure CI will pass".
---

# /verify

`pnpm verify` runs exactly what CI runs, including `prettier --check`. A green `/verify` means CI's checks will pass; anything less is not green.

## Procedure

1. Run `pnpm verify` from the repo root. Let it finish; don't run a subset instead.
2. **If it fails only on formatting** (the `prettier --check` step lists files): run `pnpm format`, then run `pnpm verify` again from the start. Mention which files were reformatted.
3. **If anything else fails** (lint, typecheck, test, build, `check-version-sync`): don't paper over it. Read the failure, and either fix it if the cause is clear and within the current task, or stop and report it. Never skip, disable or loosen a check, test or lint rule to get green. If `check-version-sync` fails, route to `version-keeper` (don't hand-edit generated version files).
4. Re-run until green or until you've hit a failure you can't fix.

## Report

Report honestly and briefly:

- **Result:** green, or red with the failing step(s).
- What you changed to get there (for example "ran `pnpm format`, reformatted 3 files").
- For each remaining failure: the project/target, the first relevant error lines, and your read of the cause.

Never say "verify passed" unless the final full `pnpm verify` run exited 0.
