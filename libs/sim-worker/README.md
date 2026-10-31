# sim-worker (`@controls/sim-worker`)

The sim worker (`type:worker`, plan F2.3b, [ADR 0011](../../docs/decisions/0011-sim-worker-contract.md)): the module Web Worker that runs `sim-core` off the main thread and publishes snapshots through `@controls/sim-protocol`.

- `src/worker.ts`: the entry `apps/game` constructs (`new Worker(new URL(…), { type: 'module' })`). It imports `lib/jitless.ts` first (Zod without its eval probe, so the CSP never fires), then `startSimWorker(self)`.
- `src/lib/runner.ts`: `SimWorkerRunner`, the inbox and run loop (mirror bus, engine, ordered queries, slicing, publishing over the shared buffer or by message).
- `src/lib/entry.ts`: the scope wiring (messages, `error`, `unhandledrejection`, `messageerror` and `securitypolicyviolation` become `error` messages) and the `MessageChannel` scheduler.
- `src/lib/in-process.ts`: `createInProcessSimWorker`, the real runner on the calling thread, for app specs only.
- `src/lib/pacing/worker-clock.ts`: the worker's only wall clock (slicing, the publish throttle, diagnostics).
- `src/testing/runner-harness.ts`: a deterministic host for runner specs.

Main-thread pacing (the tick targets) is `Pacer` in `@controls/sim-protocol`, driven by `SimHost`.

Rules (root `eslint.config.mjs`, [workspace caveats](../../docs/caveats/workspace.md)):

- **Depends only on `type:domain` libs**, with the same banned npm imports as domain code (no Angular, Three.js, Electron, …). Nothing but an app may depend on it: the renderer and features read snapshot types from `@controls/sim-protocol`.
- **`webworker` lib, no DOM, no ambient Node types** (`tsconfig.json`), and no Node built-ins in source.
- **Deterministic**, like domain code (no `Math.random`, wall clock or `crypto`), except [`src/lib/pacing/`](src/lib/pacing/README.md), which may read the wall clock.
- Tests: `pnpm nx test sim-worker`, with the domain 90 % coverage gate.
