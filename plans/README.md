# Plans

Per-phase implementation plans. Each phase's plan is written at its kickoff (plan §6: use the Plan agent), breaks the phase scope from [`controls-development-plan.md`](../controls-development-plan.md) into features `FN.x` with acceptance criteria, and tracks their status. One feature per PR.

The development plan is the spec. If a phase plan has to deviate from it, change the development plan first (or record the deviation in the phase plan and an ADR) rather than drifting quietly.

| Phase  | Plan                                | Release | Status         |
| ------ | ----------------------------------- | ------- | -------------- |
| P0     | [Foundation](phase-0-foundation.md) | v0.1.0  | ✅ Done        |
| P1     | [Game shell](phase-1-game-shell.md) | v0.2.0  | 🚧 In progress |
| P2–P13 | See plan §6                         | —       | 📐 Planned     |

**At each phase close-out:** `docs-keeper` sync → `version-keeper` minor bump → `release-engineer` release and installer smoke test, then mark the plan done here and in [`docs/history.md`](../docs/history.md).
