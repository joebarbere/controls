import { createGame, replayGame, runConsoleScript } from '@controls/scripting-api';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import phaseAcceptance from '../scenarios/phase-acceptance';
import { WORKSPACE_ROOT } from './script-loader';
import { WORKSHOP_LEVEL, workshopWorld } from './testing/workshop';

/*
 * The P1 phase acceptance, headless half: one scenario (place, move and delete with undo and redo)
 * and four drivers. The mouse, the palette and the in-game console drive it in
 * `apps/game-e2e/src/phase-acceptance.spec.ts`, which must end at this same literal (e2e projects
 * can't import workspace code: change both or neither). Here `sim run` drives it as a snapping
 * TypeScript script and as console lines, and `sim replay` replays the script's log, a save of it
 * and the save loaded back.
 */

/** world.hash after `phase-acceptance.console`. Every game-e2e driver must match it. */
export const PHASE_ACCEPTANCE_HASH = 'e562d0b942b5f02222cde571b9a637bc6f04f12d0097df0c546bb986c9af31d2';

/** The logged command ids, in order: the same on every surface. */
const LOGGED = [
  'toolbelt.select',
  'entity.place',
  'toolbelt.select',
  'entity.place',
  'entity.move',
  'entity.delete',
  'edit.undo',
  'edit.redo',
  'edit.undo',
];

const bundle = join(WORKSPACE_ROOT, 'dist/apps/sim-cli/main.mjs');
const scenarios = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios');
const consoleFile = join(scenarios, 'phase-acceptance.console');

function sim(...argv: string[]): { status: number | null; stdout: string[]; stderr: string } {
  const result = spawnSync(process.execPath, [bundle, ...argv], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, INIT_CWD: WORKSPACE_ROOT },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout.split('\n').filter(Boolean), stderr: result.stderr };
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sim-cli-phase-acceptance-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the P1 phase-acceptance scenario', () => {
  it('the snapping script and the console lines log identical entries and reach the golden hash', async () => {
    const fromScript = createGame({ world: workshopWorld() });
    phaseAcceptance(fromScript);
    const fromConsole = createGame({ world: workshopWorld() });
    expect((await runConsoleScript(fromConsole, await readFile(consoleFile, 'utf8'))).ok).toBe(true);

    expect(fromScript.entries()).toEqual(fromConsole.entries());
    expect(fromScript.entries().map((e) => e.id)).toEqual(LOGGED);
    expect(fromScript.hash()).toBe(PHASE_ACCEPTANCE_HASH);
    // The box sits on DIN rail 1; the crate is back where it was placed, with its own id.
    expect(fromScript.world().entities).toEqual([
      expect.objectContaining({ id: 1, transform: expect.objectContaining({ positionMm: { x: -75, y: 110, z: 0 } }) }),
      expect.objectContaining({ id: 2, transform: expect.objectContaining({ positionMm: { x: -50, y: -300, z: 0 } }) }),
    ]);
    const replayed = replayGame(JSON.parse(JSON.stringify(fromScript.replayLog())));
    expect(replayed.ok && replayed.game.hash()).toBe(PHASE_ACCEPTANCE_HASH);
  });

  it('sim run <script.ts> --log, then sim replay <log>', () => {
    const log = join(dir, 'phase-acceptance.replay.json');
    const run = sim(
      'run',
      join(scenarios, 'phase-acceptance.ts'),
      '--world',
      WORKSHOP_LEVEL,
      '--log',
      log,
      '--expect',
      PHASE_ACCEPTANCE_HASH,
    );
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toEqual([PHASE_ACCEPTANCE_HASH]);

    const replay = sim('replay', log, '--expect', PHASE_ACCEPTANCE_HASH);
    expect(replay.stderr).toBe('');
    expect(replay.stdout).toEqual([PHASE_ACCEPTANCE_HASH]);
  });

  it('sim run <file.console> --save, then the save replays, hashes and loads to the same hash', () => {
    const save = join(dir, 'phase-acceptance.ctrl');
    const run = sim('run', consoleFile, '--world', WORKSHOP_LEVEL, '--save', save);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    // The file's own `world.hash` line, then the final hash.
    expect(run.stdout).toEqual([PHASE_ACCEPTANCE_HASH, PHASE_ACCEPTANCE_HASH]);
    for (const command of ['replay', 'hash']) {
      const result = sim(command, save, '--expect', PHASE_ACCEPTANCE_HASH);
      expect(result.stderr).toBe('');
      expect(result.stdout).toEqual([PHASE_ACCEPTANCE_HASH]);
    }
  });
});
