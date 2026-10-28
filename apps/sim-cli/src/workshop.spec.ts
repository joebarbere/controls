import { createGame } from '@controls/scripting-api';
import { placeOnTargets, worldHash, worldSnapTargets } from '@controls/world-model';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from './script-loader';
import { WORKSHOP_LEVEL, workshopWorld } from './testing/workshop';

/*
 * F1.9: the workshop level runs headless. `pnpm sim hash content/levels/workshop.json` is this
 * bundle with these arguments (`bin/sim.mjs` only rebuilds it first), run from the workspace root in
 * a plain `node` child process. WORKSHOP_HASH is also `workshopSeed0` in
 * `libs/domain/world-model/src/lib/hash.spec.ts` and `apps/game-e2e/src/world-hash.spec.ts`
 * (New sandbox with seed 0 in Chromium): change all three or none.
 */

/** world.hash of `content/levels/workshop.json` (seed 0). */
export const WORKSHOP_HASH = 'c1ebfb55cff641f18c069027eb0d096900a573e70a3f35a03b73baff75500825';

const bundle = join(WORKSPACE_ROOT, 'dist/apps/sim-cli/main.mjs');

function sim(...argv: string[]): { status: number | null; stdout: string[]; stderr: string } {
  const result = spawnSync(process.execPath, [bundle, ...argv], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, INIT_CWD: WORKSPACE_ROOT },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout.split('\n').filter(Boolean), stderr: result.stderr };
}

describe('the workshop level, headless (F1.9)', () => {
  it('sim hash content/levels/workshop.json prints the golden hash', () => {
    const run = sim('hash', WORKSHOP_LEVEL, '--expect', WORKSHOP_HASH);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toEqual([WORKSHOP_HASH]);
    expect(worldHash(workshopWorld())).toBe(WORKSHOP_HASH);
  });

  it('a script snaps props onto every workshop surface: backplate, DIN rail, stud wall and bench', () => {
    const game = createGame({ world: workshopWorld() });
    const targets = worldSnapTargets(game.world());
    const place = (id: string, cursor: { x: number; y: number; z: number }) => {
      const ref = { id, version: 1 };
      const placed = placeOnTargets(ref, cursor, targets);
      if (!placed.ok) throw new Error(`${id} at ${JSON.stringify(cursor)}: ${placed.reason}`);
      game.execOrThrow('entity.place', { ref, positionMm: placed.positionMm, orientationMdeg: placed.orientationMdeg });
      return placed.targetId;
    };
    expect([
      place('prop.box', { x: -150, y: 300, z: 0 }),
      place('prop.box', { x: -10, y: 150, z: 7 }),
      place('prop.box', { x: -2000, y: 0, z: -21 }),
      place('prop.crate', { x: 1600, y: -300, z: 455 }),
      place('prop.spool', { x: 1000, y: -300, z: 300 }),
    ]).toEqual(['backplate', 'din-rail-1', 'stud-wall', 'bench', 'bench']);
    expect(game.world().entities.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
    expect(game.world().fixtures).toEqual(workshopWorld().fixtures); // no command touches the level
  });
});
