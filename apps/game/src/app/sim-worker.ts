import type { Provider } from '@angular/core';
import { fromDomWorker, SIM_WORKER_FACTORY } from '@controls/feature-session';
import type { SimWorkerLike } from '@controls/sim-protocol';

/**
 * The game's sim worker (ADR 0011 §10). The constructor must stay **literal**,
 * `new Worker(new URL('…', import.meta.url), { type: 'module' })`, alone in this module: that is the
 * form `@angular/build` rewrites into a bundled module worker served from `'self'` (never `blob:`).
 * Features never import the worker; `SimHost` gets this factory through `SIM_WORKER_FACTORY`.
 * The worker is type-checked by `sim-worker`'s own `typecheck` target, not by the game build.
 */
export function createSimWorker(): SimWorkerLike {
  return fromDomWorker(
    new Worker(new URL('../../../../libs/sim-worker/src/worker', import.meta.url), { type: 'module' }),
  );
}

/** Provides {@link createSimWorker} as the session's worker factory. */
export const provideSimWorker = (): Provider => ({ provide: SIM_WORKER_FACTORY, useValue: createSimWorker });
