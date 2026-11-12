import { createGame, runConsoleScript } from '@controls/scripting-api';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import dinPanelBreaker from '../scenarios/din-panel-breaker';
import { WORKSPACE_ROOT } from './script-loader';
import { WORKSHOP_LEVEL, workshopWorld } from './testing/workshop';

/*
 * F3.5 part 1: the DIN panel placed on the backplate with the mouse and the 15 A breaker snapped onto
 * its rail with the keyboard reticle and the mouse give the same `world.hash` as the equivalent
 * console lines. The input half is `apps/game-e2e/src/enclosures.spec.ts`, which must end at this
 * same literal (e2e projects can't import workspace code: change both or neither). A script that
 * snaps with the renderer's maths (`placeInWorld`) must agree with the console entry for entry.
 */

/** world.hash after `din-panel-breaker.console`. The game-e2e driver must match it. */
export const DIN_PANEL_BREAKER_HASH = '7901fbdffe8ca1ee86a6a4259af12d356e79b3fa51a157f8c3ad719d0687ac15';

const bundle = join(WORKSPACE_ROOT, 'dist/apps/sim-cli/main.mjs');
const scenarios = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios');
const consoleFile = join(scenarios, 'din-panel-breaker.console');

function sim(...argv: string[]): { status: number | null; stdout: string[]; stderr: string } {
  const result = spawnSync(process.execPath, [bundle, ...argv], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, INIT_CWD: WORKSPACE_ROOT },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout.split('\n').filter(Boolean), stderr: result.stderr };
}

describe('the DIN panel and breaker scenario (F3.5 part 1)', () => {
  it('sim run <file.console> reaches the golden hash', () => {
    const run = sim('run', consoleFile, '--world', WORKSHOP_LEVEL, '--expect', DIN_PANEL_BREAKER_HASH);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toEqual([DIN_PANEL_BREAKER_HASH, DIN_PANEL_BREAKER_HASH]);
  });

  it('sim run <script.ts>, snapping like the mouse, reaches it too', () => {
    const script = join(scenarios, 'din-panel-breaker.ts');
    const run = sim('run', script, '--world', WORKSHOP_LEVEL, '--expect', DIN_PANEL_BREAKER_HASH);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('the console lines and the snapping script log identical entries, mountedOn included', async () => {
    const fromConsole = createGame({ world: workshopWorld() });
    const result = await runConsoleScript(fromConsole, await readFile(consoleFile, 'utf8'));
    expect(result.ok).toBe(true);
    const fromScript = createGame({ world: workshopWorld() });
    dinPanelBreaker(fromScript);
    expect(fromConsole.entries()).toEqual(fromScript.entries());
    expect(fromScript.hash()).toBe(DIN_PANEL_BREAKER_HASH);
    expect(fromScript.world().entities.map((e) => [e.id, e.ref.id, e.transform.positionMm, e.mountedOn])).toEqual([
      [1, 'panel.pellmoor-din-400x500', { x: -200, y: -200, z: 0 }, null],
      [2, 'breaker.saltmere-1p-15a', { x: -25, y: 105, z: 22 }, { entity: 1, mount: 'rail-1' }],
      [3, 'breaker.saltmere-1p-15a', { x: -112, y: 105, z: 22 }, { entity: 1, mount: 'rail-1' }],
    ]);
    // The occupied panel refuses to go or move (the e2e checks the toast that says so).
    expect(fromScript.exec('entity.delete', { id: 1 })).toMatchObject({ ok: false, error: { code: 'occupied' } });
    expect(fromScript.exec('entity.move', { id: 1, positionMm: { x: 0, y: 0, z: 0 } })).toMatchObject({
      ok: false,
      error: { code: 'occupied' },
    });
    expect(fromScript.hash()).toBe(DIN_PANEL_BREAKER_HASH);
  });
});
