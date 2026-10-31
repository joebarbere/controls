import { createGame, ENGINE_CHANGED_MESSAGE, replayGame, runConsoleScript } from '@controls/scripting-api';
import { SIM_ENGINE_VERSION } from '@controls/sim-core';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import benchLeads from '../scenarios/bench-leads';
import { WORKSPACE_ROOT } from './script-loader';
import { WORKSHOP_LEVEL, workshopWorld } from './testing/workshop';

/*
 * The bench-leads scenario (P2 kickoff, world v2): place the battery, switch and lamp, connect three
 * test leads, operate the switch, with undo on a lead and on the switch. Console lines
 * (`scenarios/bench-leads.console`), the TypeScript script (`scenarios/bench-leads.ts`), a replay of
 * the script's log and a save all reach BENCH_LEADS_HASH. `apps/game-e2e/src/console.spec.ts` runs
 * the console file in the game and asserts the same literal: change them together.
 *
 * Since F2.3a the hash covers the materialised solution record. Engines 3 and 4 had no filament model,
 * so the lamp's island was recorded unsolved (0 iterations, zeros); since engine 5 (F2.5) the lamp is
 * modelled and the circuit is solved: the switch is closed, so the lamp is lit at tick 0's solve.
 */
export const BENCH_LEADS_HASH = '562b5681ff82adb4b1576f63cefe8fc1bdbd0f50ba32598ec5b3e9c05d952d26';

/** What engines 3 and 4 (the lamp unmodelled) wrote for the same world. */
const ENGINE_3_HASH = 'b212424590e020f911d20c71041d7f78f66dc2596a7cb7167f77b4e8cd4e6b45';

/** What engine 1 (the world v2 kickoff, before the engine ran) wrote for the same world: `sim: null`. */
const ENGINE_1_HASH = '1825e8bac7eeddaeedd7adeca6a69db204ec65c7dac0d6ab22df5a693c92cead';

const bundle = join(WORKSPACE_ROOT, 'dist/apps/sim-cli/main.mjs');
const scenarios = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios');

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
  dir = await mkdtemp(join(tmpdir(), 'sim-cli-bench-leads-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the bench-leads scenario', () => {
  it('the script, in-process, reaches the pinned hash, and its log replays to it', () => {
    const game = createGame({ world: workshopWorld() });
    benchLeads(game);
    expect(game.hash()).toBe(BENCH_LEADS_HASH);
    expect(game.world().connections.map((c) => c.id)).toEqual([1, 2, 3]);
    const replayed = replayGame(JSON.parse(JSON.stringify(game.replayLog())));
    expect(replayed.ok && replayed.game.hash()).toBe(BENCH_LEADS_HASH);
  });

  it('the console lines log exactly what the script does', async () => {
    const script = createGame({ world: workshopWorld() });
    benchLeads(script);
    const consoleGame = createGame({ world: workshopWorld() });
    const result = await runConsoleScript(consoleGame, await readFile(join(scenarios, 'bench-leads.console'), 'utf8'));
    expect(result).toMatchObject({ ok: true });
    expect(consoleGame.entries()).toStrictEqual(script.entries());
    expect(consoleGame.hash()).toBe(BENCH_LEADS_HASH);
  });

  it('sim run <file.console> and sim run <script.ts> print it', () => {
    const lines = sim('run', join(scenarios, 'bench-leads.console'), '--world', WORKSHOP_LEVEL);
    expect(lines.stderr).toBe('');
    expect(lines.stdout).toEqual([BENCH_LEADS_HASH, BENCH_LEADS_HASH]); // the file's world.hash line, then the final one
    const script = sim(
      'run',
      join(scenarios, 'bench-leads.ts'),
      '--world',
      WORKSHOP_LEVEL,
      '--expect',
      BENCH_LEADS_HASH,
    );
    expect(script.stderr).toBe('');
    expect(script.status).toBe(0);
  });

  it('sim run --save, then sim replay and sim hash on the save, reach it too', () => {
    const save = join(dir, 'bench-leads.ctrl');
    const run = sim('run', join(scenarios, 'bench-leads.console'), '--world', WORKSHOP_LEVEL, '--save', save);
    expect(run.status).toBe(0);
    for (const command of ['replay', 'hash']) {
      const result = sim(command, save, '--expect', BENCH_LEADS_HASH);
      expect(result.stderr).toBe('');
      expect(result.stdout).toEqual([BENCH_LEADS_HASH]);
    }
  });

  it('the engine-3 fixture of this scenario replays to the new hash, which is no longer its world.json (F2.5)', () => {
    const fixture = join(WORKSPACE_ROOT, 'libs/domain/save-format/fixtures/v2/ctrl/bench-leads-engine-3.ctrl');
    expect(sim('hash', fixture).stdout).toEqual([ENGINE_3_HASH]);
    const replay = sim('replay', fixture);
    expect(replay.status).toBe(1);
    expect(replay.stderr).toContain(`replays to ${BENCH_LEADS_HASH}, but world.json hashes to ${ENGINE_3_HASH}`);
    expect(replay.stderr).toContain(
      `written by sim engine 3, catalogue 1; this build is engine ${SIM_ENGINE_VERSION}, catalogue 1`,
    );
  });

  it('the engine-1 fixture (written before the engine ran) is not reproduced, and loads as engine-changed (D8)', () => {
    const fixture = join(WORKSPACE_ROOT, 'libs/domain/save-format/fixtures/v2/ctrl/bench-leads.ctrl');
    expect(sim('hash', fixture).stdout).toEqual([ENGINE_1_HASH]);
    const replay = sim('replay', fixture);
    expect(replay.status).toBe(1);
    expect(replay.stderr).toContain(`replays to ${BENCH_LEADS_HASH}, but world.json hashes to ${ENGINE_1_HASH}`);
    expect(replay.stderr).toContain(
      `written by sim engine 1, catalogue 1; this build is engine ${SIM_ENGINE_VERSION}, catalogue 1`,
    );
    expect(replay.stderr).toContain(ENGINE_CHANGED_MESSAGE);
    expect(replay.stderr).toContain(`"sim run <empty.console> --world ${fixture}"`);
    expect(replay.stderr).toContain(`"sim hash ${fixture}"`);
    // Loaded as the game loads it: world.json as saved, a new log, and the engine solves at the start.
    const empty = join(dir, 'empty.console');
    writeFileSync(empty, '');
    const run = sim('run', empty, '--world', fixture);
    expect(run.stderr).toContain(ENGINE_CHANGED_MESSAGE);
    expect(run.stdout).toEqual([BENCH_LEADS_HASH]);
  });
});
