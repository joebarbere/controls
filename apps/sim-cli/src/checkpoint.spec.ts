import { readCtrl, type ReplayLog } from '@controls/save-format';
import { createGame, type Game, loadGame, MAX_VERIFY_TICKS, runConsoleScript } from '@controls/scripting-api';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from './script-loader';
import { currentFixture } from './testing/fixtures';
import { WORKSHOP_LEVEL, workshopWorld } from './testing/workshop';

/*
 * The checkpoint scenario (P3 kickoff step 4, decision D19): 25 s of the bench lamp switched across
 * the save checkpoints at 10 000 and 20 000 ticks. `sim run --save` writes a log rebased onto the
 * checkpoint at 20 000, `sim replay` replays it to `world.json`'s hash, and loading it (`sim run
 * --world <save>`) continues the log instead of restarting it as too long to verify. Headless and
 * the CLI give the same hash; no golden is pinned (the game-e2e drivers don't run this scenario).
 */

const bundle = join(WORKSPACE_ROOT, 'dist/apps/sim-cli/main.mjs');
const scenario = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios/checkpoint.console');

function sim(...argv: string[]): { status: number | null; stdout: string[]; stderr: string } {
  const result = spawnSync(process.execPath, [bundle, ...argv], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, INIT_CWD: WORKSPACE_ROOT },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout.split('\n').filter(Boolean), stderr: result.stderr };
}

async function scenarioGame(): Promise<Game> {
  const game = createGame({ world: workshopWorld() });
  const result = await runConsoleScript(game, await readFile(scenario, 'utf8'));
  expect(result).toMatchObject({ ok: true, output: [game.hash()] });
  return game;
}

function savedLog(bytes: Uint8Array): ReplayLog {
  const read = readCtrl(bytes);
  if (!read.ok || read.value.replayLog === null) throw new Error('no replay log');
  return read.value.replayLog;
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sim-cli-checkpoint-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the checkpoint scenario (P3 D19)', () => {
  it('saves a log rebased onto the checkpoint at 20 000: the tail only, numbered on', async () => {
    const game = await scenarioGame();
    expect(game.tick()).toBe(25_000);
    expect(game.replayLog()).toMatchObject({ firstSeq: 0, initialWorld: { tick: 0 } }); // the session's whole log
    const log = savedLog(game.save());
    expect(log.initialWorld.tick).toBe(20_000);
    expect(log.endTick).toBe(25_000);
    expect(log.firstSeq).toBe(12); // the sim.step at 15 000 ran through the checkpoint: before the cut
    expect(log.entries.map((e) => [e.id, e.tick])).toStrictEqual([
      ['entity.place', 22_000],
      ['sim.step', 22_000],
      ['edit.undo', 23_000],
      ['sim.step', 23_000],
    ]);
    expect(log.endTick - log.initialWorld.tick).toBeLessThan(MAX_VERIFY_TICKS.value);
  });

  it('loads continued and runs on exactly like the uninterrupted session', async () => {
    const game = await scenarioGame();
    const loaded = loadGame(game.save());
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
    for (const g of [game, loaded.game]) {
      g.execOrThrow('device.operate', { id: 2, control: 'closed', value: false });
      g.advance(5_500); // across the next checkpoint at 30 000
    }
    expect(loaded.game.snapshotHash()).toBe(game.snapshotHash());
    expect(loaded.game.hash()).toBe(game.hash());
    expect(loaded.game.save()).toStrictEqual(game.save()); // both rebased onto the same checkpoint at 30 000
  });

  it('sim run --save writes it, sim replay reproduces world.json, and sim run --world loads it continued', async () => {
    const game = await scenarioGame();
    const hash = game.hash();
    const save = join(dir, 'checkpoint.ctrl');
    const run = sim('run', scenario, '--world', WORKSHOP_LEVEL, '--save', save);
    expect(run).toMatchObject({ status: 0, stderr: '', stdout: [hash, hash] });
    const bytes = new Uint8Array(await readFile(save));
    expect(savedLog(bytes)).toStrictEqual(savedLog(game.save()));
    expect(sim('replay', save, '--expect', hash)).toMatchObject({ status: 0, stderr: '', stdout: [hash] });
    // Loading warns on stderr whenever the log restarts (too long, mismatch): silence means continued.
    const empty = join(dir, 'empty.console');
    await writeFile(empty, '');
    expect(sim('run', empty, '--world', save)).toMatchObject({ status: 0, stderr: '', stdout: [hash] });
  });

  it('its checked-in save (world v3, this engine and catalogue) is the rebased log and loads continued', async () => {
    // fixtures/v3/ctrl/checkpoint-engine-7-catalog-2.ctrl, written by the `--save` line in the scenario's
    // header (the world v3 PR's checkpointed fixture); frozen like every .ctrl fixture.
    const game = await scenarioGame();
    const bytes = new Uint8Array(await readFile(currentFixture('checkpoint')));
    expect(savedLog(bytes)).toMatchObject({ firstSeq: 12, initialWorld: { tick: 20_000 }, endTick: 25_000 });
    const loaded = loadGame(bytes);
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
    expect(loaded.game.hash()).toBe(game.hash());
  });
});
