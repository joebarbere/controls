---
name: docs-sync
description: Bring the documentation in sync with the current branch by running the docs-keeper agent on the branch diff (README, CHANGELOG [Unreleased], docs/*, plans/ checklists, CLAUDE.md status and routing). Use before opening a PR, after a feature or fix lands, or when asked whether the docs are up to date.
---

# /docs-sync

## Procedure

1. Work out the change set:
   - If `main` exists and the branch has commits beyond it: `git diff main...HEAD --stat` and `git log main..HEAD --oneline`.
   - Otherwise (no commits yet, or working on `main`): `git status --short` and `git diff --stat` for the working tree, plus untracked files.
2. Invoke the **`docs-keeper`** agent with that change set, the feature IDs (`FN.x`) it can see in the branch name, commits or `plans/`, and the instruction to follow its rules (never change code, never fabricate behaviour, prettier-format the Markdown it touches).
3. When it finishes, run `pnpm exec prettier --check` on the files it touched. If it fails, run `pnpm exec prettier --write` on those files.

## Report

Relay the docs-keeper output: the files touched and why, any unresolved drift (docs and code disagreeing), and any ADR it recommends. Don't claim the docs are in sync if it reported unresolved drift.
