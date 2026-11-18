import type { CommandBus } from '@controls/commands';
import { World } from '@controls/save-format';
import fc from 'fast-check';
import { at, RESIDENTIAL, RESIDENTIAL_TEST_CATALOG, residentialBench } from '../testing';
import { checkWorldReferences } from './devices';
import { worldHash } from './hash';
import { createWorldBus, createWorldRegistry, replayLog, toReplayLog } from './session';

/*
 * Properties of the world v4 commands (ADR 0019 "Commands"; plan "World v4 commands"), over random
 * sequences on the TEST-ONLY residential bench: plugs in and out, deletes (a receptacle unplugs what it
 * holds, an appliance takes its plug), tape, directory lines, button presses, places, moves, undo, redo.
 * - every reachable world is a valid document that agrees with the catalogue (no dangling plug);
 * - undoing everything restores the initial world (relations and counters), and replay reaches the
 *   live hash;
 * - no counter goes down except by undo;
 * - no command reads sim-owned state (the result is the same whatever the `sim` bags hold).
 */

type Op =
  | { kind: 'insert'; appliance: number; receptacle: number; outlet: string }
  | { kind: 'remove'; appliance: number }
  | { kind: 'delete'; id: number }
  | { kind: 'mark'; id: number; end: 'a' | 'b'; colour: string | null }
  | { kind: 'directory'; space: number; text: string | null }
  | { kind: 'press'; id: number; control: string }
  | { kind: 'place'; x: number; ref: 'kettle' | 'strip' | 'duplex' }
  | { kind: 'move'; id: number; x: number }
  | { kind: 'undo' }
  | { kind: 'redo' };

const ids = fc.integer({ min: 1, max: 12 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('insert' as const),
      appliance: fc.oneof(fc.constantFrom(2, 3), ids),
      receptacle: fc.oneof(fc.constant(1), ids),
      outlet: fc.constantFrom('top', 'bottom', 'socket-1'),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('remove' as const), appliance: fc.oneof(fc.constantFrom(2, 3), ids) }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('delete' as const), id: ids }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('mark' as const),
      id: fc.integer({ min: 1, max: 2 }),
      end: fc.constantFrom('a' as const, 'b' as const),
      colour: fc.constantFrom(null, 'black', 'red', 'bare', 'mauve'),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('directory' as const),
      space: fc.integer({ min: 1, max: 5 }),
      text: fc.constantFrom(null, 'KITCHEN', 'BATH GFCI', 'null'),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('press' as const),
      id: fc.constantFrom(6, 7, 4),
      control: fc.constantFrom('test', 'reset', 'position'),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('place' as const),
      x: fc.integer({ min: -1500, max: 1500 }),
      ref: fc.constantFrom('kettle' as const, 'strip' as const, 'duplex' as const),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant('move' as const), id: ids, x: fc.integer({ min: -900, max: 900 }) }),
  },
  { weight: 2, arbitrary: fc.constant({ kind: 'undo' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'redo' as const }) },
);
const opsArb = fc.array(opArb, { maxLength: 24 });

function call(op: Op): [string, Record<string, unknown>] {
  switch (op.kind) {
    case 'insert':
      return ['plug.insert', { appliance: op.appliance, receptacle: op.receptacle, outlet: op.outlet }];
    case 'remove':
      return ['plug.remove', { appliance: op.appliance }];
    case 'delete':
      return ['entity.delete', { id: op.id }];
    case 'mark':
      return ['wire.mark', { id: op.id, end: op.end, colour: op.colour }];
    case 'directory':
      return ['panel.directory', { id: 4, space: op.space, text: op.text }];
    case 'press':
      return ['device.press', { id: op.id, control: op.control }];
    case 'place':
      return ['entity.place', { ref: RESIDENTIAL[op.ref], positionMm: at(op.x, -2000, 0) }];
    case 'move':
      return ['entity.move', { id: op.id, positionMm: at(op.x, -3000, 0) }];
    case 'undo':
      return ['edit.undo', {}];
    case 'redo':
      return ['edit.redo', {}];
  }
}

const run = (bus: CommandBus<World>, op: Op) => {
  const [id, args] = call(op);
  return bus.exec(id, args);
};

const COUNTERS = ['nextEntityId', 'nextConnectionId', 'nextCableId', 'nextTerminationId'] as const;

describe('world v4 command properties', () => {
  it('every reachable world is valid and agrees with the catalogue; undo all restores it; replay reaches it', () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        const registry = createWorldRegistry({ catalog: RESIDENTIAL_TEST_CATALOG });
        const initial = residentialBench().state;
        const bus = createWorldBus(initial, registry);
        for (const op of ops) {
          const before = bus.state;
          const result = run(bus, op);
          const after = bus.state;
          if (!result.ok) {
            expect(after).toBe(before);
            continue;
          }
          expect(World.safeParse(after).success).toBe(true);
          expect(checkWorldReferences(after, RESIDENTIAL_TEST_CATALOG)).toStrictEqual([]);
          if (op.kind !== 'undo' && op.kind !== 'redo') {
            for (const key of COUNTERS) expect(after[key]).toBeGreaterThanOrEqual(before[key]);
          }
        }
        const live = worldHash(bus.state);
        const replayed = replayLog(toReplayLog(initial, bus), registry);
        expect(replayed.ok && replayed.hash).toBe(live);
        while (bus.canUndo) expect(bus.exec('edit.undo', {}).ok).toBe(true);
        expect(bus.state).toStrictEqual(initial);
      }),
      { numRuns: 150 },
    );
  });

  it('no command reads sim-owned state', () => {
    const scramble = (world: World, n: number): World =>
      World.parse({
        ...world,
        entities: world.entities.map((e) => ({ ...e, sim: Object.fromEntries(Object.keys(e.sim).map((k) => [k, n])) })),
      });
    const stripSim = (world: World) => ({ ...world, entities: world.entities.map((e) => ({ ...e, sim: {} })) });
    fc.assert(
      fc.property(opsArb, opArb, fc.integer({ min: 1, max: 9 }), (prefix, op, n) => {
        if (op.kind === 'undo' || op.kind === 'redo') return;
        const setup = residentialBench();
        prefix.forEach((p) => run(setup, p));
        const registry = createWorldRegistry({ catalog: RESIDENTIAL_TEST_CATALOG });
        const plain = createWorldBus(setup.state, registry);
        const scrambled = createWorldBus(scramble(setup.state, n), registry);
        expect(run(scrambled, op).ok).toBe(run(plain, op).ok);
        expect(stripSim(scrambled.state)).toStrictEqual(stripSim(plain.state));
      }),
      { numRuns: 150 },
    );
  });

  it('the generator reaches every world v4 command (generator health)', () => {
    const succeeded = new Map<string, number>();
    for (const ops of fc.sample(opsArb, { seed: 20261118, numRuns: 400 })) {
      const bus = residentialBench();
      for (const op of ops) {
        const [id, args] = call(op);
        const deleting =
          id === 'entity.delete' &&
          bus.state.entities.some((e) => op.kind === 'delete' && e.pluggedInto?.entity === op.id);
        if (bus.exec(id, args).ok) {
          succeeded.set(id, (succeeded.get(id) ?? 0) + 1);
          if (deleting) succeeded.set('unplugging delete', (succeeded.get('unplugging delete') ?? 0) + 1);
        }
      }
    }
    for (const id of [
      'plug.insert',
      'plug.remove',
      'wire.mark',
      'panel.directory',
      'device.press',
      'entity.delete',
      'unplugging delete',
      'edit.undo',
      'edit.redo',
    ]) {
      expect([id, (succeeded.get(id) ?? 0) >= 1]).toStrictEqual([id, true]);
    }
  });
});
