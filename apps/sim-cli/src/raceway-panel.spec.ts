import { createGame, runConsoleScript } from '@controls/scripting-api';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import racewayPanel from '../scenarios/raceway-panel';
import { WORKSPACE_ROOT } from './script-loader';
import { WORKSHOP_LEVEL, workshopWorld } from './testing/workshop';

/*
 * F3.5 part 2: wire duct, DIN terminal blocks and an EMT-lite run on the DIN panel. The snapping
 * script (`placeInWorld`, the renderer's maths) and the console lines that spell its entries out
 * reach one pinned `world.hash`, and log identical entries.
 */

/** world.hash after `raceway-panel.console`. */
export const RACEWAY_PANEL_HASH = 'e3b597900736a54c6e6c3726a0c248fe3bdb1ae0276dae3324f91c0344b48b26';

const bundle = join(WORKSPACE_ROOT, 'dist/apps/sim-cli/main.mjs');
const scenarios = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios');
const consoleFile = join(scenarios, 'raceway-panel.console');

function sim(...argv: string[]): { status: number | null; stdout: string[]; stderr: string } {
  const result = spawnSync(process.execPath, [bundle, ...argv], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, INIT_CWD: WORKSPACE_ROOT },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout.split('\n').filter(Boolean), stderr: result.stderr };
}

describe('the raceway panel scenario (F3.5 part 2)', () => {
  it('sim run <file.console> reaches the golden hash', () => {
    const run = sim('run', consoleFile, '--world', WORKSHOP_LEVEL, '--expect', RACEWAY_PANEL_HASH);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toEqual([RACEWAY_PANEL_HASH, RACEWAY_PANEL_HASH]);
  });

  it('sim run <script.ts>, snapping like the mouse, reaches it too', () => {
    const run = sim(
      'run',
      join(scenarios, 'raceway-panel.ts'),
      '--world',
      WORKSHOP_LEVEL,
      '--expect',
      RACEWAY_PANEL_HASH,
    );
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('the console lines and the snapping script log identical entries; the parts are where the maths says', async () => {
    const fromConsole = createGame({ world: workshopWorld() });
    const result = await runConsoleScript(fromConsole, await readFile(consoleFile, 'utf8'));
    expect(result.ok).toBe(true);
    const fromScript = createGame({ world: workshopWorld() });
    racewayPanel(fromScript);
    expect(fromConsole.entries()).toEqual(fromScript.entries());
    expect(fromScript.hash()).toBe(RACEWAY_PANEL_HASH);
    const world = fromScript.world();
    expect(world.entities.map((e) => [e.id, e.ref.id, e.transform.positionMm, e.mountedOn?.mount ?? null])).toEqual([
      [1, 'panel.pellmoor-din-400x500', { x: -200, y: -200, z: 0 }, null],
      [2, 'duct.lattisby-40x60', { x: -150, y: 70, z: 14 }, 'plate'],
      [3, 'tb.quennick-st4', { x: -69, y: 126, z: 22 }, 'rail-1'],
      [4, 'tb.quennick-st4', { x: -63, y: 126, z: 22 }, 'rail-1'],
      [5, 'tb.quennick-pe4', { x: -57, y: 126, z: 22 }, 'rail-1'],
      [6, 'tb.quennick-sc25', { x: -45, y: 122, z: 22 }, 'rail-1'],
      [7, 'connector.stavenor-emt-075', { x: -117, y: -200, z: 83 }, null],
      [8, 'emt.stavenor-075', { x: -112, y: -225, z: 88 }, null],
      [9, 'elbow.stavenor-emt-075', { x: -88, y: -525, z: 88 }, null],
    ]);
    expect(world.entities[1].state).toEqual({ coverOn: true, lengthMm: 250 });
    expect(world.entities[7].state).toEqual({ lengthMm: 300 });
    // The panel holds mounted parts, so it refuses to move.
    expect(fromScript.exec('entity.move', { id: 1, positionMm: { x: 0, y: 0, z: 0 } })).toMatchObject({
      ok: false,
      error: { code: 'occupied' },
    });
    expect(fromScript.hash()).toBe(RACEWAY_PANEL_HASH);
  });
});
