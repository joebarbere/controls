import { createGame, runConsoleScript } from '@controls/scripting-api';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from './script-loader';
import { WORKSHOP_LEVEL, workshopWorld } from './testing/workshop';

/*
 * The console's place-then-undo scenario (plan F1.5 E2E): one `entity.place` of a built-in prop,
 * then `edit.undo`. `apps/game-e2e/src/console.spec.ts` types the same lines into the in-game
 * console and must reach CONSOLE_PLACE_UNDO_HASH; here it is pinned headless. (The palette's
 * scenario, `palette-place-undo.console`, is F1.3's and is pinned in `palette-place-undo.spec.ts`.)
 *
 * It starts from the workshop level (New sandbox with seed 0, F1.9). Undoing the place restores the
 * world exactly, `nextEntityId` included, so the hash is the workshop's own (`WORKSHOP_HASH` in
 * `workshop.spec.ts`, `workshopSeed0` in `libs/domain/world-model/src/lib/hash.spec.ts`).
 */
export const CONSOLE_PLACE_UNDO_HASH = 'c1ebfb55cff641f18c069027eb0d096900a573e70a3f35a03b73baff75500825';

const scenario = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios/console-place-undo.console');
const bundle = join(WORKSPACE_ROOT, 'dist/apps/sim-cli/main.mjs');

describe('the console place-then-undo scenario', () => {
  it('runs in-process to the pinned hash, through the console-line runner', () => {
    const game = createGame({ world: workshopWorld() });
    const result = runConsoleScript(game, readFileSync(scenario, 'utf8'));
    expect(result).toMatchObject({ ok: true, executed: 2 });
    expect(game.entries().map((e) => e.id)).toEqual(['entity.place', 'edit.undo']);
    expect(game.hash()).toBe(CONSOLE_PLACE_UNDO_HASH);
  });

  it('`sim run` prints the same hash', () => {
    const result = spawnSync(
      process.execPath,
      [bundle, 'run', scenario, '--world', WORKSHOP_LEVEL, '--expect', CONSOLE_PLACE_UNDO_HASH],
      {
        cwd: WORKSPACE_ROOT,
        env: { ...process.env, INIT_CWD: WORKSPACE_ROOT },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(CONSOLE_PLACE_UNDO_HASH);
  });
});
