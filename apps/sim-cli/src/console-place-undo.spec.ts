import { createGame, runConsoleScript } from '@controls/scripting-api';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from './script-loader';

/*
 * The console's place-then-undo scenario (plan F1.5 E2E): one `entity.place` of a built-in prop,
 * then `edit.undo`. `apps/game-e2e/src/console.spec.ts` types the same lines into the in-game
 * console and must reach CONSOLE_PLACE_UNDO_HASH; here it is pinned headless. (The palette's
 * scenario, `palette-place-undo.console`, is F1.3's and is pinned in `palette-place-undo.spec.ts`.)
 *
 * Undoing the place restores the world exactly, `nextEntityId` included, so the hash is the empty
 * seed-0 world's (`emptySeed0` in `libs/domain/world-model/src/lib/hash.spec.ts`).
 */
export const CONSOLE_PLACE_UNDO_HASH = 'e5e9a9fcd6ab93f0ae928adfc86c01c20c83230a668775fa886e98351ef7a047';

const scenario = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios/console-place-undo.console');
const bundle = join(WORKSPACE_ROOT, 'dist/apps/sim-cli/main.mjs');

describe('the console place-then-undo scenario', () => {
  it('runs in-process to the pinned hash, through the console-line runner', () => {
    const game = createGame({ seed: 0 });
    const result = runConsoleScript(game, readFileSync(scenario, 'utf8'));
    expect(result).toMatchObject({ ok: true, executed: 2 });
    expect(game.entries().map((e) => e.id)).toEqual(['entity.place', 'edit.undo']);
    expect(game.hash()).toBe(CONSOLE_PLACE_UNDO_HASH);
  });

  it('`sim run` prints the same hash', () => {
    const result = spawnSync(process.execPath, [bundle, 'run', scenario, '--expect', CONSOLE_PLACE_UNDO_HASH], {
      cwd: WORKSPACE_ROOT,
      env: { ...process.env, INIT_CWD: WORKSPACE_ROOT },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(CONSOLE_PLACE_UNDO_HASH);
  });
});
