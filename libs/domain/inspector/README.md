# inspector (`@controls/inspector`)

Framework-free domain library (`type:domain`): the electrical inspector (plan P4 decision D13, spec v1.6 §4.2; ADR 0022 in F4.5). A rules engine over the world, the catalogue and the region profile: check kinds are code (a registry, like `MODEL_KINDS`), rule sets are data (`content/rules/`, mirrored by the catalogue from catalogue v3). Connectivity comes from `sim-core`'s `wiringGraph`, so the inspector and the simulator never disagree about what is connected. Findings are derived, never stored or hashed. It may depend on `@controls/catalog`, `@controls/save-format`, `@controls/world-model` and `@controls/sim-core`.

Scaffolding only until F4.5 part 1; `src/lib/package.ts` is a placeholder so the coverage gate has source to measure. Delete it when real code lands.

Must not depend on Angular, the DOM, Electron, Node built-ins or any non-`type:domain` lib, and must stay deterministic: the determinism lint and the D6 maths lint (no `Math.hypot`, `**` or transcendentals; `Math.sqrt` only) cover its source ([workspace caveats](../../../docs/caveats/workspace.md)). Tests: `pnpm nx test inspector` (90 % coverage gate).
