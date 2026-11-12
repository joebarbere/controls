import { SIM_ENGINE_VERSION } from '@controls/sim-core';
import { createGame, type Game, loadGame, runConsoleScript } from '@controls/scripting-api';
import { readCtrl } from '@controls/save-format';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from './script-loader';
import {
  CTRL_FIXTURE_DIR,
  ctrlFixtureDir,
  currentFixture,
  currentFixtureName,
  ENGINE_FIXTURE_DIRS,
  ENGINE_FIXTURE_PATTERN,
} from './testing/fixtures';
import { WORKSHOP_LEVEL, workshopWorld } from './testing/workshop';

/*
 * The sources scenario (F2.4): a DIN PSU hiccuping into a short, a bench supply holding its current
 * limit and a battery discharging, for 2345 ticks. Its two hashes are pinned here **and** in
 * `apps/game-e2e/src/sim-engine.spec.ts`, which runs the same console file with the engine in the page
 * (D6: the supplies' mode, the hiccup timing and the battery's coulomb counting, byte for byte in
 * Node's V8 and Chromium's). `fixtures/v3/ctrl/sources-engine-7-catalog-2.ctrl` is its save (world v3,
 * engine 7; the `-engine-6-catalog-2` saves under v2 and v3 are engine 6's, kept as `engine-changed` regression tests;
 * `-engine-4`, `-engine-5` and `-engine-6` are earlier engines' or catalogues', `engine-changed` too), written by
 *
 *   pnpm sim run apps/sim-cli/scenarios/sources.console --world content/levels/workshop.json \
 *     --save libs/domain/save-format/fixtures/v3/ctrl/sources-engine-7-catalog-2.ctrl
 *
 * (a new fixture for a new engine, never a regenerated one). Its bags are the first supply state in
 * any fixture.
 */
export const SOURCES_HASH = '22f018df2fb7e6bbedc44fef3ecf2d03ff88c9b2d2d0e4b8730f13dc4db0a66d';
export const SOURCES_SNAPSHOT_HASH = '0c1f995ef683e9446e52f5fa8398ba54c4ba46cada225485d5bdd50ae32e6e43';

const bundle = join(WORKSPACE_ROOT, 'dist/apps/sim-cli/main.mjs');
const scenario = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios/sources.console');
const ctrlDir = CTRL_FIXTURE_DIR;
const fixture = currentFixture('sources');

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
  it('every *-engine-N[-catalog-C].ctrl fixture of every schemaVersion was written by engine N (and catalogue C)', () => {
    const files = ENGINE_FIXTURE_DIRS.flatMap((dir) =>
      readdirSync(dir)
        .filter((f) => ENGINE_FIXTURE_PATTERN.test(f))
        .map((f) => join(dir, f)),
    );
    expect(files.length).toBeGreaterThan(2);
    for (const file of files) {
      const read = readCtrl(new Uint8Array(readFileSync(file)));
      if (!read.ok) throw new Error(read.error.message);
      const [, engine, catalog] = ENGINE_FIXTURE_PATTERN.exec(file) ?? [];
      expect(file.startsWith(ctrlFixtureDir(read.value.fromVersion)), file).toBe(true);
      expect(read.value.manifest.simEngineVersion, file).toBe(Number(engine));
      // Before catalogue 2 a fixture's name had no catalogue: those are catalogue 1 or earlier (ADR 0015).
      if (catalog === undefined) expect(read.value.manifest.catalogVersion, file).toBeLessThan(2);
      else expect(read.value.manifest.catalogVersion, file).toBe(Number(catalog));
    }
  });

  it("this engine's fixtures rebuild identically from their scenarios (world.json and replay.log)", () => {
    const current = readdirSync(ctrlDir).filter((f) => f.endsWith(currentFixtureName('')));
    expect(current.length).toBeGreaterThan(2);
    const dir = mkdtempSync(join(tmpdir(), 'sim-cli-rebuild-'));
    try {
      for (const file of current) {
        const scenario = join(
          WORKSPACE_ROOT,
          'apps/sim-cli/scenarios',
          file.replace(ENGINE_FIXTURE_PATTERN, '.console'),
        );
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

  it("this engine's and catalogue's sim-step save exists and loads as continued", () => {
    const loaded = loadGame(new Uint8Array(readFileSync(currentFixture('sim-step'))));
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
  });

  it.each(['sim-step', 'sources', 'bench-lamp', 'protection'])(
    "this engine's catalogue-1 %s save (0.3.0's catalogue) loads as engine-changed, never refused (ADR 0016)",
    (scenario) => {
      const loaded = loadGame(new Uint8Array(readFileSync(join(ctrlFixtureDir(2), `${scenario}-engine-6.ctrl`))));
      if (!loaded.ok) throw new Error(loaded.error.message);
      expect(loaded.manifest.catalogVersion).toBe(1);
      expect(loaded.replay).toMatchObject({ status: 'restarted', reason: 'engine-changed' });
    },
  );

  it.each(['sim-step', 'sources', 'bench-lamp', 'protection'])(
    'the world v2 and v3 engine-6 catalogue-2 %s saves migrate to the same document, and load as engine-changed (ADR 0015, ADR 0018 §12)',
    (scenario) => {
      // Engine 6 under catalogue 2 never shipped; its fixtures are kept, never regenerated, as
      // regression tests that a save from the previous engine under the same catalogue loads,
      // re-solves and restarts its log instead of being refused (engine 7, F3.6 part 1).
      const name = `${scenario}-engine-6-catalog-2.ctrl`;
      const [v2, v3] = [ctrlFixtureDir(2), CTRL_FIXTURE_DIR].map((dir) => {
        const read = readCtrl(new Uint8Array(readFileSync(join(dir, name))));
        if (!read.ok) throw new Error(read.error.message);
        return read.value;
      });
      expect(v2.fromVersion).toBe(2);
      expect(v3.fromVersion).toBe(3);
      expect({ world: v2.world, replayLog: v2.replayLog }).toStrictEqual({ world: v3.world, replayLog: v3.replayLog });
      for (const dir of [ctrlFixtureDir(2), CTRL_FIXTURE_DIR]) {
        const loaded = loadGame(new Uint8Array(readFileSync(join(dir, name))));
        if (!loaded.ok) throw new Error(loaded.error.message);
        expect(loaded.manifest.simEngineVersion).toBe(6);
        expect(loaded.replay).toMatchObject({ status: 'restarted', reason: 'engine-changed' });
      }
    },
  );

  it.each(['sim-step', 'sources', 'bench-lamp', 'protection', 'checkpoint'])(
    "this engine's and catalogue's %s save exists under world v3 and loads as continued",
    (scenario) => {
      const loaded = loadGame(new Uint8Array(readFileSync(currentFixture(scenario))));
      if (!loaded.ok) throw new Error(loaded.error.message);
      expect(loaded.manifest.simEngineVersion).toBe(SIM_ENGINE_VERSION);
      expect(loaded.replay).toStrictEqual({ status: 'continued' });
    },
  );

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
