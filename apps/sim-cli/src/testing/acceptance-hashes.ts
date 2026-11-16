import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from '../script-loader';

/*
 * The P3 phase acceptance's pinned hashes (`apps/sim-cli/scenarios/acceptance-hashes.json`): plain data
 * beside the scenarios, so the browser and desktop acceptance e2e read the same file (with `fs`, as they
 * read the `.console` files) instead of importing a Vitest spec. `lamp-circuit.spec.ts` and
 * `bad-termination.spec.ts` check every value; re-pin them in the JSON, never in an e2e alone. In the
 * game, `world.hash` and the session hook's `snapshotHash()` give the values to compare.
 */

export interface AcceptanceHashes {
  readonly lampCircuit: {
    /** `world.hash` 1.5 s after the breaker closed (the console file's first `world.hash`). */
    readonly litHash: string;
    readonly litSnapshotHash: string;
    /** At the end: 0.5 s after the breaker opened (its second `world.hash`). */
    readonly hash: string;
    readonly snapshotHash: string;
  };
  readonly badTermination: { readonly hash: string; readonly snapshotHash: string };
}

/** Workspace-relative path of the hashes file. */
export const ACCEPTANCE_HASHES_FILE = 'apps/sim-cli/scenarios/acceptance-hashes.json';

export const ACCEPTANCE_HASHES = JSON.parse(
  readFileSync(join(WORKSPACE_ROOT, ACCEPTANCE_HASHES_FILE), 'utf8'),
) as AcceptanceHashes;
