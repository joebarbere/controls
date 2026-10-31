import { SIM_ENGINE_VERSION } from '@controls/sim-core';
import { createGame, type Game, loadGame, runConsoleScript } from '@controls/scripting-api';
import { readCtrl } from '@controls/save-format';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from './script-loader';
import { WORKSHOP_LEVEL, workshopWorld } from './testing/workshop';

/*
 * The sources scenario (F2.4): a DIN PSU hiccuping into a short, a bench supply holding its current
 * limit and a battery discharging, for 2345 ticks. Its two hashes are pinned here **and** in
 * `apps/game-e2e/src/sim-engine.spec.ts`, which runs the same console file with the engine in the page
 * (D6: the supplies' mode, the hiccup timing and the battery's coulomb counting, byte for byte in
 * Node's V8 and Chromium's). `fixtures/v2/ctrl/sources-engine-5.ctrl` is its save (`-engine-4` is F2.4's, now `engine-changed`), written by
 *
 *   pnpm sim run apps/sim-cli/scenarios/sources.console --world content/levels/workshop.json \
 *     --save libs/domain/save-format/fixtures/v2/ctrl/sources-engine-5.ctrl
 *
 * (a new fixture for a new engine, never a regenerated one). Its bags are the first supply state in
 * any fixture.
 */
export const SOURCES_HASH = 'df6f7c64ec79a1d3109dcb6e66373db929cae4da711af4810d2e6079261c29b1';
export const SOURCES_SNAPSHOT_HASH = '153b26d1a977fda513661e938672c4d53502ffc583078c4bb28d7f8f856b7a24';

const bundle = join(WORKSPACE_ROOT, 'dist/apps/sim-cli/main.mjs');
const scenario = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios/sources.console');
const ctrlDir = join(WORKSPACE_ROOT, 'libs/domain/save-format/fixtures/v2/ctrl');
const fixture = join(ctrlDir, `sources-engine-${SIM_ENGINE_VERSION}.ctrl`);

function sim(...argv: string[]): { status: number | null; stdout: string[] } {
  const result = spawnSync(process.execPath, [bundle, ...argv], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, INIT_CWD: WORKSPACE_ROOT },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout.split('\n').filter(Boolean) };
}

async function scenarioGame(): Promise<Game> {
  const game = createGame({ world: workshopWorld() });
  const result = await runConsoleScript(game, await readFile(scenario, 'utf8'));
  expect(result).toMatchObject({ ok: true, output: [SOURCES_HASH] });
  return game;
}

/** Each source's sim bag, by entity: the DIN PSU (1), the bench supply (2) and the battery (3). */
const bags = (game: Game) => game.materialisedWorld().entities.map((e) => [e.id, e.sim] as const);

const hiccupTicks = (game: Game, from: number, to: number): [number, unknown][] => {
  const seen: [number, unknown][] = [];
  const stop = game.on('sim', (event) => {
    if (event.kind === 'hiccup') seen.push([event.tick, event.detail['phase']]);
  });
  game.advanceTo(from);
  game.advanceTo(to);
  stop();
  return seen;
};

describe('the sources scenario (F2.4)', () => {
  it('reaches its pinned hashes with the PSU 45 ticks into its third off, the bench supply in CC, the battery drained', async () => {
    const game = await scenarioGame();
    expect(game.tick()).toBe(2345);
    expect(game.hash()).toBe(SOURCES_HASH);
    expect(game.snapshotHash()).toBe(SOURCES_SNAPSHOT_HASH);
    const [din, bench, battery] = bags(game).filter(([id]) => id <= 3);
    expect(din).toStrictEqual([1, { mode: 'hiccupOff', phaseTicks: 45 }]);
    expect(bench).toStrictEqual([2, { mode: 'cc' }]);
    expect(battery[1]['stateOfCharge']).toBeLessThan(1);
    expect(battery[1]['stateOfCharge']).toBeGreaterThan(0.9);
  });

  it('sim run reaches the same hash, and its checked-in save loads as continued and replays to it', () => {
    expect(sim('run', scenario, '--world', WORKSHOP_LEVEL).stdout).toEqual([SOURCES_HASH, SOURCES_HASH]);
    const loaded = loadGame(new Uint8Array(readFileSync(fixture)));
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
    expect(loaded.manifest.simEngineVersion).toBe(SIM_ENGINE_VERSION);
    expect(loaded.game.hash()).toBe(SOURCES_HASH);
    expect(loaded.game.snapshotHash()).toBe(SOURCES_SNAPSHOT_HASH);
    expect(sim('replay', fixture)).toMatchObject({ status: 0, stdout: [SOURCES_HASH] });
  });

  it('after loading the save the PSU retries exactly when the uninterrupted run does (tick 3300)', async () => {
    const straight = await scenarioGame();
    const loaded = loadGame(new Uint8Array(readFileSync(fixture)));
    if (!loaded.ok) throw new Error(loaded.error.message);
    // Off at 2300 (D after the retry at 2200), so the retry is at 3300 and the next off at 3400.
    const expected: [number, unknown][] = [
      [3300, 'retry'],
      [3400, 'off'],
    ];
    expect(hiccupTicks(straight, 2345, 3401)).toStrictEqual(expected);
    expect(hiccupTicks(loaded.game, 2345, 3401)).toStrictEqual(expected);
    expect(loaded.game.snapshotHash()).toBe(straight.snapshotHash());
  });
});

describe('engine-version collision guard (F2.4 save-format review)', () => {
  it('every *-engine-N.ctrl fixture was written by engine N', () => {
    const files = readdirSync(ctrlDir).filter((f) => /-engine-\d+\.ctrl$/.test(f));
    expect(files.length).toBeGreaterThan(2);
    for (const file of files) {
      const read = readCtrl(new Uint8Array(readFileSync(join(ctrlDir, file))));
      if (!read.ok) throw new Error(read.error.message);
      expect(read.value.manifest.simEngineVersion, file).toBe(Number(/-engine-(\d+)\.ctrl$/.exec(file)?.[1]));
    }
  });

  it("this engine's fixtures rebuild identically from their scenarios (world.json and replay.log)", () => {
    const current = readdirSync(ctrlDir).filter((f) => f.endsWith(`-engine-${SIM_ENGINE_VERSION}.ctrl`));
    expect(current.length).toBeGreaterThan(2);
    const dir = mkdtempSync(join(tmpdir(), 'sim-cli-rebuild-'));
    try {
      for (const file of current) {
        const scenario = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios', file.replace(/-engine-\d+\.ctrl$/, '.console'));
        const out = join(dir, file);
        expect(sim('run', scenario, '--world', WORKSHOP_LEVEL, '--save', out).status, file).toBe(0);
        const [saved, rebuilt] = [join(ctrlDir, file), out].map((path) => {
          const read = readCtrl(new Uint8Array(readFileSync(path)));
          if (!read.ok) throw new Error(read.error.message);
          return { world: read.value.world, replayLog: read.value.replayLog };
        });
        expect(rebuilt, file).toStrictEqual(saved);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("this engine's sim-step save exists and loads as continued", () => {
    const loaded = loadGame(new Uint8Array(readFileSync(join(ctrlDir, `sim-step-engine-${SIM_ENGINE_VERSION}.ctrl`))));
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
  });

  it('docs/history.md has exactly one row per engine version up to this one', () => {
    const history = readFileSync(join(WORKSPACE_ROOT, 'docs/history.md'), 'utf8');
    const table = history.slice(history.indexOf('| simEngineVersion |'));
    const lines = table.split('\n').slice(2);
    const versions = lines
      .slice(
        0,
        lines.findIndex((line) => !line.startsWith('|')),
      )
      .map((line) => Number(line.split('|')[1]));
    expect(versions).toStrictEqual(Array.from({ length: SIM_ENGINE_VERSION }, (_, i) => i + 1));
  });
});
