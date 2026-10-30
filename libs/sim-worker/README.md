# sim-worker (`@controls/sim-worker`)

The sim worker (`type:worker`, plan F2.3b): the module Web Worker entry that runs `sim-core` off the main thread, writes snapshots through `@controls/sim-protocol`, and paces the sim against the wall clock. Scaffolding only until F2.3b; `src/lib/package.ts` is a placeholder so the coverage gate has source to measure.

Rules (root `eslint.config.mjs`, [workspace caveats](../../docs/caveats/workspace.md)):

- **Depends only on `type:domain` libs**, with the same banned npm imports as domain code (no Angular, Three.js, Electron, …). Nothing but an app may depend on it: the renderer and features read snapshot types from `@controls/sim-protocol`.
- **`webworker` lib, no DOM, no ambient Node types** (`tsconfig.json`), and no Node built-ins in source.
- **Deterministic**, like domain code (no `Math.random`, wall clock or `crypto`), except [`src/lib/pacing/`](src/lib/pacing/README.md), which may read the wall clock.
- Tests: `pnpm nx test sim-worker`, with the domain 90 % coverage gate.
