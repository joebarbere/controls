import { createGame } from '@controls/scripting-api';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from './script-loader';
import { WORKSHOP_LEVEL, workshopWorld } from './testing/workshop';

/*
 * The F1.3 palette path, headless. `apps/game-e2e/src/palette.spec.ts` places two props and undoes
 * the second using only the palette and the keyboard, then asserts PALETTE_PLACE_UNDO_HASH and that
 * its replay log has the command ids of `scenarios/palette-place-undo.console` (`palette.open` is
 * unlogged UI chrome, so neither contains it). Here the same file
 * runs through `sim run` (the console-line parser the in-game console uses), so the palette path is
 * checked against the console-line path. Change the literal here and in the e2e spec together.
 */

/** world.hash after the palette scenario: one crate left, `nextEntityId` 2. */
export const PALETTE_PLACE_UNDO_HASH = '82b7578708f2759b91a17b49188f1da4cfdf65a7699dfe457cc3f7e930d77362';

const bundle = join(WORKSPACE_ROOT, 'dist/apps/sim-cli/main.mjs');
const scenario = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios/palette-place-undo.console');

describe('the palette place-and-undo scenario', () => {
  it('sim run <palette-place-undo.console> prints the golden hash', () => {
    const result = spawnSync(
      process.execPath,
      [bundle, 'run', scenario, '--world', WORKSHOP_LEVEL, '--expect', PALETTE_PLACE_UNDO_HASH],
      {
        cwd: WORKSPACE_ROOT,
        env: { ...process.env, INIT_CWD: WORKSPACE_ROOT },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    // The file's own `world.hash` line, then the final hash.
    expect(result.stdout.split('\n').filter(Boolean)).toEqual([PALETTE_PLACE_UNDO_HASH, PALETTE_PLACE_UNDO_HASH]);
  });

  it('matches the scripting API with the args the palette form sends', () => {
    // The palette's form always sends the defaulted orientation; the console line leaves it out.
    const game = createGame({ world: workshopWorld() });
    const zero = { yaw: 0, pitch: 0, roll: 0 };
    expect(game.execOrThrow('palette.open')).toBeNull(); // UI chrome: runs, but is never logged
    game.execOrThrow('entity.place', {
      ref: { id: 'prop.crate', version: 1 },
      positionMm: { x: 100, y: 0, z: -200 },
      orientationMdeg: zero,
    });
    expect(game.execOrThrow('palette.open')).toBeNull();
    game.execOrThrow('entity.place', {
      ref: { id: 'prop.spool', version: 1 },
      positionMm: { x: 400, y: 0, z: -200 },
      orientationMdeg: zero,
    });
    expect(game.execOrThrow('palette.open')).toBeNull();
    game.execOrThrow('edit.undo');
    expect(game.entries().map((e) => e.id)).toEqual(['entity.place', 'entity.place', 'edit.undo']);
    expect(game.world().entities.map((e) => e.ref.id)).toEqual(['prop.crate']);
    expect(game.hash()).toBe(PALETTE_PLACE_UNDO_HASH);
  });
});
