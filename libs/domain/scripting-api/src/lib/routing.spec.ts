import { BUILTIN_CATALOG } from '@controls/catalog';
import { createWorld } from '@controls/save-format';
import { autoRoute, routeDefaultLengthMm } from '@controls/world-model';
import { type ConsoleTarget, runConsoleScript } from './console-script';
import { createGame, type Game } from './game';

/*
 * F3.2 part 1 (ADR 0017): `--route auto` and `game.autoRoute` are one function. The same panel (two
 * horizontal 40 × 60 ducts joined by a riser, three screw blocks under each) is wired from a console
 * file with `--route auto --lengthMm auto` and from a TypeScript script with `game.autoRoute`; both log
 * explicit waypoints and reach the same pinned hash. A log never holds `auto`.
 */

const HASH = '16da996f4a2858bdbc819e61ed9bcf5121d11c757a04a5a3bef0558ec1cc2620';

const DUCT = '--ref.id duct.lattisby-40x60 --ref.version 1';
const BLOCK = '--ref.id tb.quennick-st4 --ref.version 1';
const WIRE = '--ref.id conductor.tallowmere-thhn-14-solid --ref.version 1';
const TAIL = '--colour.base black --colour.stripe null --tool.id tool.veltmark-dc-8 --tool.version 1';
const xyz = (x: number, y: number, z: number) => `--positionMm.x ${x} --positionMm.y ${y} --positionMm.z ${z}`;
const end = (side: 'a' | 'b', entity: number, terminal: string) =>
  `--${side}.entity ${entity} --${side}.terminal ${terminal} --${side}.termination auto`;

/** Entities: D1 (1), D2 (2), the riser (3), row A blocks 4–6 at y = 60, row B blocks 7–9 at y = 200. */
const CONSOLE_FILE = [
  `entity.place ${DUCT} ${xyz(0, 0, 0)}`,
  `entity.place ${DUCT} ${xyz(0, 300, 0)}`,
  `entity.place ${DUCT} ${xyz(640, 0, 0)} --orientationMdeg.yaw 0 --orientationMdeg.pitch 0 --orientationMdeg.roll 90000`,
  'raceway.cut 1 --lengthMm 600',
  'raceway.cut 2 --lengthMm 600',
  'raceway.cut 3 --lengthMm 340',
  ...[0, 1, 2].map((k) => `entity.place ${BLOCK} ${xyz(20 + 6 * k, 60, 0)}`),
  ...[0, 1, 2].map((k) => `entity.place ${BLOCK} ${xyz(320 + 6 * k, 200, 0)}`),
  `wire.add ${WIRE} ${end('a', 4, 'b')} ${end('b', 7, 'b')} --route auto --lengthMm auto ${TAIL}`,
  `wire.add ${WIRE} ${end('a', 5, 'a')} ${end('b', 8, 'a')} --route auto --lengthMm auto ${TAIL}`,
  `wire.add ${WIRE} ${end('a', 6, 'a')} ${end('b', 9, 'b')} --route auto --lengthMm auto ${TAIL}`,
  'wire.reroute 1 --route auto',
  'world.hash',
].join('\n');

function game(): Game {
  return createGame({ world: createWorld({ seed: 0, difficulty: 'trainee' }), engine: false });
}

function target(g: Game): ConsoleTarget {
  return {
    registry: g.registry,
    world: () => g.world(),
    exec: (id, args) => g.exec(id, args),
    hash: () => g.hash(),
    netlistDump: () => g.netlistDump(),
    wireInfo: (id) => g.wireInfo(id),
  };
}

/** The same panel and wires from a TypeScript script, through `game.autoRoute`. */
function script(g: Game): void {
  const ok = (result: ReturnType<Game['exec']>) => {
    if (!result.ok) throw new Error(result.error.message);
  };
  const at = (x: number, y: number, z: number) => ({ x, y, z });
  const duct = { id: 'duct.lattisby-40x60', version: 1 };
  const block = { id: 'tb.quennick-st4', version: 1 };
  const z = { yaw: 0, pitch: 0, roll: 0 };
  ok(g.exec('entity.place', { ref: duct, positionMm: at(0, 0, 0), orientationMdeg: z }));
  ok(g.exec('entity.place', { ref: duct, positionMm: at(0, 300, 0), orientationMdeg: z }));
  ok(g.exec('entity.place', { ref: duct, positionMm: at(640, 0, 0), orientationMdeg: { ...z, roll: 90_000 } }));
  ok(g.exec('raceway.cut', { id: 1, lengthMm: 600 }));
  ok(g.exec('raceway.cut', { id: 2, lengthMm: 600 }));
  ok(g.exec('raceway.cut', { id: 3, lengthMm: 340 }));
  for (const k of [0, 1, 2])
    ok(g.exec('entity.place', { ref: block, positionMm: at(20 + 6 * k, 60, 0), orientationMdeg: z }));
  for (const k of [0, 1, 2])
    ok(g.exec('entity.place', { ref: block, positionMm: at(320 + 6 * k, 200, 0), orientationMdeg: z }));
  for (const [a, b] of [
    ['4:b', '7:b'],
    ['5:a', '8:a'],
    ['6:a', '9:b'],
  ]) {
    const routed = g.autoRoute(a, b);
    if (!routed.ok) throw new Error(routed.message);
    const [ea, ta] = a.split(':');
    const [eb, tb] = b.split(':');
    ok(
      g.exec('wire.add', {
        ref: { id: 'conductor.tallowmere-thhn-14-solid', version: 1 },
        a: { entity: Number(ea), terminal: ta, termination: 'auto' },
        b: { entity: Number(eb), terminal: tb, termination: 'auto' },
        route: routed.route,
        lengthMm: routed.lengthMm,
        colour: { base: 'black', stripe: null },
        tool: { id: 'tool.veltmark-dc-8', version: 1 },
      }),
    );
  }
  const again = g.autoRoute({ entity: 4, terminal: 'b' }, { entity: 7, terminal: 'b' });
  if (!again.ok) throw new Error(again.message);
  ok(g.exec('wire.reroute', { id: 1, route: again.route }));
}

describe('--route auto and game.autoRoute (F3.2 part 1, ADR 0017)', () => {
  it('a console file routes through the ducts and the riser, logging explicit waypoints', async () => {
    const g = game();
    const result = await runConsoleScript(target(g), CONSOLE_FILE);
    expect(result).toMatchObject({ ok: true, executed: 16 });
    expect(result.output).toEqual([HASH]);
    // No shorthand reaches the log: every logged route is explicit waypoints, every length a number.
    for (const e of g.entries().filter((e) => 'route' in e.args)) {
      expect(Array.isArray(e.args['route'])).toBe(true);
      if ('lengthMm' in e.args) expect(typeof e.args['lengthMm']).toBe('number');
    }
    const third = g.entries().filter((e) => e.id === 'wire.add')[2];
    const route = third?.args['route'] as { kind: string; entity: number }[];
    expect(route.map((w) => `${w.kind}:${w.entity}`)).toEqual([
      'duct:2',
      'duct:2',
      'duct:3',
      'duct:3',
      'duct:1',
      'duct:1',
    ]);
    // Its length is the routed points' default length: the floor plus 5 %.
    const points = g.world().connections[2];
    expect(third?.args['lengthMm']).toBe(points?.lengthMm);
  });

  it('a TypeScript script with game.autoRoute reaches the same hash and the same log', async () => {
    const fromConsole = game();
    await runConsoleScript(target(fromConsole), CONSOLE_FILE);
    const fromScript = game();
    script(fromScript);
    expect(fromScript.hash()).toBe(HASH);
    expect(fromScript.entries().map((e) => [e.id, e.args])).toStrictEqual(
      fromConsole.entries().map((e) => [e.id, e.args]),
    );
  });

  it('game.autoRoute is the domain router (the same result), and takes "<entity>:<terminal>"', () => {
    const g = game();
    script(g);
    const direct = autoRoute(
      g.world() as Parameters<typeof autoRoute>[0],
      BUILTIN_CATALOG,
      { entity: 5, terminal: 'a' },
      { entity: 8, terminal: 'a' },
    );
    expect(g.autoRoute('5:a', '8:a')).toStrictEqual(direct);
    expect(direct.ok && direct.lengthMm).toBe(direct.ok && routeDefaultLengthMm(direct.points));
    expect(() => g.autoRoute('5', '8:a')).toThrow(/entityId/);
    expect(g.autoRoute('5:a', '99:a')).toMatchObject({ ok: false, code: 'not-found' });
  });

  it('--route auto explains what it needs', async () => {
    const g = game();
    const lines = CONSOLE_FILE.split('\n').slice(0, 12);
    const bad = `wire.add ${WIRE} ${end('a', 4, 'b')} --b null --route auto --lengthMm 900 ${TAIL}`;
    const result = await runConsoleScript(target(g), [...lines, bad].join('\n'));
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'expand', message: '--route auto routes between two landed ends' },
    });
    const reroute = await runConsoleScript(target(g), 'wire.reroute 9 --route auto');
    expect(reroute).toMatchObject({ ok: false, error: { kind: 'expand' } });
  });
});
