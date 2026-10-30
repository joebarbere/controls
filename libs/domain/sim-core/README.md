# sim-core (`@controls/sim-core`)

Framework-free domain library (`type:domain`): the circuit engine (plan P2): netlist compiler, MNA solvers, the sim clock and engine loop, and device models. It holds:

- `SIM_ENGINE_VERSION` (`src/lib/engine-version.ts`), the engine version every save's manifest records (decision D8, ADR 0013): bump it whenever snapshot or world goldens are re-pinned for numeric reasons;
- sourced constants (`src/lib/constants.ts`), each with a `source`;
- the netlist compiler (F2.1, `src/lib/netlist/`): `compileNetlist`, the incremental `NetlistCompiler`, the per-kind netlist models, `topologyHash` and `formatNetlist`. See the [simulation architecture](../../../docs/architecture/simulation.md) and [caveats](../../../docs/caveats/simulation.md).

`src/testing/` holds spec-only benches (synthetic model kinds), excluded from the lib build.

Besides the domain rules (no Angular, DOM, Electron, Node built-ins or non-domain libs; no `Math.random` or wall clock), **sim-core source may not call engine-dependent `Math` functions** (`Math.exp`, `log*`, `pow`, trigonometric and hyperbolic functions, `hypot`, `cbrt`) **or use `**`**. Node's V8 and Electron's Chromium V8 may round them differently, and a snapshot must be byte-identical in both. Use IEEE-exact operations (`+ - * /`, `Math.sqrt`, `Math.fround`, …) and sim-core's own `dmath` (decision D6 in `plans/phase-2-circuit-engine.md`; ADR 0014, to be written in F2.1). Specs are exempt, so a test can compare `dmath` with `Math`. See the [workspace caveats](../../../docs/caveats/workspace.md). Tests: `pnpm nx test sim-core` (90 % coverage gate).
