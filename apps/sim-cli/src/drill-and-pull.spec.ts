import { BUILTIN_CATALOG } from '@controls/catalog';
import { createGame, loadGame, runConsoleScript } from '@controls/scripting-api';
import { SIM_ENGINE_VERSION } from '@controls/sim-core';
import { boreNeedsNailPlate, pullRun, type World } from '@controls/world-model';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import drillAndPull from '../scenarios/drill-and-pull';
import { WORKSPACE_ROOT } from './script-loader';
import { currentFixture } from './testing/fixtures';
import { WORKSHOP_LEVEL, workshopWorld } from './testing/workshop';

/*
 * F3.4 part 2, headless: a custom enclosure entry cut with the hole saw, conductors pulled through EMT
 * with the fish tape (what the minigame logs on success, D10), and an NM-B run bored through a stud with
 * a sub-24.5 mm bit (`scenarios/drill-and-pull.ts`, spelled out in `drill-and-pull.console`). The
 * player-facing minigame and its e2e are the UI half. Its save is a frozen fixture (save-format review),
 * written by
 *
 *   pnpm sim run apps/sim-cli/scenarios/drill-and-pull.console --world content/levels/workshop.json \
 *     --save libs/domain/save-format/fixtures/v4/ctrl/drill-and-pull-engine-8-catalog-3.ctrl
 *
 * and rebuilt from the console file by `sources.spec.ts`'s fixture-rebuild check, so the cut drill site,
 * `wire.pull` and a cable with a bore replay are pinned.
 */

/** world.hash after `drill-and-pull.ts`. */
export const DRILL_AND_PULL_HASH = '68341a598e8a23291e0428ec1099f2702b4c86b39e6a11e3910100edc91bce37';

const bundle = join(WORKSPACE_ROOT, 'dist/apps/sim-cli/main.mjs');
const script = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios/drill-and-pull.ts');
const consoleFile = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios/drill-and-pull.console');
const ref = (id: string) => ({ id, version: 1 });

function sim(...argv: string[]): { status: number | null; stdout: string[]; stderr: string } {
  const result = spawnSync(process.execPath, [bundle, ...argv], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, INIT_CWD: WORKSPACE_ROOT },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout.split('\n').filter(Boolean), stderr: result.stderr };
}

/** A game with the scenario's entries before the first entry with command `id` replayed, and that entry's args. */
function before(id: string) {
  const full = createGame({ world: workshopWorld() });
  drillAndPull(full);
  const entries = full.entries();
  const at = entries.findIndex((e) => e.id === id);
  const game = createGame({ world: workshopWorld() });
  for (const e of entries.slice(0, at)) game.execOrThrow(e.id, e.args);
  return { game, args: entries[at].args as Record<string, unknown> };
}

describe('the drill-and-pull scenario (F3.4 part 2)', () => {
  it('sim run <script.ts> reaches the golden hash', () => {
    const run = sim('run', script, '--world', WORKSHOP_LEVEL, '--expect', DRILL_AND_PULL_HASH);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('sim run <file.console> reaches it too, and logs exactly the script entries', async () => {
    const run = sim('run', consoleFile, '--world', WORKSHOP_LEVEL, '--expect', DRILL_AND_PULL_HASH);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toEqual([DRILL_AND_PULL_HASH, DRILL_AND_PULL_HASH]);
    const fromConsole = createGame({ world: workshopWorld() });
    expect((await runConsoleScript(fromConsole, await readFile(consoleFile, 'utf8'))).ok).toBe(true);
    const fromScript = createGame({ world: workshopWorld() });
    drillAndPull(fromScript);
    expect(fromConsole.entries()).toEqual(fromScript.entries());
  });

  it('its checked-in save loads continued, replaying the cut, the pull and the bored run', () => {
    const loaded = loadGame(new Uint8Array(readFileSync(currentFixture('drill-and-pull'))));
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.replay).toStrictEqual({ status: 'continued' });
    expect(loaded.manifest.simEngineVersion).toBe(SIM_ENGINE_VERSION);
    expect(loaded.game.hash()).toBe(DRILL_AND_PULL_HASH);
    expect(loaded.game.entries().map((e) => e.id)).toEqual(expect.arrayContaining(['wire.pull', 'cable.add']));
  });

  it('cuts the drill site, pulls two conductors through the conduit, and bores stud 5 without a nail plate', () => {
    const game = createGame({ world: workshopWorld() });
    drillAndPull(game);
    expect(game.hash()).toBe(DRILL_AND_PULL_HASH);
    const world = game.world() as World;
    // drill-top-1 is the panel's entries[3]: bit 3.
    expect(world.entities[0]).toMatchObject({ ref: ref('panel.pellmoor-din-400x500'), state: { openEntries: 8 } });
    // Two pulled conductors, both ends free, through the connector (2) and the stick (3).
    const pulled = world.connections.filter((c) => c.route?.some((w) => w.kind === 'conduit'));
    expect(pulled.map((c) => [c.id, c.colour?.base, c.a, c.b, c.cable])).toEqual([
      [1, 'black', null, null, null],
      [2, 'white', null, null, null],
    ]);
    const run = pullRun(world, BUILTIN_CATALOG, pulled[0].route ?? []);
    expect(run).toStrictEqual({ lengthMm: 1224, bendDeg: 0, elbows: [] }); // y 1300 → 2524
    // The cable's bore, with the 3/4 in auger: 19.05 mm leaves 44.45 − 9.525 = 34.925 mm, no nail plate.
    const bore = world.cables[0].route.find((w) => w.kind === 'bore');
    expect(bore).toMatchObject({ fixture: 'stud-wall', tool: ref('tool.corriden-sa-12') });
    const bit = BUILTIN_CATALOG.tool(ref('tool.corriden-sa-12'));
    expect(bit?.boreDiameterMm).toBe(19.05);
    expect(boreNeedsNailPlate(bit?.boreDiameterMm ?? NaN)).toBe(false);
  });

  it('refuses the drill site with the wrong hole saw and a wood bit; the punch set opens it', () => {
    const { game, args } = before('enclosure.openEntry');
    const open = (tool: string) => game.exec('enclosure.openEntry', { ...args, tool: ref(tool) });
    expect(open('tool.corriden-hs-14')).toMatchObject({ ok: false, error: { code: 'wrong-size' } }); // 7/8 in
    expect(open('tool.corriden-hs-22')).toMatchObject({ ok: false, error: { code: 'wrong-size' } }); // 1-3/8 in
    expect(open('tool.corriden-sa-18')).toMatchObject({ ok: false, error: { code: 'wrong-tool' } }); // a wood bit
    expect(open('tool.veltmark-kp-3').ok).toBe(true); // the punch set's 3/4 in punch
  });

  it('refuses the bore with the 1-3/4 in hole saw (over the 35.56 mm bored-hole limit)', () => {
    const { game, args } = before('cable.add');
    const route = (args['route'] as Record<string, unknown>[]).map((w) =>
      w['kind'] === 'bore' ? { ...w, tool: ref('tool.corriden-hs-28') } : w,
    );
    expect(game.exec('cable.add', { ...args, route })).toMatchObject({
      ok: false,
      error: { code: 'beyond-tool-capacity' },
    });
    expect(game.exec('cable.add', args).ok).toBe(true);
  });

  it('refuses the pull with a tool that cannot pull', () => {
    const { game, args } = before('wire.pull');
    expect(game.exec('wire.pull', { ...args, tool: ref('tool.veltmark-dc-8') })).toMatchObject({
      ok: false,
      error: { code: 'wrong-tool' },
    });
    expect(game.exec('wire.pull', args).ok).toBe(true);
  });
});
