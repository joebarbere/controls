import { BUILTIN_CATALOG } from '@controls/catalog';
import { createGame } from '@controls/scripting-api';
import { bakeCableEnds, cableJacketEnd, supportGap, type World } from '@controls/world-model';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import nmCableRun from '../scenarios/nm-cable-run';
import { WORKSPACE_ROOT } from './script-loader';
import { WORKSHOP_LEVEL, workshopWorld } from './testing/workshop';

/*
 * F3.2 part 4, headless: a box-to-box NM-B run on the workshop stud wall, stapled within the NM support
 * spacing, its jacket stripped at both ends and its conductors landed individually on DIN terminal
 * blocks in the panel (`scenarios/nm-cable-run.ts`). The player-facing e2e comes with the UI half.
 */

/** world.hash after `nm-cable-run.ts`. */
export const NM_CABLE_RUN_HASH = '1ac88020c8d4184be79f59800bf00762e1e0837eeae591db8c45d6784e76d1ef';

const bundle = join(WORKSPACE_ROOT, 'dist/apps/sim-cli/main.mjs');
const script = join(WORKSPACE_ROOT, 'apps/sim-cli/scenarios/nm-cable-run.ts');

function sim(...argv: string[]): { status: number | null; stdout: string[]; stderr: string } {
  const result = spawnSync(process.execPath, [bundle, ...argv], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, INIT_CWD: WORKSPACE_ROOT },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout.split('\n').filter(Boolean), stderr: result.stderr };
}

describe('the NM-B cable run scenario (F3.2 part 4)', () => {
  it('sim run <script.ts> reaches the golden hash', () => {
    const run = sim('run', script, '--world', WORKSHOP_LEVEL, '--expect', NM_CABLE_RUN_HASH);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('runs box to panel, stapled, stripped at both ends, with each conductor landed on its block', () => {
    const game = createGame({ world: workshopWorld() });
    nmCableRun(game);
    expect(game.hash()).toBe(NM_CABLE_RUN_HASH);
    const world = game.world() as World;
    const [cable] = world.cables;
    expect(cable).toMatchObject({
      a: { entity: 1, entry: 'clamp-top-1' },
      b: { entity: 2, entry: 'ko-bottom-2' },
      tailsMm: { a: 200, b: 400 },
      jacketStripMm: { a: 150, b: 300 },
      lengthMm: 2303,
    });
    expect(cable.route.map((w) => [w.kind, w.fixture, w.positionMm])).toEqual([
      ['staple', 'stud-wall', { x: -835, y: -500, z: -65 }],
      ['staple', 'stud-wall', { x: -835, y: 600, z: -65 }],
    ]);
    // The support gaps: 273 mm from the box, 1100 mm between staples, 248 mm to the panel.
    expect(supportGap({ x: -807, y: -758, z: 19 }, cable.route, { x: -810, y: 800, z: 79 })).toBeNull();
    // Black, white and the bare EGC, each landed by itself at the panel end; none at the box.
    expect(world.connections.map((c) => [c.id, c.colour?.base, c.a, c.b?.entity, c.b?.terminal])).toEqual([
      [1, 'black', null, 3, 'b'],
      [2, 'white', null, 4, 'b'],
      [3, 'bare', null, 5, 'b'],
    ]);
    // The jacket ends 100 mm inside the panel; the tails are drawn from there.
    expect(cableJacketEnd(world, BUILTIN_CATALOG, world.cables[0], 'b')).toEqual({ x: -810, y: 900, z: 79 });
    const ends = bakeCableEnds(world, BUILTIN_CATALOG);
    expect(ends.map((e) => [e.end, e.tails.map((t) => [t.connection, t.landed])])).toEqual([
      [
        'a',
        [
          [1, false],
          [2, false],
          [3, false],
        ],
      ],
      [
        'b',
        [
          [1, true],
          [2, true],
          [3, true],
        ],
      ],
    ]);
  });

  it('refuses a staple too far from the box, a landing before the strip and one beyond the stripped reach', () => {
    const game = createGame({ world: workshopWorld() });
    nmCableRun(game);
    const entries = game.entries();
    const add = entries.find((e) => e.id === 'cable.add');
    if (!add) throw new Error('no cable.add');
    const fresh = createGame({ world: workshopWorld() });
    for (const e of entries.slice(0, entries.indexOf(add))) fresh.execOrThrow(e.id, e.args);
    const args = add.args as { route: { positionMm: { y: number } }[] };
    // The first staple 100 mm higher: 368 mm from the box's clamp.
    const high = {
      ...args,
      route: [{ ...args.route[0], positionMm: { ...args.route[0].positionMm, y: -400 } }, args.route[1]],
    };
    expect(fresh.exec('cable.add', high)).toMatchObject({ ok: false, error: { code: 'staple-spacing' } });
    expect(fresh.exec('cable.add', args).ok).toBe(true);
    const termination = {
      method: 'screw',
      strip: { tool: { id: 'tool.veltmark-ws-nm12', version: 1 }, hole: 'sol14', lengthMm: 9 },
      accessory: null,
      clamp: { tool: { id: 'tool.calderyn-ts-03', version: 1 }, torqueNm: 0.6 },
    };
    const land = () => fresh.exec('wire.land', { id: 1, end: 'b', at: { entity: 3, terminal: 'b', termination } });
    expect(land()).toMatchObject({ ok: false, error: { code: 'tail-too-short' } }); // the jacket is on
    // 20 mm stripped: the jacket ends 380 mm in, above the block's bottom clamp, out of 20 mm reach.
    const strip = { id: 1, end: 'b', jacketMm: 20, tool: { id: 'tool.veltmark-ws-nm12', version: 1 } };
    expect(fresh.exec('cable.strip', strip).ok).toBe(true);
    expect(land()).toMatchObject({ ok: false, error: { code: 'tail-too-short' } });
    expect(fresh.exec('cable.strip', { ...strip, jacketMm: 300 }).ok).toBe(true);
    expect(land().ok).toBe(true);
  });
});
