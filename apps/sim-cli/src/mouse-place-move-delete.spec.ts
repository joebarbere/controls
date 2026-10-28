import { createGame, runConsoleScript } from '@controls/scripting-api';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import mousePlaceMoveDelete from '../scenarios/mouse-place-move-delete';
import { WORKSPACE_ROOT } from './script-loader';
import { WORKSHOP_LEVEL, workshopWorld } from './testing/workshop';

/*
 * F1.7: place, move and delete with the mouse gives the same `world.hash` as the equivalent console
 * lines. The mouse half is `apps/game-e2e/src/placement.spec.ts`, which must end at this same
 * literal (e2e projects can't import workspace code, so the value is repeated there: change both
 * or neither). Here the console lines run through `sim run`, and a script that snaps with the
 * renderer's maths (`placeOnTargets`) must agree with them entry for entry.
 */

/** world.hash after `mouse-place-move-delete.console`. The game-e2e mouse driver must match it. */
export const MOUSE_PLACE_MOVE_DELETE_HASH = '827d9590df526f216a734cd4015b93d2af5369e66c97b799cbbd0458edaa0997';

const bundle = join(WORKSPACE_ROOT, 'dist/apps/sim-cli/main.mjs');
const scenarios = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios');
const consoleFile = join(scenarios, 'mouse-place-move-delete.console');

function sim(...argv: string[]): { status: number | null; stdout: string[]; stderr: string } {
  const result = spawnSync(process.execPath, [bundle, ...argv], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, INIT_CWD: WORKSPACE_ROOT },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout.split('\n').filter(Boolean), stderr: result.stderr };
}

describe('the mouse place / move / delete scenario (F1.7)', () => {
  it('sim run <file.console> reaches the golden hash', () => {
    const run = sim('run', consoleFile, '--world', WORKSHOP_LEVEL, '--expect', MOUSE_PLACE_MOVE_DELETE_HASH);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    // The file's own `world.hash` line, then the final hash.
    expect(run.stdout).toEqual([MOUSE_PLACE_MOVE_DELETE_HASH, MOUSE_PLACE_MOVE_DELETE_HASH]);
  });

  it('sim run <script.ts>, snapping like the mouse, reaches it too', () => {
    const run = sim(
      'run',
      join(scenarios, 'mouse-place-move-delete.ts'),
      '--world',
      WORKSHOP_LEVEL,
      '--expect',
      MOUSE_PLACE_MOVE_DELETE_HASH,
    );
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('the console lines and the snapping script log identical entries', async () => {
    const fromConsole = createGame({ world: workshopWorld() });
    const result = runConsoleScript(fromConsole, await readFile(consoleFile, 'utf8'));
    expect(result.ok).toBe(true);
    const fromScript = createGame({ world: workshopWorld() });
    mousePlaceMoveDelete(fromScript);
    expect(fromConsole.entries()).toEqual(fromScript.entries());
    expect(fromScript.hash()).toBe(MOUSE_PLACE_MOVE_DELETE_HASH);
    expect(fromScript.entries().map((e) => e.id)).toEqual([
      'toolbelt.select',
      'entity.place',
      'toolbelt.select',
      'entity.place',
      'entity.move',
      'entity.delete',
    ]);
    expect(fromScript.world().entities).toEqual([
      expect.objectContaining({ id: 1, transform: expect.objectContaining({ positionMm: { x: -75, y: 110, z: 0 } }) }),
    ]);
  });
});
