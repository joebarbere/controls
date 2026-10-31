import { type CommandBus, replayEntries } from '@controls/commands';
import { type CatalogRef, migrateWorld, type World } from '@controls/save-format';
import { materialiseWorld } from '@controls/sim-protocol';
import { createWorldBus, createWorldRegistry, worldHash } from '@controls/world-model';
import fc from 'fast-check';
import { AC_SOURCE, BATTERY, end, LAMP, LEAD, origin, SPST } from '../../testing/bench';
import { BENCH_SUPPLY, DIN_PSU } from '../../testing/sources';
import {
  AC_TWIN,
  DROOP,
  ENGINE_BENCH,
  ENGINE_TEST_CATALOG,
  engineBus,
  engineTestOptions,
  FLIP,
  I2T_FUSE,
  LEAKY,
  leakyTestOptions,
  ORDER_A,
  ORDER_B,
  REACTOR,
  RESISTOR_2_4,
  RHEOSTAT,
  THERMAL_LOAD,
  TWIN_SUPPLY,
} from '../../testing/engine';
import { BUILTIN_DEVICE_MODELS } from './device-model';
import { SimEngine, type SimEngineOptions } from './engine';

/*
 * Determinism properties of the engine loop (plan F2.3a, ADR 0011 §9.6):
 *
 * - saving at tick T, loading and running on to T2 equals an uninterrupted run (the snapshot bytes,
 *   the materialised world, its hash and the sim events), whatever the session did before T and
 *   does after it;
 * - replaying the session's log, with the engine as the replay's time host, reaches the same bytes
 *   and events.
 *
 * Sessions start from the engine bench (a battery, a switch, a thermal load and an I²t fuse in a
 * loop), then edit it at random while time passes: the load heats, the fuse blows, the battery
 * discharges, devices of **every engine model** are placed and wired across the battery (singular twin
 * sources, a flip load that never settles, a droop load the warm start settles), supplies run loops of
 * their own (CV, CC, a short that hiccups) and are operated, and devices are deleted and restored by
 * undo.
 */

/**
 * A catalogue entry for every engine device model the property covers, by model kind. The guard test
 * fails when a model (a built-in one from F2.4 on, or a test one) has none, so no model escapes the
 * save-and-load property.
 */
const PARITY_REFS: Readonly<Record<string, CatalogRef>> = {
  'test.thermalLoad': THERMAL_LOAD,
  'test.i2tFuse': I2T_FUSE,
  'test.flip': FLIP,
  'test.droop': DROOP,
  'test.twinSupply': TWIN_SUPPLY,
  'test.orderA': ORDER_A,
  'test.orderB': ORDER_B,
  'test.acSource': AC_SOURCE,
  'test.reactor': REACTOR,
  'test.acTwin': AC_TWIN,
  'test.resistor': RESISTOR_2_4,
  'test.rheostat': RHEOSTAT,
  battery: BATTERY,
  'supply.bench': BENCH_SUPPLY,
  'supply.dinPsu': DIN_PSU,
};

type Op =
  | { kind: 'operate'; value: boolean }
  | { kind: 'place'; ref: number }
  | { kind: 'connect'; from: [number, number]; to: [number, number] }
  | { kind: 'disconnect'; pick: number }
  | { kind: 'delete'; pick: number }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'advance'; ticks: number }
  /** Place a device and wire its first two terminals across battery 1 (a powered loop). */
  | { kind: 'wire'; ref: number }
  /** Delete an entity, then undo: the engine restores its tombstone. */
  | { kind: 'deleteUndo'; pick: number }
  /** An AC source in a loop of its own with a load: an AC island, solved by the phasor solver. */
  | { kind: 'acLoop'; ref: number }
  /** A supply in a loop of its own with a load (or a lead alone: a short), a bench supply switched on. */
  | { kind: 'supplyLoop'; din: boolean; load: number; setpoint: number; limit: number }
  /** Operates a control of some entity (a supply's setpoint, limit or output; refused elsewhere). */
  | { kind: 'supplyOperate'; pick: number; control: number; value: number };

const REFS: readonly CatalogRef[] = [...Object.values(PARITY_REFS), BATTERY, SPST, LAMP];
const refArb = fc.nat({ max: REFS.length - 1 });
/** The electrical models, for `wire`: what makes islands singular, unsettled, settled warm or tripped. */
const WIRED: readonly CatalogRef[] = [
  TWIN_SUPPLY,
  FLIP,
  DROOP,
  THERMAL_LOAD,
  I2T_FUSE,
  LAMP,
  AC_TWIN,
  BATTERY,
  RESISTOR_2_4,
  BENCH_SUPPLY,
  DIN_PSU,
];
const wiredArb = fc.nat({ max: WIRED.length - 1 });
/** Loads with an AC value, for `acLoop`. */
const AC_LOADS: readonly CatalogRef[] = [THERMAL_LOAD, I2T_FUSE, REACTOR, AC_TWIN];
/** A supply loop's loads: a resistor, a heating load, a load that never settles, or none (a short). */
const SUPPLY_LOADS: readonly (CatalogRef | null)[] = [RESISTOR_2_4, THERMAL_LOAD, FLIP, null];
/** Bench-supply settings: setpoints (V) and limits (A), a limit of 0 included. */
const SETPOINTS = [0, 5, 12, 30] as const;
const LIMITS = [0, 0.5, 2, 5] as const;
const SUPPLY_CONTROLS = ['setpointV', 'currentLimitA', 'outputOn'] as const;
const pick = fc.nat({ max: 9 });
const terminalPick = fc.tuple(pick, fc.nat({ max: 1 }));
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('operate' as const), value: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('place' as const), ref: refArb }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('wire' as const), ref: wiredArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('connect' as const), from: terminalPick, to: terminalPick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('disconnect' as const), pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('delete' as const), pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('deleteUndo' as const), pick }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('acLoop' as const), ref: fc.nat({ max: AC_LOADS.length - 1 }) }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('supplyLoop' as const),
      din: fc.boolean(),
      load: fc.nat({ max: SUPPLY_LOADS.length - 1 }),
      setpoint: fc.nat({ max: SETPOINTS.length - 1 }),
      limit: fc.nat({ max: LIMITS.length - 1 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('supplyOperate' as const),
      pick,
      control: fc.nat({ max: SUPPLY_CONTROLS.length - 1 }),
      value: fc.nat({ max: 3 }),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'undo' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'redo' as const }) },
  // Often a few ticks (mid-interval), sometimes long enough for the fuse to melt (about 0.15 s).
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('advance' as const),
      ticks: fc.oneof(fc.nat({ max: 23 }), fc.integer({ min: 60, max: 180 })),
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

function exec(host: Host, id: string, args: object = {}): boolean {
  const result = host.bus.exec(id, args);
  if (result.ok && result.logged) host.engine.applied(result.entry, host.bus.state);
  return result.ok;
}

function apply(host: Host, op: Op): void {
  const world = host.bus.state;
  const entityAt = (i: number) => world.entities[i % Math.max(world.entities.length, 1)]?.id ?? 1;
  const terminalOf = ([e, t]: [number, number]) => {
    const id = entityAt(e);
    const entity = world.entities.find((x) => x.id === id);
    const terminals = (entity && ENGINE_TEST_CATALOG.device(entity.ref)?.terminals) || [];
    return end(id, terminals[t % Math.max(terminals.length, 1)]?.id ?? 'a');
  };
  switch (op.kind) {
    case 'advance':
      host.engine.advanceTo(host.engine.tick + op.ticks);
      host.bus.advanceTo(host.engine.tick);
      return;
    case 'operate':
      exec(host, 'device.operate', { id: 2, control: 'closed', value: op.value });
      return;
    case 'place':
      exec(host, 'entity.place', { ref: REFS[op.ref], positionMm: origin });
      return;
    case 'wire': {
      if (!exec(host, 'entity.place', { ref: WIRED[op.ref], positionMm: origin })) return;
      const id = host.bus.state.nextEntityId - 1;
      const terminals = ENGINE_TEST_CATALOG.device(WIRED[op.ref])?.terminals.map((t) => t.id) ?? [];
      exec(host, 'lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(id, terminals[0]) });
      exec(host, 'lead.connect', { ref: LEAD, a: end(id, terminals[1] ?? terminals[0]), b: end(1, 'neg') });
      return;
    }
    case 'connect':
      exec(host, 'lead.connect', { ref: LEAD, a: terminalOf(op.from), b: terminalOf(op.to) });
      return;
    case 'disconnect': {
      const connections = world.connections;
      exec(host, 'lead.disconnect', { id: connections[op.pick % Math.max(connections.length, 1)]?.id ?? 1 });
      return;
    }
    case 'delete':
      exec(host, 'entity.delete', { id: entityAt(op.pick) });
      return;
    case 'acLoop': {
      if (!exec(host, 'entity.place', { ref: AC_SOURCE, positionMm: origin })) return;
      const source = host.bus.state.nextEntityId - 1;
      if (!exec(host, 'entity.place', { ref: AC_LOADS[op.ref], positionMm: origin })) return;
      const load = source + 1;
      exec(host, 'lead.connect', { ref: LEAD, a: end(source, 'l'), b: end(load, 'a') });
      exec(host, 'lead.connect', { ref: LEAD, a: end(load, 'b'), b: end(source, 'n') });
      return;
    }
    case 'supplyLoop': {
      if (!exec(host, 'entity.place', { ref: op.din ? DIN_PSU : BENCH_SUPPLY, positionMm: origin })) return;
      const supply = host.bus.state.nextEntityId - 1;
      const load = SUPPLY_LOADS[op.load];
      if (load === null) {
        exec(host, 'lead.connect', { ref: LEAD, a: end(supply, 'pos'), b: end(supply, 'neg') });
      } else {
        if (!exec(host, 'entity.place', { ref: load, positionMm: origin })) return;
        exec(host, 'lead.connect', { ref: LEAD, a: end(supply, 'pos'), b: end(supply + 1, 'a') });
        exec(host, 'lead.connect', { ref: LEAD, a: end(supply + 1, 'b'), b: end(supply, 'neg') });
      }
      if (op.din) return;
      exec(host, 'device.operate', { id: supply, control: 'setpointV', value: SETPOINTS[op.setpoint] });
      exec(host, 'device.operate', { id: supply, control: 'currentLimitA', value: LIMITS[op.limit] });
      exec(host, 'device.operate', { id: supply, control: 'outputOn', value: true });
      return;
    }
    case 'supplyOperate': {
      const control = SUPPLY_CONTROLS[op.control];
      const value =
        control === 'outputOn' ? op.value % 2 === 1 : control === 'setpointV' ? SETPOINTS[op.value] : LIMITS[op.value];
      exec(host, 'device.operate', { id: entityAt(op.pick), control, value });
      return;
    }
    case 'deleteUndo':
      if (exec(host, 'entity.delete', { id: entityAt(op.pick) })) exec(host, 'edit.undo');
      return;
    case 'undo':
      exec(host, 'edit.undo');
      return;
    case 'redo':
      exec(host, 'edit.redo');
      return;
  }
}

function benchHost(options: SimEngineOptions = engineTestOptions()): Host {
  const bus = engineBus();
  const host = { bus, engine: SimEngine.start(bus.state, options) };
  for (const [id, args] of ENGINE_BENCH) if (!exec(host, id, args)) throw new Error(`${id} failed`);
  return host;
}

/** Save and load: materialise, through JSON and the loader, then a fresh bus (continuing the seqs) and engine. */
function reload(host: Host, options: SimEngineOptions = engineTestOptions()): Host {
  const saved = materialiseWorld(host.bus.state, host.engine.exportState());
  const loaded = migrateWorld(JSON.parse(JSON.stringify(saved)));
  if (!loaded.ok) throw new Error(loaded.error.message);
  const bus = createWorldBus(loaded.value, createWorldRegistry({ catalog: ENGINE_TEST_CATALOG }), {
    firstSeq: host.bus.nextSeq(),
  });
  return { bus, engine: SimEngine.start(loaded.value, options) };
}

const fingerprint = (host: Host) => ({
  tick: host.engine.tick,
  snapshot: host.engine.snapshotHash(),
  world: worldHash(materialiseWorld(host.bus.state, host.engine.exportState())),
});

/**
 * Saving at the cut, loading and running on equals the uninterrupted run: after every op the snapshot
 * hashes and the sim events agree; at the end the world hash too, and again after a second load.
 * Throws (an assertion) when they don't.
 */
function checkParity(before: readonly Op[], after: readonly Op[], options: SimEngineOptions = engineTestOptions()) {
  const straight = benchHost(options);
  before.forEach((op) => apply(straight, op));
  straight.engine.takeEvents(); // what happened before the cut is history on both sides
  let loaded = reload(straight, options);
  // A load clears the undo history (F1.8b), so the straight run does too at the same point.
  straight.bus.clearHistory();
  expect(fingerprint(loaded)).toStrictEqual(fingerprint(straight));
  for (const op of after) {
    apply(straight, op);
    apply(loaded, op);
    expect(loaded.engine.snapshotHash()).toBe(straight.engine.snapshotHash());
    expect(loaded.engine.takeEvents()).toStrictEqual(straight.engine.takeEvents());
  }
  expect(fingerprint(loaded)).toStrictEqual(fingerprint(straight));
  loaded = reload(loaded, options);
  expect(fingerprint(loaded)).toStrictEqual(fingerprint(straight));
}

describe('engine determinism properties', () => {
  it('every engine device model has a parity case (a model without one fails here)', () => {
    const kinds = [...Object.keys(BUILTIN_DEVICE_MODELS), ...Object.keys(engineTestOptions().deviceModels)];
    expect(kinds.length).toBeGreaterThanOrEqual(7);
    for (const kind of kinds) {
      expect(PARITY_REFS[kind], kind).toBeDefined();
      expect(ENGINE_TEST_CATALOG.kindOf(PARITY_REFS[kind])?.kind).toBe(kind);
    }
  });

  it('saving at T, loading and running on to T2 equals the uninterrupted run, step by step, events included', () => {
    fc.assert(
      fc.property(sessionArb, ({ before, after }) => checkParity(before, after)),
      { numRuns: 12 },
    );
  });

  it('fails on a model that keeps state outside its bag (the property bites)', () => {
    const before: Op[] = [{ kind: 'advance', ticks: 13 }];
    expect(WIRED).not.toContain(LEAKY);
    const after: Op[] = [{ kind: 'advance', ticks: 40 }];
    expect(() => checkParity(before, after, leakyTestOptions())).not.toThrow(); // nothing leaky placed yet
    // With the leaky load wired across the battery, a reload forgets its step count.
    const wired = [...before];
    const options = leakyTestOptions();
    const straight = benchHost(options);
    exec(straight, 'entity.place', { ref: LEAKY, positionMm: origin });
    exec(straight, 'lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(5, 'a') });
    exec(straight, 'lead.connect', { ref: LEAD, a: end(5, 'b'), b: end(1, 'neg') });
    wired.forEach((op) => apply(straight, op));
    const loaded = reload(straight, options);
    for (const op of after) {
      apply(straight, op);
      apply(loaded, op);
    }
    expect(loaded.engine.snapshotHash()).not.toBe(straight.engine.snapshotHash());
  });

  it("replaying the session's log with the engine as time host reaches the same snapshot bytes and events", () => {
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
        expect(engine.takeEvents()).toStrictEqual(live.engine.takeEvents());
        expect(fingerprint({ bus, engine })).toStrictEqual(fingerprint(live));
      }),
      { numRuns: 15 },
    );
  });

  it('the sessions cut mid-interval, with heat, a blown fuse, singular and unsettled islands, discharge, current limit, hiccups and restored tombstones (generator health)', () => {
    const samples = fc.sample(sessionArb, { seed: 20261031, numRuns: 60 });
    const counts = {
      midInterval: 0,
      blown: 0,
      heated: 0,
      singular: 0,
      nonConverged: 0,
      topologyAfter: 0,
      eventsAfter: 0,
      tombstones: 0,
      ac: 0,
      acSingular: 0,
      discharged: 0,
      cc: 0,
      hiccupOff: 0,
    };
    for (const { before, after } of samples) {
      const host = benchHost();
      before.forEach((op) => apply(host, op));
      if (host.engine.tick % 10 !== 0) counts.midInterval++;
      const world = materialiseWorld(host.bus.state, host.engine.exportState());
      if (world.entities.some((e) => e.sim['blown'] === true)) counts.blown++;
      if (world.entities.some((e) => typeof e.sim['tempK'] === 'number' && e.sim['tempK'] > 294)) counts.heated++;
      if (world.entities.some((e) => typeof e.sim['stateOfCharge'] === 'number' && e.sim['stateOfCharge'] < 1))
        counts.discharged++;
      if (world.entities.some((e) => e.sim['mode'] === 'cc' || e.sim['mode'] === 'limit')) counts.cc++;
      if (world.entities.some((e) => e.sim['mode'] === 'hiccupOff')) counts.hiccupOff++;
      const statuses = host.engine.islands().map((i) => i.status);
      if (statuses.includes('singular')) counts.singular++;
      if (statuses.includes('nonConverged')) counts.nonConverged++;
      if (host.engine.islands().some((i) => i.kind === 'ac' && i.status === 'solved')) counts.ac++;
      if (host.engine.islands().some((i) => i.kind === 'ac' && i.status === 'singular')) counts.acSingular++;
      host.engine.takeEvents();
      const generation = host.engine.topologyGeneration;
      let restored = false;
      for (const op of after) {
        const devices = host.engine.netlist.devices.length;
        const entries = host.bus.entries.length;
        apply(host, op);
        // A delete and its undo both ran, and the device came back into the netlist.
        if (op.kind === 'deleteUndo' && host.bus.entries.length === entries + 2 && devices > 0) {
          if (host.engine.netlist.devices.length === devices) restored = true;
        }
      }
      if (restored) counts.tombstones++;
      if (host.engine.takeEvents().length > 0) counts.eventsAfter++;
      if (host.engine.topologyGeneration > generation) counts.topologyAfter++;
    }
    // Measured on this seed, of 60 (since F2.4's supply ops): 29 mid-interval, 8 blown, 27 heated, 14
    // singular (10 of them AC), 6 unsettled and 23 solved AC islands, 23 discharged batteries, 21
    // supplies in current limit and 5 DIN PSUs off mid-hiccup at the cut; 56 topology changes, 32 with
    // events and 18 restored tombstones after it.
    expect(counts.midInterval).toBeGreaterThan(22);
    expect(counts.blown).toBeGreaterThan(3);
    expect(counts.heated).toBeGreaterThan(18);
    expect(counts.singular).toBeGreaterThan(8);
    expect(counts.acSingular).toBeGreaterThan(5);
    expect(counts.nonConverged).toBeGreaterThan(2);
    expect(counts.ac).toBeGreaterThan(16);
    expect(counts.discharged).toBeGreaterThan(16);
    expect(counts.cc).toBeGreaterThan(14);
    expect(counts.hiccupOff).toBeGreaterThan(2);
    expect(counts.topologyAfter).toBeGreaterThan(48);
    expect(counts.eventsAfter).toBeGreaterThan(24);
    expect(counts.tombstones).toBeGreaterThan(12);
  });
});
