import { createGame, type Game, loadGame, replayGame, runConsoleScript } from '@controls/scripting-api';
import { SIM_ENGINE_VERSION } from '@controls/sim-core';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from './script-loader';
import { WORKSHOP_LEVEL, workshopWorld } from './testing/workshop';

/*
 * The sim-step scenario (F2.3a): a console file that steps sim time (`sim.step`), headless. A battery
 * with a switch across it through two test leads (a short once closed), an unwired lamp, then 1.234 s.
 *
 * Its two hashes are pinned here **and** in `apps/game-e2e/src/sim-engine.spec.ts`, which runs the
 * same commands with the engine in the page (Chromium's V8): the D6 Node-vs-Chromium golden (plan
 * F2.3a). Change them together, with the scripting caveats; a numeric change also bumps
 * `SIM_ENGINE_VERSION` (D8). F2.4 re-pinned both (engine 4: the battery's EMF follows its state of
 * charge, 12.9 V full, and it discharges into the short; its record is in the snapshot), and F2.5
 * again (engine 5: the unwired lamp has a filament model, so its island is solved, and its record is
 * in the snapshot). The D6 golden with a lamp lit is the bench-lamp scenario's (`bench-lamp.spec.ts`).
 */

/** What engine 3 (F2.3a, the battery at its nominal-EMF placeholder) wrote for the same session. */
const ENGINE_3_HASH = '5ecdc7c40f39240e7dbc4e34103f47c37ab8427faa5f95aa5413da08f036cdf8';
/** What engine 4 (F2.4, the lamp unmodelled) wrote for the same session. */
const ENGINE_4_HASH = 'df471c07cfccd0ab4807ceca52700d4176a4953a8b4d84b049a71d952157b48a';
export const SIM_STEP_HASH = 'e065dd0a3e81636b487a7c49514f4276a7ae70fe146cdf33d1f5cdecb0c74648';
export const SIM_STEP_SNAPSHOT_HASH = 'eddf0d39a957c7c0f11d95a7f061a26640d747df153c065c8ac33ba0b7c966c7';

const bundle = join(WORKSPACE_ROOT, 'dist/apps/sim-cli/main.mjs');
const scenario = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios/sim-step.console');

function sim(...argv: string[]): { status: number | null; stdout: string[]; stderr: string } {
  const result = spawnSync(process.execPath, [bundle, ...argv], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, INIT_CWD: WORKSPACE_ROOT },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout.split('\n').filter(Boolean), stderr: result.stderr };
}

async function scenarioGame(): Promise<Game> {
  const game = createGame({ world: workshopWorld() });
  const result = await runConsoleScript(game, await readFile(scenario, 'utf8'));
  expect(result).toMatchObject({ ok: true, output: [SIM_STEP_HASH] });
  return game;
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sim-cli-sim-step-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the sim-step scenario', () => {
  it('steps time from a console file: sim.step is logged at its tick, and the hashes cover the solve after it', async () => {
    const game = await scenarioGame();
    expect(game.tick()).toBe(1234);
    expect(game.entries().map((e) => [e.id, e.tick])).toStrictEqual([
      ['entity.place', 0],
      ['entity.place', 0],
      ['entity.place', 0],
      ['lead.connect', 0],
      ['lead.connect', 0],
      ['device.operate', 0],
      ['sim.step', 0],
    ]);
    expect(game.replayLog().endTick).toBe(1234);
    expect(game.hash()).toBe(SIM_STEP_HASH);
    expect(game.snapshotHash()).toBe(SIM_STEP_SNAPSHOT_HASH);
    expect(game.materialisedWorld().sim?.lastSolveTick).toBe(1230);
  });

  it('reads the short honestly: the battery behind its internal resistance, the unwired lamp solved and cold', async () => {
    const game = await scenarioGame();
    const battery = game.probe('1:pos', '1:neg');
    const leads = game.probe('2:a', '1:pos');
    if (battery.kind !== 'dc' || leads.kind !== 'dc') throw new Error('expected readings');
    // Two 1 m leads (about 41 mΩ each) and 23 mΩ inside: the terminal voltage is the leads' share of the
    // EMF (12.9 V full, a little less after 1.234 s at about 123 A).
    expect(battery.volts).toBeGreaterThan(9);
    expect(battery.volts).toBeLessThan(11);
    // Engine 5 (F2.5): the lamp has a filament model, so its island (no source) is solved at 0 V.
    expect(game.probe('3:a', '3:b')).toMatchObject({ kind: 'dc', volts: 0 });
    expect(game.device(3)?.values).toMatchObject({ status: 'solved', powerW: 0, filamentTempK: 293.15 });
    expect(game.probe('1:pos', '3:a')).toMatchObject({ kind: 'floating' });
  });

  it('a replay of its log, and sim run, reach the same hashes; so does a save, replayed', async () => {
    const game = await scenarioGame();
    const replayed = replayGame(JSON.parse(JSON.stringify(game.replayLog())));
    expect(replayed.ok && [replayed.game.hash(), replayed.game.snapshotHash()]).toStrictEqual([
      SIM_STEP_HASH,
      SIM_STEP_SNAPSHOT_HASH,
    ]);
    const run = sim('run', scenario, '--world', WORKSHOP_LEVEL, '--save', join(dir, 'sim-step.ctrl'));
    expect(run.stderr).toBe('');
    expect(run.stdout).toEqual([SIM_STEP_HASH, SIM_STEP_HASH]);
    expect(sim('replay', join(dir, 'sim-step.ctrl'), '--expect', SIM_STEP_HASH)).toMatchObject({
      status: 0,
      stderr: '',
    });
  });

  it('its checked-in save (engine 5, tick 1234, a solved short) loads as continued and replays to the same hash', () => {
    const fixture = join(
      WORKSPACE_ROOT,
      `libs/domain/save-format/fixtures/v2/ctrl/sim-step-engine-${SIM_ENGINE_VERSION}.ctrl`,
    );
    const loaded = loadGame(new Uint8Array(readFileSync(fixture)));
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
    expect(loaded.manifest.simEngineVersion).toBe(SIM_ENGINE_VERSION);
    expect(loaded.game.tick()).toBe(1234);
    expect(loaded.game.hash()).toBe(SIM_STEP_HASH);
    const record = loaded.game.materialisedWorld().sim;
    expect(record?.lastSolveTick).toBe(1230);
    // Both islands are solved: the short, and since engine 5 the unwired lamp's.
    expect(record?.islands.map((i) => i.iterations > 0)).toStrictEqual([true, true]);
    expect(sim('replay', fixture)).toMatchObject({ status: 0, stdout: [SIM_STEP_HASH] });
  });

  it("engine 4's save of the same session loads as engine-changed: the lamp's island solved again (F2.5)", () => {
    const fixture = join(WORKSPACE_ROOT, 'libs/domain/save-format/fixtures/v2/ctrl/sim-step-engine-4.ctrl');
    const loaded = loadGame(new Uint8Array(readFileSync(fixture)));
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.manifest.simEngineVersion).toBe(4);
    expect(loaded.replay).toMatchObject({ status: 'restarted', reason: 'engine-changed' });
    expect(loaded.game.hash()).not.toBe(ENGINE_4_HASH);
    expect(loaded.game.materialisedWorld().sim?.islands.map((i) => i.iterations > 0)).toStrictEqual([true, true]);
    expect(sim('replay', fixture)).toMatchObject({ status: 1 });
  });

  it("engine 3's save of the same session loads as engine-changed (D8): its devices as saved, solved again, never refused", () => {
    const fixture = join(WORKSPACE_ROOT, 'libs/domain/save-format/fixtures/v2/ctrl/sim-step-engine-3.ctrl');
    const loaded = loadGame(new Uint8Array(readFileSync(fixture)));
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.manifest.simEngineVersion).toBe(3);
    expect(loaded.replay).toMatchObject({ status: 'restarted', reason: 'engine-changed' });
    // Its devices' state loads as saved, but never engine 3's solution record (12 V placeholder EMF):
    // this engine solves again at the save's tick (F2.4 save-format review), so the hash moves.
    expect(loaded.game.hash()).not.toBe(ENGINE_3_HASH);
    expect(loaded.game.materialisedWorld().sim?.lastSolveTick).toBe(1234);
    expect(sim('replay', fixture)).toMatchObject({ status: 1 });
  });

  it('gives byte-identical snapshots over 10 s of sim time, across two runs and a replay', async () => {
    const run = async () => {
      const game = await scenarioGame();
      const snapshots: Uint8Array[] = [];
      for (let t = 2_000; t <= 10_000; t += 1_000) {
        game.advanceTo(t);
        snapshots.push(game.snapshot());
      }
      return { game, snapshots };
    };
    const first = await run();
    const second = await run();
    expect(second.snapshots).toStrictEqual(first.snapshots);
    const replayed = replayGame(JSON.parse(JSON.stringify(first.game.replayLog())));
    if (!replayed.ok) throw new Error(replayed.error.message);
    expect(replayed.game.tick()).toBe(10_000);
    expect(replayed.game.snapshot()).toStrictEqual(first.snapshots.at(-1));
    expect(replayed.game.hash()).toBe(first.game.hash());
  });
});
