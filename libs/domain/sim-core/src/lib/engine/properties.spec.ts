import { type CommandBus, replayEntries } from '@controls/commands';
import { migrateWorld, type World } from '@controls/save-format';
import { materialiseWorld } from '@controls/sim-protocol';
import { createWorldBus, createWorldRegistry, worldHash } from '@controls/world-model';
import fc from 'fast-check';
import { BATTERY, end, LAMP, LEAD, origin, SPST } from '../../testing/bench';
import {
  ENGINE_BENCH,
  ENGINE_TEST_CATALOG,
  engineBus,
  engineTestOptions,
  I2T_FUSE,
  THERMAL_LOAD,
} from '../../testing/engine';
import { SimEngine } from './engine';

/*
 * Determinism properties of the engine loop (plan F2.3a, ADR 0011 §9.6):
 *
 * - saving at tick T, loading and running on to T2 equals an uninterrupted run (the snapshot bytes,
 *   the materialised world and its hash), whatever the session did before T and does after it;
 * - replaying the session's log, with the engine as the replay's time host, reaches the same bytes.
 *
 * Sessions start from the engine bench (a battery, a switch, a thermal load and an I²t fuse in a
 * loop), then edit it at random while time passes: the load heats, the fuse melts and blows, devices
 * are placed, wired, deleted and restored by undo.
 */

type Op =
  | { kind: 'operate'; value: boolean }
  | { kind: 'place'; ref: number }
  | { kind: 'connect'; from: [number, number]; to: [number, number] }
  | { kind: 'disconnect'; pick: number }
  | { kind: 'delete'; pick: number }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'advance'; ticks: number };

const REFS = [THERMAL_LOAD, I2T_FUSE, BATTERY, SPST, LAMP];
const pick = fc.nat({ max: 9 });
const terminalPick = fc.tuple(pick, fc.nat({ max: 1 }));
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('operate' as const), value: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('place' as const), ref: fc.nat({ max: REFS.length - 1 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('connect' as const), from: terminalPick, to: terminalPick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('disconnect' as const), pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('delete' as const), pick }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'undo' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'redo' as const }) },
  // Often a few ticks (mid-interval), sometimes long enough for the fuse to melt (about 0.15 s).
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('advance' as const),
      ticks: fc.oneof(fc.nat({ max: 23 }), fc.integer({ min: 80, max: 250 })),
    }),
  },
);
const sessionArb = fc.record({
  before: fc.array(opArb, { minLength: 1, maxLength: 12 }),
  after: fc.array(opArb, { minLength: 1, maxLength: 12 }),
});

/** A headless host: a world bus and the engine following it. */
interface Host {
  readonly bus: CommandBus<World>;
  readonly engine: SimEngine;
}

function apply(host: Host, op: Op): void {
  const { bus, engine } = host;
  const world = bus.state;
  const entityAt = (i: number) => world.entities[i % Math.max(world.entities.length, 1)]?.id ?? 1;
  const terminalOf = ([e, t]: [number, number]) => {
    const id = entityAt(e);
    const entity = world.entities.find((x) => x.id === id);
    const terminals = (entity && ENGINE_TEST_CATALOG.device(entity.ref)?.terminals) || [];
    return end(id, terminals[t % Math.max(terminals.length, 1)]?.id ?? 'a');
  };
  let result;
  switch (op.kind) {
    case 'advance':
      engine.advanceTo(engine.tick + op.ticks);
      bus.advanceTo(engine.tick);
      return;
    case 'operate':
      result = bus.exec('device.operate', { id: 2, control: 'closed', value: op.value });
      break;
    case 'place':
      result = bus.exec('entity.place', { ref: REFS[op.ref], positionMm: origin });
      break;
    case 'connect':
      result = bus.exec('lead.connect', { ref: LEAD, a: terminalOf(op.from), b: terminalOf(op.to) });
      break;
    case 'disconnect': {
      const connections = world.connections;
      result = bus.exec('lead.disconnect', { id: connections[op.pick % Math.max(connections.length, 1)]?.id ?? 1 });
      break;
    }
    case 'delete':
      result = bus.exec('entity.delete', { id: entityAt(op.pick) });
      break;
    case 'undo':
      result = bus.exec('edit.undo');
      break;
    case 'redo':
      result = bus.exec('edit.redo');
      break;
  }
  if (result.ok && result.logged) engine.applied(result.entry, bus.state);
}

function benchHost(): Host {
  const bus = engineBus();
  const engine = SimEngine.start(bus.state, engineTestOptions());
  const host = { bus, engine };
  for (const [id, args] of ENGINE_BENCH) {
    const result = bus.exec(id, args);
    if (!result.ok || !result.logged) throw new Error(`${id} failed`);
    engine.applied(result.entry, bus.state);
  }
  return host;
}

/** Save and load: materialise, through JSON and the loader, then a fresh bus (continuing the seqs) and engine. */
function reload(host: Host): Host {
  const saved = materialiseWorld(host.bus.state, host.engine.exportState());
  const loaded = migrateWorld(JSON.parse(JSON.stringify(saved)));
  if (!loaded.ok) throw new Error(loaded.error.message);
  const bus = createWorldBus(loaded.value, createWorldRegistry({ catalog: ENGINE_TEST_CATALOG }), {
    firstSeq: host.bus.nextSeq(),
  });
  return { bus, engine: SimEngine.start(loaded.value, engineTestOptions()) };
}

const fingerprint = (host: Host) => ({
  tick: host.engine.tick,
  snapshot: host.engine.snapshotHash(),
  world: worldHash(materialiseWorld(host.bus.state, host.engine.exportState())),
});

describe('engine determinism properties', () => {
  it('saving at T, loading and running on to T2 equals the uninterrupted run, step by step', () => {
    fc.assert(
      fc.property(sessionArb, ({ before, after }) => {
        const straight = benchHost();
        before.forEach((op) => apply(straight, op));
        // A load clears the undo history (F1.8b), so the straight run does too at the same point.
        let loaded = reload(straight);
        straight.bus.clearHistory();
        expect(fingerprint(loaded)).toStrictEqual(fingerprint(straight));
        for (const op of after) {
          apply(straight, op);
          apply(loaded, op);
          expect(loaded.engine.snapshotHash()).toBe(straight.engine.snapshotHash());
        }
        expect(fingerprint(loaded)).toStrictEqual(fingerprint(straight));
        expect(loaded.engine.snapshot()).toStrictEqual(straight.engine.snapshot());
        // And a second load, at the end, still agrees.
        loaded = reload(loaded);
        expect(fingerprint(loaded)).toStrictEqual(fingerprint(straight));
      }),
      { numRuns: 30 },
    );
  });

  it("replaying the session's log with the engine as time host reaches the same snapshot bytes", () => {
    fc.assert(
      fc.property(sessionArb, ({ before, after }) => {
        const live = benchHost();
        [...before, ...after].forEach((op) => apply(live, op));
        const bus = engineBus();
        const engine = SimEngine.start(bus.state, engineTestOptions());
        expect(replayEntries(bus, live.bus.entries, { time: engine, endTick: live.engine.tick })).toStrictEqual({
          ok: true,
        });
        expect(engine.snapshot()).toStrictEqual(live.engine.snapshot());
        expect(fingerprint({ bus, engine })).toStrictEqual(fingerprint(live));
      }),
      { numRuns: 30 },
    );
  });

  it('the sessions cut mid-interval, with heat and a blown fuse, and change the topology after the cut (generator health)', () => {
    const samples = fc.sample(sessionArb, { seed: 20261031, numRuns: 100 });
    let midInterval = 0;
    let blownBeforeCut = 0;
    let heated = 0;
    let topologyAfter = 0;
    for (const { before, after } of samples) {
      const host = benchHost();
      before.forEach((op) => apply(host, op));
      if (host.engine.tick % 10 !== 0) midInterval++;
      const world = materialiseWorld(host.bus.state, host.engine.exportState());
      if (world.entities.some((e) => e.sim['blown'] === true)) blownBeforeCut++;
      if (world.entities.some((e) => typeof e.sim['tempK'] === 'number' && e.sim['tempK'] > 294)) heated++;
      const generation = host.engine.topologyGeneration;
      after.forEach((op) => apply(host, op));
      if (host.engine.topologyGeneration > generation) topologyAfter++;
    }
    // Measured on this seed: 69, 24, 46 and 87 of 100.
    expect(midInterval).toBeGreaterThan(55);
    expect(blownBeforeCut).toBeGreaterThan(15);
    expect(heated).toBeGreaterThan(35);
    expect(topologyAfter).toBeGreaterThan(70);
  });
});
