import type { CommandBus } from '@controls/commands';
import { createWorld, World } from '@controls/save-format';
import fc from 'fast-check';
import {
  at,
  BLOCK,
  CABLE,
  CRIMPER,
  CUTTER,
  FERRULE,
  FISH_TAPE,
  freeAt,
  LABELLER,
  SCREWDRIVER,
  STRANDED,
  STRIPPER,
  TORQUE,
  WIRE,
  WIRING_TEST_CATALOG,
  wiringBench,
} from '../../testing';
import { checkWorldReferences } from '../devices';
import { worldHash } from '../hash';
import { createWorldBus, createWorldRegistry, replayLog, toReplayLog } from '../session';

/*
 * Properties of the world v3 commands (ADR 0015, "Consequences"), over random command sequences on
 * the TEST-ONLY wiring bench at Trainee (`'auto'` and explicit terminations: a torque driver, a plain
 * screwdriver with a hole that nicks, a ferrule; so replay, undo and redo cover drawn outcomes):
 * - every reachable world is a valid document that agrees with the catalogue;
 * - undoing everything restores the initial world, and replay reaches the live hash;
 * - a new id is exactly its counter; no counter goes down except by undo; only undo and redo bring
 *   back an id below its counter (connections, cables, terminations);
 * - land and unland never change a single conductor's waypoint count plus landed ends;
 * - no command reads sim-owned state (the result is the same whatever the bags hold).
 */

const TERMINALS: readonly [number, string][] = [
  [1, 'l1'],
  [1, 'l2'],
  [1, 'n'],
  [3, 'line'],
  [3, 'load'],
  [4, '1'],
  [4, '2'],
  [5, 'ground'],
];

/** How an end is terminated: 'auto', or explicit steps (each draws from its stream when it has a spread). */
const TERMINATIONS = [
  'auto',
  {
    method: 'screw',
    strip: { tool: STRIPPER, hole: 'h14s', lengthMm: 13 },
    accessory: null,
    clamp: { tool: TORQUE, torqueNm: 0.8 },
  },
  {
    method: 'screw',
    strip: { tool: STRIPPER, hole: 'h16st', lengthMm: 12 },
    accessory: null,
    clamp: { tool: SCREWDRIVER, torqueNm: null },
  },
  {
    method: 'screw',
    strip: { tool: STRIPPER, hole: 'h14st', lengthMm: 8 },
    accessory: { ref: FERRULE, tool: CRIMPER, die: 'sq-10' },
    clamp: { tool: TORQUE, torqueNm: 4 },
  },
  {
    method: 'springCage',
    strip: { tool: STRIPPER, hole: 'h14st', lengthMm: 10 },
    accessory: { ref: FERRULE, tool: CRIMPER, die: 'sq-14' },
    clamp: { tool: null, torqueNm: null },
  },
] as const;

type Op =
  | {
      kind: 'add';
      a: number | null;
      b: number | null;
      x: number;
      z: number;
      stranded: boolean;
      slack: number;
      how: number;
    }
  | { kind: 'unland'; pick: number; end: 'a' | 'b' }
  | { kind: 'land'; pick: number; end: 'a' | 'b'; terminal: number; how: number }
  | { kind: 'reroute'; pick: number; y: number }
  | { kind: 'pull'; count: number }
  | { kind: 'cableReroute'; pick: number; y: number }
  | { kind: 'cableLabel'; pick: number }
  | { kind: 'openEntry'; entry: 'top' | 'ko1' }
  | { kind: 'box'; z: number }
  | { kind: 'entityLabel'; pick: number; text: string | null }
  | { kind: 'rotate'; pick: number }
  | { kind: 'deleteWire'; pick: number }
  | { kind: 'label'; pick: number; text: string | null }
  | { kind: 'cable'; slack: number }
  | { kind: 'strip'; pick: number; mm: number }
  | { kind: 'deleteCable'; pick: number }
  | { kind: 'deleteEntity'; pick: number }
  | { kind: 'move'; pick: number; x: number }
  | { kind: 'mount'; x: number }
  | { kind: 'undo' }
  | { kind: 'redo' };

const terminalPick = fc.option(fc.nat({ max: TERMINALS.length - 1 }), { nil: null });
const pick = fc.nat({ max: 6 });
const end = fc.constantFrom('a' as const, 'b' as const);
const how = fc.nat({ max: TERMINATIONS.length - 1 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('add' as const),
      a: terminalPick,
      b: terminalPick,
      x: fc.integer({ min: -500, max: 2000 }),
      z: fc.integer({ min: -500, max: 2500 }),
      stranded: fc.boolean(),
      slack: fc.integer({ min: -50, max: 500 }),
      how,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('reroute' as const), pick, y: fc.integer({ min: 1200, max: 2000 }) }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('pull' as const), count: fc.integer({ min: 1, max: 3 }) }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('cableReroute' as const),
      pick: fc.nat({ max: 2 }),
      y: fc.integer({ min: 400, max: 800 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('cableLabel' as const), pick: fc.nat({ max: 2 }) }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('openEntry' as const),
      entry: fc.constantFrom('top' as const, 'ko1' as const),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('entityLabel' as const),
      pick,
      text: fc.option(fc.constantFrom('CB1', 'TB1'), { nil: null }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('rotate' as const), pick }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('box' as const), z: fc.integer({ min: -3000, max: 3000 }) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('unland' as const), pick, end }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('land' as const),
      pick,
      end,
      terminal: fc.nat({ max: TERMINALS.length - 1 }),
      how,
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('deleteWire' as const), pick }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('label' as const),
      pick,
      text: fc.option(fc.constantFrom('W1', 'L1-CB1'), { nil: null }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('cable' as const), slack: fc.integer({ min: -50, max: 500 }) }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('strip' as const),
      pick: fc.nat({ max: 2 }),
      mm: fc.integer({ min: 0, max: 250 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('deleteCable' as const), pick: fc.nat({ max: 2 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('deleteEntity' as const), pick }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant('move' as const), pick, x: fc.integer({ min: 1000, max: 1600 }) }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('mount' as const), x: fc.integer({ min: 1040, max: 1560 }) }) },
  { weight: 3, arbitrary: fc.constant({ kind: 'undo' as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: 'redo' as const }) },
);
const opsArb = fc.array(opArb, { maxLength: 30 });

const idAt = <T extends { id: number }>(items: readonly T[], index: number, next: number) =>
  index < items.length ? items[index].id : next + index;

/** The exec call an op makes on the current world. */
function call(world: World, op: Op): [string, Record<string, unknown>] | null {
  const terminal = (index: number, how: number) => {
    const [entity, id] = TERMINALS[index];
    return { entity, terminal: id, termination: TERMINATIONS[how] };
  };
  // Mostly a conductor (a missing id past the end), biased to one with a free end for land.
  const wires = world.connections.filter((c) => c.lengthMm !== null);
  const free = wires.filter((c) => c.a === null || c.b === null);
  const single = wires.filter((c) => c.route !== null && !c.route.some((w) => w.kind === 'conduit'));
  const pool =
    op.kind === 'land' && free.length > 0 ? free : op.kind === 'reroute' && single.length > 0 ? single : wires;
  const wireId = (index: number) =>
    index < 6 && pool.length > 0 ? pool[index % pool.length].id : world.nextConnectionId + index;
  const cableId = (index: number) =>
    index < 2 && world.cables.length > 0 ? world.cables[index % world.cables.length].id : world.nextCableId + index;
  switch (op.kind) {
    case 'add': {
      const route = [freeAt(op.x, 1500, op.z), freeAt(op.x + 1, 1600, op.z)];
      return [
        'wire.add',
        {
          ref: op.stranded ? STRANDED : WIRE,
          a: op.a === null ? null : terminal(op.a, op.how),
          b: op.b === null ? null : terminal(op.b, op.how),
          route,
          lengthMm: 6000 + op.slack * 10,
          colour: { base: 'black', stripe: null },
          tool: CUTTER,
        },
      ];
    }
    case 'unland':
      return ['wire.unland', { id: wireId(op.pick), end: op.end }];
    case 'land': {
      const id = wireId(op.pick);
      const wire = world.connections.find((c) => c.id === id);
      const side = wire && wire[op.end] !== null ? (op.end === 'a' ? 'b' : 'a') : op.end;
      return ['wire.land', { id, end: side, at: terminal(op.terminal, op.how) }];
    }
    case 'reroute': {
      const wire = world.connections.find((c) => c.id === wireId(op.pick));
      const route = [freeAt(500, op.y, 500), freeAt(501, op.y + 100, 500)];
      // Keep a rest waypoint at each free end where it lay.
      const first = wire?.a === null && wire.route ? [wire.route[0]] : [];
      const last = wire?.b === null && wire.route ? [wire.route[wire.route.length - 1]] : [];
      return ['wire.reroute', { id: wireId(op.pick), route: [...first, ...route, ...last] }];
    }
    case 'pull': {
      const conduit = (x: number) => ({
        kind: 'conduit',
        positionMm: at(x, 2500, 0),
        entity: 5,
        fixture: null,
        tool: null,
      });
      return [
        'wire.pull',
        {
          route: [freeAt(0, 2500, 0), conduit(500), conduit(1500), freeAt(2000, 2500, 0)],
          lengthMm: 2100,
          conductors: Array.from({ length: op.count }, (_, i) => ({
            ref: WIRE,
            colour: { base: i % 2 ? 'white' : 'black', stripe: null },
          })),
          tool: FISH_TAPE,
        },
      ];
    }
    case 'cableReroute':
      return ['cable.reroute', { id: cableId(op.pick), route: [freeAt(25, op.y, 2030), freeAt(500, op.y, 1000)] }];
    case 'cableLabel':
      return ['cable.label', { id: cableId(op.pick), text: 'K1', tool: LABELLER }];
    case 'openEntry': {
      // The newest box (the bench's, entity 5, has both entries open already).
      const box = [...world.entities].reverse().find((e) => e.ref.id === 'box.test-1gang');
      return ['enclosure.openEntry', { id: box?.id ?? 5, entry: op.entry, tool: TORQUE }];
    }
    case 'box':
      return ['entity.place', { ref: { id: 'box.test-1gang', version: 1 }, positionMm: at(-2000, 0, op.z) }];
    case 'entityLabel':
      return ['entity.label', { id: idAt(world.entities, op.pick, world.nextEntityId), text: op.text, tool: LABELLER }];
    case 'rotate':
      return [
        'entity.rotate',
        { id: idAt(world.entities, op.pick, world.nextEntityId), deltaMdeg: { yaw: 90_000, pitch: 0, roll: 0 } },
      ];
    case 'deleteWire':
      return ['wire.delete', { id: wireId(op.pick) }];
    case 'label':
      return ['wire.label', { id: wireId(op.pick), text: op.text, tool: LABELLER }];
    case 'cable':
      return [
        'cable.add',
        {
          ref: CABLE,
          a: { entity: 5, entry: 'top' },
          b: null,
          route: [freeAt(25, 500, 2030), freeAt(500, 500, 1000)],
          lengthMm: 1760 + op.slack,
          tailsMm: { a: 200, b: 0 },
          tool: CUTTER,
        },
      ];
    case 'strip':
      return ['cable.strip', { id: cableId(op.pick), end: 'a', jacketMm: op.mm, tool: STRIPPER }];
    case 'deleteCable':
      return ['cable.delete', { id: cableId(op.pick) }];
    case 'deleteEntity':
      return ['entity.delete', { id: idAt(world.entities, op.pick, world.nextEntityId) }];
    case 'move':
      return ['entity.move', { id: idAt(world.entities, op.pick, world.nextEntityId), positionMm: at(op.x, 300, 100) }];
    case 'mount':
      return [
        'entity.place',
        { ref: BLOCK, positionMm: at(op.x, 300, 100), mountedOn: { entity: 2, mount: 'rail-1' } },
      ];
    case 'undo':
      return ['edit.undo', {}];
    case 'redo':
      return ['edit.redo', {}];
  }
}

function run(bus: CommandBus<World>, op: Op) {
  const exec = call(bus.state, op);
  return exec ? bus.exec(exec[0], exec[1]) : null;
}

const terminationIds = (world: World): number[] =>
  world.connections
    .flatMap((c) => [c.a?.termination?.id, c.b?.termination?.id])
    .filter((id): id is number => id !== undefined);

/** Waypoints plus landed ends of each single conductor, by id. */
const routeCounts = (world: World) =>
  new Map(
    world.connections
      .filter((c) => c.route !== null && c.lengthMm !== null)
      .map((c) => [c.id, (c.route?.length ?? 0) + (c.a ? 1 : 0) + (c.b ? 1 : 0)]),
  );

describe('world v3 command properties', () => {
  it('every reachable world is valid; undo-all restores it; replay reaches the live hash', () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        const bus = wiringBench();
        const initial = bus.state;
        for (const op of ops) {
          run(bus, op);
          expect(World.safeParse(bus.state).success).toBe(true);
          expect(checkWorldReferences(bus.state, WIRING_TEST_CATALOG)).toStrictEqual([]);
        }
        const log = toReplayLog(createWorld({ seed: 7, difficulty: 'trainee' }), bus);
        const replayed = replayLog(log, createWorldRegistry({ catalog: WIRING_TEST_CATALOG }));
        expect(replayed.ok && replayed.hash).toBe(worldHash(bus.state));
        while (bus.exec('edit.undo').ok);
        // The bench's own setup is history-free, so undo stops exactly at the bench.
        expect(worldHash(bus.state)).toBe(worldHash(initial));
      }),
      { numRuns: 120 },
    );
  });

  it('new ids are exactly their counters; counters never go down except by undo; only undo and redo re-add old ids', () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        const bus = wiringBench();
        for (const op of ops) {
          const before = bus.state;
          const result = run(bus, op);
          const after = bus.state;
          if (!result?.ok) {
            expect(after).toBe(before);
            continue;
          }
          const history = op.kind === 'undo' || op.kind === 'redo';
          const counters = ['nextConnectionId', 'nextCableId', 'nextTerminationId', 'nextEntityId'] as const;
          if (!history) for (const key of counters) expect(after[key]).toBeGreaterThanOrEqual(before[key]);
          const added = <T>(xs: readonly T[], ys: readonly T[]) => ys.filter((y) => !xs.includes(y));
          const newConnections = added(
            before.connections.map((c) => c.id),
            after.connections.map((c) => c.id),
          );
          const newCables = added(
            before.cables.map((c) => c.id),
            after.cables.map((c) => c.id),
          );
          const newTerminations = added(terminationIds(before), terminationIds(after));
          if (!history) {
            for (const id of newConnections) expect(id).toBeGreaterThanOrEqual(before.nextConnectionId);
            for (const id of newCables) expect(id).toBeGreaterThanOrEqual(before.nextCableId);
            for (const id of newTerminations) expect(id).toBeGreaterThanOrEqual(before.nextTerminationId);
            for (const id of newConnections) expect(id).toBeLessThan(after.nextConnectionId);
            for (const id of newTerminations) expect(id).toBeLessThan(after.nextTerminationId);
          }
          // Termination ids are unique in the world.
          const ids = terminationIds(after);
          expect(new Set(ids).size).toBe(ids.length);
        }
      }),
      { numRuns: 120 },
    );
  });

  it('land and unland never change a route’s waypoints plus landed ends', () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        const bus = wiringBench();
        for (const op of ops) {
          const before = routeCounts(bus.state);
          const result = run(bus, op);
          if (!result?.ok || (op.kind !== 'land' && op.kind !== 'unland')) continue;
          const after = routeCounts(bus.state);
          for (const [id, count] of after) expect([id, count]).toStrictEqual([id, before.get(id)]);
        }
      }),
      { numRuns: 120 },
    );
  });

  it('no command reads sim-owned state', () => {
    const scramble = (world: World, n: number): World =>
      World.parse({
        ...world,
        entities: world.entities.map((e) => ({ ...e, sim: Object.fromEntries(Object.keys(e.sim).map((k) => [k, n])) })),
        connections: world.connections.map((c) => ({
          ...c,
          // All ten connection sim keys, an open intermittent end and stale termination ids included.
          sim: {
            ...c.sim,
            conductorTempK: 300 + n,
            endATempK: 400 + n,
            endBTempK: 500 + n,
            endADegradation: 1 + n,
            endBDegradation: 2 + n,
            endATerminationId: 1000 + n,
            endBTerminationId: 2000 + n,
            endAState: 'intermittentOpen',
            endBState: n % 2 ? 'arcing' : 'intermittentClosed',
            insulationDamaged: true,
          },
        })),
      });
    const stripSim = (world: World) => ({
      ...world,
      entities: world.entities.map((e) => ({ ...e, sim: {} })),
      connections: world.connections.map((c) => ({ ...c, sim: {} })),
    });
    fc.assert(
      fc.property(opsArb, opArb, fc.integer({ min: 1, max: 9 }), (prefix, op, n) => {
        const setup = wiringBench();
        prefix.forEach((p) => run(setup, p));
        const plain = createWorldBus(setup.state, createWorldRegistry({ catalog: WIRING_TEST_CATALOG }));
        const scrambled = createWorldBus(
          scramble(setup.state, n),
          createWorldRegistry({ catalog: WIRING_TEST_CATALOG }),
        );
        if (op.kind === 'undo' || op.kind === 'redo') return;
        const a = run(plain, op);
        const b = run(scrambled, op);
        expect(b?.ok).toBe(a?.ok);
        expect(stripSim(scrambled.state)).toStrictEqual(stripSim(plain.state));
      }),
      { numRuns: 150 },
    );
  });

  it('the generator reaches every command (generator health)', () => {
    const succeeded = new Map<string, number>();
    for (const ops of fc.sample(opsArb, { seed: 20261112, numRuns: 500 })) {
      const bus = wiringBench();
      for (const op of ops) {
        const exec = call(bus.state, op);
        if (exec && bus.exec(exec[0], exec[1]).ok) succeeded.set(exec[0], (succeeded.get(exec[0]) ?? 0) + 1);
        const drawn = bus.state.connections.some((c) =>
          [c.a, c.b].some(
            (e) =>
              e?.termination && !e.termination.auto && e.termination.torqueNm !== 4 && e.termination.torqueNm !== null,
          ),
        );
        if (drawn) succeeded.set('drawn outcome', (succeeded.get('drawn outcome') ?? 0) + 1);
      }
    }
    for (const id of [
      'drawn outcome', // a landed explicit termination whose torque was drawn
      'wire.reroute',
      'wire.pull',
      'cable.reroute',
      'cable.label',
      'enclosure.openEntry',
      'entity.label',
      'entity.rotate',
      'wire.add',
      'wire.land',
      'wire.unland',
      'wire.delete',
      'wire.label',
      'cable.add',
      'cable.strip',
      'cable.delete',
      'entity.delete',
      'entity.move',
      'entity.place',
      'edit.undo',
      'edit.redo',
    ]) {
      expect([id, (succeeded.get(id) ?? 0) >= 1]).toStrictEqual([id, true]);
    }
  });
});
