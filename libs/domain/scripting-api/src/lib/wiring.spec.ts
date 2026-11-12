import { createWorld } from '@controls/save-format';
import { createWorldRegistry, routeDefaultLengthMm } from '@controls/world-model';
import {
  BENCH_POINTS,
  CUTTER,
  L1_TO_LINE_ROUTE,
  LABELLER,
  screwTermination,
  STRIPPER,
  TORQUE,
  WIRE,
  WIRING_TEST_CATALOG,
} from '@controls/world-model/testing';
import { type ConsoleTarget, runConsoleScript, toConsoleScript } from './console-script';
import { createGame, type Game } from './game';

/*
 * The world v3 commands from a console file and a TypeScript script (ADR 0015; plan "World v3
 * commands": "a console line and a TS script can add and land a wire"). TEST-ONLY content: no real
 * conductor, tool or enclosure exists before F3.1, F3.4 and F3.5, so this runs over world-model's
 * `WIRING_TEST_CATALOG` without the sim engine (the commanded world only), and there is no `sim-cli`
 * scenario yet; the phase-acceptance scenarios (`lamp-circuit`, `bad-termination`) bring real ones.
 *
 * Both drive the same circuit at Journeyman: the bench (split-phase stand-in, a DIN panel with the
 * 15 A breaker on its rail, a 1-gang box), then a 14 AWG wire from L1 with its b end free, labelled,
 * then landed on the breaker's line screw with a torque driver. They reach the same pinned hash.
 */

const HASH = '56d51acbad09e85806d04aa11696f341990a05954c51d73807a8d14b1cfa853f';

function wiringGame(): Game {
  return createGame({
    world: createWorld({ seed: 7, difficulty: 'journeyman' }),
    registry: createWorldRegistry({ catalog: WIRING_TEST_CATALOG }),
    engine: false,
  });
}

function target(game: Game): ConsoleTarget {
  return {
    registry: game.registry,
    world: () => game.world(),
    catalog: WIRING_TEST_CATALOG,
    exec: (id, args) => game.exec(id, args),
    hash: () => game.hash(),
    netlistDump: () => game.netlistDump(),
    wireInfo: (id: number) => game.wireInfo(id),
  };
}

const ROUTE = JSON.stringify([
  ...L1_TO_LINE_ROUTE,
  { kind: 'free', positionMm: BENCH_POINTS.line, entity: null, fixture: null, tool: null },
]);
const TERMINATION = (torque: number) =>
  [
    '--method screw',
    `--strip.tool.id ${STRIPPER.id} --strip.tool.version 1 --strip.hole h14s --strip.lengthMm 13`,
    '--accessory null',
    `--clamp.tool.id ${TORQUE.id} --clamp.tool.version 1 --clamp.torqueNm ${torque}`,
  ].join(' ');

/** The console file: what `sim run` and the in-game console's `run` accept. */
const CONSOLE_FILE = `# The wiring bench, then a wire from L1, labelled, landed on the breaker's line screw.
entity.place --ref.id utility.larkmoor-split-phase-25kva --ref.version 1 --positionMm.x 0 --positionMm.y 0 --positionMm.z 0
entity.place --ref.id panel.test-din --ref.version 1 --positionMm.x 1000 --positionMm.y 0 --positionMm.z 0
entity.place --ref.id breaker.saltmere-1p-15a --ref.version 1 --positionMm.x 1050 --positionMm.y 300 --positionMm.z 100 --mountedOn.entity 2 --mountedOn.mount rail-1
entity.label 3 --text CB1 --tool.id ${LABELLER.id} --tool.version 1
wire.add --ref.id ${WIRE.id} --ref.version 1 --a.entity 1 --a.terminal l1 ${TERMINATION(4)
  .split(' ')
  .map((w) => (w.startsWith('--') ? `--a.termination.${w.slice(2)}` : w))
  .join(
    ' ',
  )} --b null --route ${ROUTE} --lengthMm auto --colour.base black --colour.stripe null --tool.id ${CUTTER.id} --tool.version 1
wire.label 1 --text L1-CB1 --tool.id ${LABELLER.id} --tool.version 1
wire.land 1 --end b --at.entity 3 --at.terminal line ${TERMINATION(4)
  .split(' ')
  .map((w) => (w.startsWith('--') ? `--at.termination.${w.slice(2)}` : w))
  .join(' ')}
world.hash
`;

/** The same steps as a TypeScript script (`sim run script.ts` exports one like it). */
function script(game: Game): void {
  const ok = (result: ReturnType<Game['exec']>) => {
    if (!result.ok) throw new Error(result.error.message);
  };
  const at = (x: number, y: number, z: number) => ({ x, y, z });
  ok(
    game.exec('entity.place', {
      ref: { id: 'utility.larkmoor-split-phase-25kva', version: 1 },
      positionMm: at(0, 0, 0),
    }),
  );
  ok(game.exec('entity.place', { ref: { id: 'panel.test-din', version: 1 }, positionMm: at(1000, 0, 0) }));
  ok(
    game.exec('entity.place', {
      ref: { id: 'breaker.saltmere-1p-15a', version: 1 },
      positionMm: at(1050, 300, 100),
      mountedOn: { entity: 2, mount: 'rail-1' },
    }),
  );
  ok(game.exec('entity.label', { id: 3, text: 'CB1', tool: LABELLER }));
  const route = [
    ...L1_TO_LINE_ROUTE,
    { kind: 'free', positionMm: BENCH_POINTS.line, entity: null, fixture: null, tool: null },
  ];
  const lengthMm = routeDefaultLengthMm([BENCH_POINTS.l1, ...route.map((w) => w.positionMm)]);
  ok(
    game.exec('wire.add', {
      ref: WIRE,
      a: { entity: 1, terminal: 'l1', termination: screwTermination(4) },
      b: null,
      route,
      lengthMm,
      colour: { base: 'black', stripe: null },
      tool: CUTTER,
    }),
  );
  ok(game.exec('wire.label', { id: 1, text: 'L1-CB1', tool: LABELLER }));
  ok(
    game.exec('wire.land', { id: 1, end: 'b', at: { entity: 3, terminal: 'line', termination: screwTermination(4) } }),
  );
}

describe('adding and landing a wire from a console file and a script (TEST-ONLY catalogue)', () => {
  it('the console file runs, expanding --lengthMm auto on the live world, and logs explicit args', async () => {
    const game = wiringGame();
    const result = await runConsoleScript(target(game), CONSOLE_FILE);
    expect(result).toMatchObject({ ok: true, executed: 7 });
    expect(result.output).toEqual([HASH]);
    const add = game.entries().find((e) => e.id === 'wire.add');
    expect(add?.args['lengthMm']).toBe(1577); // the 1 501 mm floor plus 5 % slack, rounded up
    expect(game.world().connections[0]).toMatchObject({
      label: 'L1-CB1',
      a: { entity: 1, terminal: 'l1', termination: { id: 1, method: 'screw', auto: false } },
      b: { entity: 3, terminal: 'line', termination: { id: 2, method: 'screw', auto: false } },
      route: L1_TO_LINE_ROUTE,
    });
    expect(game.world().entities[2]).toMatchObject({ label: 'CB1', mountedOn: { entity: 2, mount: 'rail-1' } });
  });

  it('the TypeScript script reaches the same hash, and the log replays as console lines', async () => {
    const game = wiringGame();
    script(game);
    expect(game.hash()).toBe(HASH);
    const again = wiringGame();
    expect(await runConsoleScript(target(again), toConsoleScript(game.entries()))).toMatchObject({
      ok: true,
      executed: 7,
    });
    expect(again.hash()).toBe(HASH);
  });

  it('a refused line stops the file with the refusal code', async () => {
    const game = wiringGame();
    const result = await runConsoleScript(
      target(game),
      CONSOLE_FILE.replace('termination.clamp.torqueNm 4', 'termination.clamp.torqueNm 9'),
    );
    expect(result).toMatchObject({ ok: false, executed: 4, error: { kind: 'exec', lineNumber: 6 } });
    expect(JSON.stringify(result)).toContain('beyond-tool-capacity');
  });
});
