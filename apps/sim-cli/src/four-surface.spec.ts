import { createGame, replayGame } from '@controls/scripting-api';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fourSurface from '../scenarios/four-surface';
import { WORKSPACE_ROOT } from './script-loader';

/*
 * The four-surface scenario, headless (plan F1.6 and the P1 phase acceptance).
 *
 * The four surfaces of plan §4.6 are the palette, keybindings, the console and the scripting API.
 * The palette and keybindings need the Angular UI and are driven in `apps/game-e2e` (F1.3, F1.4);
 * here there is no UI, so the scenario is driven through every **headless** entry point, and all of
 * them must reach FOUR_SURFACE_HASH:
 *
 *   1. the scripting API in-process (`createGame` + the scenario function), which is exactly what
 *      `Session.exec` runs for the palette, keybindings and mouse;
 *   2. `sim run four-surface.ts`: the same scenario as a TypeScript module script;
 *   3. `sim run four-surface.console`: the scenario as console lines, through the parser the in-game
 *      console (F1.5) uses;
 *   4. `sim replay` of the replay log the script run wrote (seed + command log → same hash).
 *
 * 2–4 run the built bundle (`dist/apps/sim-cli/main.mjs`, from the `build` target this `test`
 * target depends on) in a plain `node` child process: no DOM, no test runner, no jsdom.
 */

/** world.hash after the scenario. The game-e2e drivers (mouse, palette, console) must match it. */
export const FOUR_SURFACE_HASH = 'a61268c711b69ba5bafaeeda6ba00d3340eba691322ca3a20255044b669560ee';

const bundle = join(WORKSPACE_ROOT, 'dist/apps/sim-cli/main.mjs');
const scenarios = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios');

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sim-cli-four-surface-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sim(...argv: string[]): { status: number | null; stdout: string[]; stderr: string } {
  const result = spawnSync(process.execPath, [bundle, ...argv], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, INIT_CWD: WORKSPACE_ROOT },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout.split('\n').filter(Boolean), stderr: result.stderr };
}

describe('the four-surface scenario', () => {
  it('has a built sim-cli bundle to drive (the test target depends on build)', () => {
    expect(existsSync(bundle)).toBe(true);
  });

  it('1. scripting API in-process', () => {
    const game = createGame({ seed: 0 });
    fourSurface(game);
    expect(game.hash()).toBe(FOUR_SURFACE_HASH);
    const replayed = replayGame(JSON.parse(JSON.stringify(game.replayLog())));
    expect(replayed.ok && replayed.game.hash()).toBe(FOUR_SURFACE_HASH);
  });

  it('1b. the checked-in console file says exactly what the script does', async () => {
    const game = createGame({ seed: 0 });
    fourSurface(game);
    const commands = (await readFile(join(scenarios, 'four-surface.console'), 'utf8'))
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter((line) => line && line !== 'world.hash');
    expect(commands).toHaveLength(game.entries().length);
    // Same ids in the same order (the console file uses positional ids, so compare ids only here;
    // the hashes below compare the arguments).
    expect(commands.map((line) => line.split(' ')[0])).toEqual(game.entries().map((e) => e.id));
  });

  it('2 + 4. sim run <script.ts> --log, then sim replay <log>', () => {
    const log = join(dir, 'four-surface.replay.json');
    const run = sim('run', join(scenarios, 'four-surface.ts'), '--log', log, '--expect', FOUR_SURFACE_HASH);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toEqual([FOUR_SURFACE_HASH]);

    const replay = sim('replay', log);
    expect(replay.stderr).toBe('');
    expect(replay.stdout).toEqual([FOUR_SURFACE_HASH]);
  });

  it('3. sim run <file.console>', () => {
    const run = sim('run', join(scenarios, 'four-surface.console'));
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    // The file's own `world.hash` line, then the final hash.
    expect(run.stdout).toEqual([FOUR_SURFACE_HASH, FOUR_SURFACE_HASH]);
  });

  it('runs under plain Node with no DOM globals', async () => {
    const probe = join(dir, 'no-dom.ts');
    await writeFile(
      probe,
      `export default () => {
         for (const name of ['window', 'document', 'HTMLElement', 'customElements']) {
           if (name in globalThis) throw new Error(name + ' exists');
         }
       };`,
    );
    const run = sim('run', probe);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('exits non-zero when the hash differs from --expect', () => {
    const run = sim('run', join(scenarios, 'four-surface.console'), '--seed', '1', '--expect', FOUR_SURFACE_HASH);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/hash mismatch/);
  });
});
