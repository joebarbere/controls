import { createGame, type Game, loadGame, replayGame, runConsoleScript } from '@controls/scripting-api';
import { SIM_ENGINE_VERSION } from '@controls/sim-core';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import benchLamp from '../scenarios/bench-lamp';
import { WORKSPACE_ROOT } from './script-loader';
import { WORKSHOP_LEVEL, workshopWorld } from './testing/workshop';

/*
 * The bench demo (plan F2.5, the phase acceptance's in-game demo): a battery, an SPST switch and an
 * incandescent lamp on the workshop bench, joined by three test leads. Closing the switch lights the
 * lamp (its light inside the published relation's band), opening it puts the lamp out. The console
 * file (`scenarios/bench-lamp.console`), the TypeScript script (`scenarios/bench-lamp.ts`), a replay
 * and a save all reach the same hashes.
 *
 * **These hashes are the D6 cross-runtime golden from F2.5** (plan F2.3a's note): they are pinned here,
 * in `apps/game-e2e/src/bench-lamp.spec.ts` (the same commands driven in the game with the console and
 * the keyboard, the engine in Chromium's V8) and in the scripting caveats. Change all three together,
 * never one: a difference in the game is float drift between V8 builds, not a golden to re-pin. A
 * numeric change also bumps `SIM_ENGINE_VERSION` (D8).
 */
/** `world.hash` with the lamp lit: 1.5 s after the switch closed. */
export const BENCH_LAMP_LIT_HASH = 'ed42d957348f2c2f79aad6ed892228a20e59bb543ba3e348399595c37d7b3fbc';
export const BENCH_LAMP_LIT_SNAPSHOT_HASH = '52010da7436ce267029b58a73aadc43c6e3ddb4ca0db17f1c3a3bf695b9fd517';
/** `world.hash` at the end: 0.5 s after the switch opened, the lamp out. */
export const BENCH_LAMP_HASH = '0b533c942486866c3d8757b94dfdb6c2d891f66ae0401f97a96aac4d1ea6cb28';
export const BENCH_LAMP_SNAPSHOT_HASH = 'd5bbbaaf731e59d67fd7a1e459504f9198a7d5d563d0ef0f1a52cb7e010ac11f';

const bundle = join(WORKSPACE_ROOT, 'dist/apps/sim-cli/main.mjs');
const scenarios = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios');
const fixture = join(
  WORKSPACE_ROOT,
  `libs/domain/save-format/fixtures/v2/ctrl/bench-lamp-engine-${SIM_ENGINE_VERSION}.ctrl`,
);

function sim(...argv: string[]): { status: number | null; stdout: string[]; stderr: string } {
  const result = spawnSync(process.execPath, [bundle, ...argv], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, INIT_CWD: WORKSPACE_ROOT },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout.split('\n').filter(Boolean), stderr: result.stderr };
}

async function consoleGame(): Promise<Game> {
  const game = createGame({ world: workshopWorld() });
  const result = await runConsoleScript(game, await readFile(join(scenarios, 'bench-lamp.console'), 'utf8'));
  expect(result).toMatchObject({ ok: true, output: [BENCH_LAMP_LIT_HASH, BENCH_LAMP_HASH] });
  return game;
}

const lamp = (game: Game) => game.device(3)?.values ?? {};

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sim-cli-bench-lamp-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the bench-lamp scenario (F2.5)', () => {
  it('the script lights the lamp, puts it out, and reaches the pinned hashes; the console file logs exactly the same', async () => {
    const script = createGame({ world: workshopWorld() });
    benchLamp(script);
    expect(script.hash()).toBe(BENCH_LAMP_HASH);
    expect(script.snapshotHash()).toBe(BENCH_LAMP_SNAPSHOT_HASH);
    const game = await consoleGame();
    expect(game.entries()).toStrictEqual(script.entries());
    expect(game.entries().map((e) => `${e.id}@${e.tick}`)).toStrictEqual([
      'entity.place@0',
      'entity.place@0',
      'entity.place@0',
      'lead.connect@0',
      'lead.connect@0',
      'lead.connect@0',
      'device.operate@0',
      'sim.step@0',
      'device.operate@1500',
      'sim.step@1500',
    ]);
    expect(game.tick()).toBe(2000);
    expect(game.snapshotHash()).toBe(BENCH_LAMP_SNAPSHOT_HASH);
  });

  it('lit, the light is inside the published band for the voltage across the lamp; out, it is under a display step', async () => {
    const game = createGame({ world: workshopWorld() });
    const lines = readFileSync(join(scenarios, 'bench-lamp.console'), 'utf8').split('\n');
    const at = lines.findIndex((line) => line.startsWith('world.hash'));
    expect(await runConsoleScript(game, lines.slice(0, at + 1).join('\n'))).toMatchObject({
      ok: true,
      output: [BENCH_LAMP_LIT_HASH],
    });
    expect(game.snapshotHash()).toBe(BENCH_LAMP_LIT_SNAPSHOT_HASH);
    const lit = lamp(game);
    const across = game.probe('3:a', '3:b');
    if (across.kind !== 'dc') throw new Error(across.kind);
    expect(lit['status']).toBe('solved');
    // L ∝ V^3.4 (Fink and Beaty); the model is within 4 % of it from 75 % to 115 % of rated voltage.
    expect(Math.abs((lit['lightOutputRel'] as number) / Math.pow(across.volts / 12, 3.4) - 1)).toBeLessThan(0.04);
    expect(lit['lightOutputRel']).toBeGreaterThan(1.2); // 12.8 V on a 12 V lamp
    expect(lit['filamentTempK']).toBeGreaterThan(2700);
    await runConsoleScript(game, lines.slice(at + 1).join('\n'));
    const out = lamp(game);
    expect(out).toMatchObject({ status: 'solved', powerW: 0, currentA: 0 });
    expect(out['lightOutputRel']).toBeLessThan(1 / 255);
  });

  it('the current trace shows the cold-filament inrush: a peak 10 to 15 times the settled current, decaying', async () => {
    const game = createGame({ world: workshopWorld() });
    const lines = readFileSync(join(scenarios, 'bench-lamp.console'), 'utf8').split('\n');
    await runConsoleScript(
      game,
      lines
        .slice(
          0,
          lines.findIndex((l) => l.startsWith('device.operate')),
        )
        .join('\n'),
    );
    game.execOrThrow('device.operate', { id: 2, control: 'closed', value: true });
    const trace: number[] = [lamp(game)['currentA'] as number];
    for (let t = 0; t < 1500; t++) {
      game.advance(1);
      trace.push(lamp(game)['currentA'] as number);
    }
    const settled = trace[trace.length - 1];
    expect(Math.max(...trace)).toBe(trace[0]);
    expect(trace[0] / settled).toBeGreaterThan(10);
    expect(trace[0] / settled).toBeLessThan(15);
    // Half way down from the peak within 2 ms, within 5 % of settled by 200 ms.
    expect(trace[2]).toBeLessThan((trace[0] + settled) / 2);
    expect(trace[200] / settled).toBeLessThan(1.05);
  });

  it('sim run prints both hashes for the console file and the final one for the script; replay and a save reach them', () => {
    const save = join(dir, 'bench-lamp.ctrl');
    const run = sim('run', join(scenarios, 'bench-lamp.console'), '--world', WORKSHOP_LEVEL, '--save', save);
    expect(run.stderr).toBe('');
    expect(run.stdout).toEqual([BENCH_LAMP_LIT_HASH, BENCH_LAMP_HASH, BENCH_LAMP_HASH]);
    const script = sim('run', join(scenarios, 'bench-lamp.ts'), '--world', WORKSHOP_LEVEL, '--expect', BENCH_LAMP_HASH);
    expect(script).toMatchObject({ status: 0, stderr: '' });
    expect(sim('replay', save, '--expect', BENCH_LAMP_HASH)).toMatchObject({ status: 0, stderr: '' });
  });

  it('its checked-in save (engine 5) loads as continued, replays to the same hashes, and reloads into the same future', async () => {
    const loaded = loadGame(new Uint8Array(readFileSync(fixture)));
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
    expect(loaded.manifest.simEngineVersion).toBe(SIM_ENGINE_VERSION);
    expect(loaded.game.hash()).toBe(BENCH_LAMP_HASH);
    expect(loaded.game.snapshotHash()).toBe(BENCH_LAMP_SNAPSHOT_HASH);
    expect(sim('replay', fixture)).toMatchObject({ status: 0, stdout: [BENCH_LAMP_HASH] });
    // Close the switch again on both: the warm filament's smaller inrush, and the same bytes.
    const straight = await consoleGame();
    for (const game of [straight, loaded.game]) {
      game.execOrThrow('device.operate', { id: 2, control: 'closed', value: true });
      game.advance(300);
    }
    expect(loaded.game.snapshotHash()).toBe(straight.snapshotHash());
  });

  it('gives byte-identical snapshots over 10 s of sim time, across two runs and a replay', async () => {
    const run = async () => {
      const game = await consoleGame();
      game.execOrThrow('device.operate', { id: 2, control: 'closed', value: true });
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
