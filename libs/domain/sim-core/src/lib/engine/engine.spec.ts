import type { CommandBus } from '@controls/commands';
import { replayEntries } from '@controls/commands';
import { createWorld, migrateWorld, World } from '@controls/save-format';
import {
  decodeSnapshot,
  ISLAND_FLAG_NON_CONVERGED,
  ISLAND_FLAG_SINGULAR,
  materialiseWorld,
  SIM_PROTOCOL_VERSION,
} from '@controls/sim-protocol';
import {
  checkWorldDevices,
  createWorldBus,
  createWorldRegistry,
  deriveStream,
  entityStreamKey,
} from '@controls/world-model';
import { readFileSync } from 'node:fs';
import { GCProfiler } from 'node:v8';
import { join } from 'node:path';
import { AC_SOURCE, BATTERY, benchLamp, CRATE, end, LAMP, LEAD, origin, SPST } from '../../testing/bench';
import {
  DROOP,
  ENGINE_BENCH,
  ENGINE_TEST_CATALOG,
  engineBus,
  engineTestOptions,
  FLIP,
  I2T_FUSE,
  ORDER_A,
  ORDER_B,
  THERMAL_LOAD,
  THERMAL_PARAMS,
  THERMAL_TOLERANCE,
  TWIN_SUPPLY,
} from '../../testing/engine';
import { ISLAND_FLAG_NON_CONVERGED as SOLVER_NON_CONVERGED, ISLAND_FLAG_SINGULAR as SOLVER_SINGULAR } from '../mna/dc';
import { SOLVE_INTERVAL_TICKS, TICK_S } from './constants';
import { BUILTIN_DEVICE_MODELS } from './device-model';
import { SimDesyncError, SimEngine, type SimEngineOptions, SimProbeError, SimStartError } from './engine';

/** A minimal headless host: a world bus and an engine that follows it (what the scripting API does). */
class Host {
  readonly engine: SimEngine;
  constructor(
    readonly bus: CommandBus<World>,
    readonly options: SimEngineOptions = engineTestOptions(),
  ) {
    this.engine = SimEngine.start(bus.state, options);
  }
  static fresh(options: SimEngineOptions = engineTestOptions(), seed = 11): Host {
    return new Host(engineBus(seed), options);
  }
  exec(id: string, args: object = {}): void {
    const result = this.bus.exec(id, args);
    if (!result.ok) throw new Error(`${id} failed: ${JSON.stringify(result.error)}`);
    if (result.logged) this.engine.applied(result.entry, this.bus.state);
  }
  run(commands: readonly (readonly [string, object])[]): this {
    for (const [id, args] of commands) this.exec(id, args);
    return this;
  }
  advanceTo(tick: number): this {
    this.engine.advanceTo(tick);
    this.bus.advanceTo(tick);
    return this;
  }
  /** The world as a save writes it. */
  materialised(): World {
    return materialiseWorld(this.bus.state, this.engine.exportState());
  }
}

const volts = (host: Host, a: [number, string], b: [number, string]) => {
  const reading = host.engine.probe(end(...a), end(...b));
  if (reading.kind !== 'dc') throw new Error(`expected a reading, got ${reading.kind}`);
  return reading.volts;
};

describe('SimEngine: the clock and the step order (ADR 0011 §2, §4)', () => {
  it('1 tick is 1 ms, and the electrical layer runs every 10 ticks', () => {
    expect(TICK_S.value).toBe(0.001);
    expect(SOLVE_INTERVAL_TICKS.value).toBe(10);
    expect([TICK_S.kind, SOLVE_INTERVAL_TICKS.kind]).toStrictEqual(['numerical', 'numerical']);
  });

  it('solves at every multiple of 10 that nothing has solved at yet, and nowhere else', () => {
    const host = Host.fresh().run(ENGINE_BENCH);
    expect(host.engine.lastSolveTick).toBe(0); // the commands at tick 0 solved
    const { cadenceSolves } = host.engine.stats;
    host.advanceTo(1);
    expect(host.engine.stats.cadenceSolves).toBe(cadenceSolves); // tick 0 was already solved
    host.advanceTo(95);
    expect(host.engine.stats.cadenceSolves - cadenceSolves).toBe(9); // 10, 20, …, 90
    expect(host.engine.lastSolveTick).toBe(90);
    host.advanceTo(100);
    expect(host.engine.lastSolveTick).toBe(90); // the state at 100 is before step 100's solve
    host.advanceTo(101);
    expect(host.engine.lastSolveTick).toBe(100);
  });

  it('a command that changes the netlist solves at its own tick, before that tick steps', () => {
    const host = Host.fresh().run(ENGINE_BENCH.slice(0, -1)); // the switch still open
    host.advanceTo(25);
    expect(host.engine.lastSolveTick).toBe(20);
    expect(volts(host, [3, 'a'], [3, 'b'])).toBe(0);
    const before = host.engine.stats.commandSolves;
    host.exec('device.operate', { id: 2, control: 'closed', value: true });
    expect(host.engine.stats.commandSolves).toBe(before + 1);
    expect(host.engine.lastSolveTick).toBe(25);
    expect(decodeSnapshot(host.engine.snapshot()).lastSolveTick).toBe(25);
    expect(volts(host, [3, 'a'], [3, 'b'])).toBeGreaterThan(5); // the load sees the battery at once
    // A command that changes no netlist value (a move) doesn't solve.
    host.exec('entity.move', { id: 3, positionMm: { x: 1, y: 0, z: 0 } });
    expect(host.engine.stats.commandSolves).toBe(before + 1);
  });

  it('runs discrete, then continuous, then protection, each over every bank, every step', () => {
    const journal: string[] = [];
    const host = Host.fresh(engineTestOptions(journal)).run([
      ['entity.place', { ref: ORDER_B, positionMm: origin }],
      ['entity.place', { ref: ORDER_A, positionMm: origin }],
    ]);
    host.advanceTo(2);
    expect(journal).toStrictEqual(
      [0, 1].flatMap((t) =>
        ['discrete', 'continuous', 'protection'].flatMap((layer) => [
          `test.orderA:${layer}@${t}`,
          `test.orderB:${layer}@${t}`,
        ]),
      ),
    );
    expect(host.materialised().entities.map((e) => e.sim)).toStrictEqual([{ steps: 2 }, { steps: 2 }]);
  });

  it('a trip re-solves within the same step: the state at t+1 holds the post-trip solution', () => {
    const host = Host.fresh().run(ENGINE_BENCH);
    expect(host.engine.takeEvents()).toStrictEqual([]);
    let tick = 0;
    let events: ReturnType<SimEngine['takeEvents']> = [];
    while (events.length === 0 && tick < 5_000) {
      host.advanceTo(++tick);
      events = host.engine.takeEvents();
    }
    expect(events).toStrictEqual([{ tick, kind: 'blown', entity: 4, entities: [], detail: {} }]);
    expect(tick % 10).not.toBe(0); // not a cadence tick, so only the trip can have solved there
    expect(host.engine.lastSolveTick).toBe(tick);
    expect(host.engine.stats.layerSolves).toBe(1);
    // The fuse's link is gone: the loop is open, so no current and no drop across the load.
    expect(volts(host, [3, 'a'], [3, 'b'])).toBe(0);
    expect(host.engine.netlist.branches.some((b) => b.element.kind === 'entity' && b.element.entity === 4)).toBe(false);
    const fuse = host.materialised().entities.find((e) => e.id === 4);
    expect(fuse?.sim['blown']).toBe(true);
    // The melt took about 4 A²s / I² at the bench's ~5 A (the load heats meanwhile, so I falls).
    expect(tick).toBeGreaterThan(100);
    expect(tick).toBeLessThan(300);
  });

  it('refuses an entry at another tick (a desync) and time that runs backwards', () => {
    const host = Host.fresh().run(ENGINE_BENCH);
    host.advanceTo(10);
    expect(() => host.engine.applied({ seq: 9, tick: 9, id: 'view.resetLayout', args: {} }, host.bus.state)).toThrow(
      SimDesyncError,
    );
    expect(() => host.engine.advanceTo(9)).toThrow(RangeError);
    expect(() => host.engine.advanceTo(10.5)).toThrow(RangeError);
    const revision = host.engine.revision;
    host.engine.advanceTo(10);
    expect(host.engine.revision).toBe(revision); // the current tick is a no-op
  });
});

describe('SimEngine: electrical results', () => {
  it('solves the bench: KVL around the loop, and the battery behind its internal resistance', () => {
    const host = Host.fresh().run(ENGINE_BENCH);
    const battery = volts(host, [1, 'pos'], [1, 'neg']);
    const load = volts(host, [3, 'a'], [3, 'b']);
    const fuse = volts(host, [4, 'a'], [4, 'b']);
    const sw = volts(host, [2, 'a'], [2, 'b']);
    expect(sw).toBe(0); // a closed switch is one node
    const loopCurrent = host.engine.exportState().solution?.branches[0] as number; // the battery's cell
    expect(Math.abs(loopCurrent)).toBeGreaterThan(4);
    // Terminal voltage = EMF − I·R (the placeholder EMF until F2.4), within rounding.
    expect(battery).toBeCloseTo(12 - Math.abs(loopCurrent) * 0.023, 9);
    expect(load + fuse).toBeLessThan(battery);
    expect(fuse).toBeCloseTo(Math.abs(loopCurrent) * 0.01, 9);
  });

  it("draws each device's tolerance from deriveStream(seed, entityStreamKey(id))", () => {
    const loads = (seed: number) => {
      const host = Host.fresh(engineTestOptions(), seed).run([
        ['entity.place', { ref: BATTERY, positionMm: origin }],
        ['entity.place', { ref: THERMAL_LOAD, positionMm: origin }],
        ['lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') }],
        ['lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(1, 'neg') }],
      ]);
      const solution = host.engine.exportState().solution;
      const element = host.engine.netlist.branches.find((b) => b.element.kind === 'entity' && b.element.entity === 2);
      const amps = solution?.branches[2 * (element?.index as number)] as number;
      return volts(host, [2, 'a'], [2, 'b']) / amps;
    };
    for (const seed of [11, 12]) {
      const u = deriveStream(seed, entityStreamKey(2)).nextFloat();
      const expected = THERMAL_PARAMS.coldResistanceOhm * (1 + THERMAL_TOLERANCE * (2 * u - 1));
      expect(loads(seed)).toBeCloseTo(expected, 9);
    }
    expect(loads(11)).toBe(loads(11));
    expect(loads(11)).not.toBe(loads(12));
  });

  it('never presents an unmodelled island as a reading: the real lamp has no filament model until F2.5', () => {
    expect(BUILTIN_DEVICE_MODELS).toStrictEqual({});
    const engine = SimEngine.start(benchLamp(true));
    const [island] = engine.islands();
    expect(island).toMatchObject({ kind: 'dc', status: 'unmodelled', iterations: 0, entities: [1, 2, 3] });
    expect(engine.probe(end(1, 'pos'), end(1, 'neg'))).toStrictEqual({
      kind: 'unsolved',
      tick: 0,
      island: 0,
      reason: 'unmodelled',
    });
    const snapshot = decodeSnapshot(engine.snapshot());
    expect(snapshot.islands[0]).toMatchObject({ iterations: 0, unknowns: 0, referenceNode: -1 });
    expect([...snapshot.nodes, ...snapshot.branches].every((v) => Object.is(v, 0))).toBe(true);
    expect(engine.exportState().solution?.islands).toStrictEqual([{ flags: 0, iterations: 0 }]);
  });

  it('leaves AC islands unsolved until F2.2 part 2, never as a reading', () => {
    const host = Host.fresh().run([
      ['entity.place', { ref: AC_SOURCE, positionMm: origin }],
      ['entity.place', { ref: THERMAL_LOAD, positionMm: origin }],
      ['lead.connect', { ref: LEAD, a: end(1, 'l'), b: end(2, 'a') }],
      ['lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(1, 'n') }],
    ]);
    expect(host.engine.islands()).toMatchObject([{ kind: 'ac', status: 'acPending', iterations: 0 }]);
    expect(host.engine.probe(end(1, 'l'), end(1, 'n'))).toMatchObject({ kind: 'unsolved', reason: 'acPending' });
    host.advanceTo(50); // the load's continuous layer sees no current from an unsolved island
    expect(host.materialised().entities[1].sim['tempK']).toBe(THERMAL_PARAMS.ambientK);
  });

  it('surfaces a singular island: one event on the rising edge, and no reading', () => {
    // Two ideal sources at different EMFs between the same two terminals: a loop of zero-ohm sources.
    const host = Host.fresh().run([
      ['entity.place', { ref: TWIN_SUPPLY, positionMm: origin }],
      ['entity.place', { ref: THERMAL_LOAD, positionMm: origin }],
      ['lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') }],
    ]);
    expect(SOLVER_SINGULAR).toBe(ISLAND_FLAG_SINGULAR);
    expect(SOLVER_NON_CONVERGED).toBe(ISLAND_FLAG_NON_CONVERGED);
    expect(host.engine.islands()[0]).toMatchObject({ status: 'singular', entities: [1, 2] });
    expect(host.engine.probe(end(1, 'pos'), end(1, 'neg'))).toStrictEqual({ kind: 'singular', tick: 0, island: 0 });
    // Raised once, when the twin was placed (alone in its island); joining the load to it is no new loop.
    expect(host.engine.takeEvents()).toStrictEqual([
      { tick: 0, kind: 'singular', entity: null, entities: [1], detail: {} },
    ]);
    expect(decodeSnapshot(host.engine.snapshot()).flags & ISLAND_FLAG_SINGULAR).toBe(ISLAND_FLAG_SINGULAR);
    // Still singular at every cadence solve and through a topology change of the same island: no new event.
    host.advanceTo(35);
    host.exec('lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(1, 'neg') });
    host.advanceTo(60);
    expect(host.engine.takeEvents()).toStrictEqual([]);
    // Gone and back (a delete and its undo) is a new rising edge.
    host.exec('entity.delete', { id: 1 });
    host.exec('edit.undo');
    expect(host.engine.takeEvents().map((e) => [e.tick, e.kind, e.entities])).toStrictEqual([[60, 'singular', [1, 2]]]);
    // The singular island's zeros never heat the load.
    expect(host.materialised().entities[1].sim['tempK']).toBe(THERMAL_PARAMS.ambientK);
  });

  it('surfaces a non-converged island: one event on the rising edge, and an unsettled probe', () => {
    const host = Host.fresh().run([
      ['entity.place', { ref: BATTERY, positionMm: origin }],
      ['entity.place', { ref: FLIP, positionMm: origin }],
      ['lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') }],
      ['lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(1, 'neg') }],
    ]);
    expect(host.engine.islands()[0]).toMatchObject({ status: 'nonConverged' });
    expect(host.engine.probe(end(2, 'a'), end(2, 'b'))).toStrictEqual({ kind: 'unsettled', tick: 0, island: 0 });
    const events = host.engine.takeEvents();
    expect(events.map((e) => [e.kind, e.entity, e.entities])).toStrictEqual([['nonConverged', null, [1, 2]]]);
    host.advanceTo(40); // three more cadence solves, still not converged: no new event
    expect(host.engine.takeEvents()).toStrictEqual([]);
    expect(decodeSnapshot(host.engine.snapshot()).flags & ISLAND_FLAG_NON_CONVERGED).toBe(ISLAND_FLAG_NON_CONVERGED);
  });

  it('reports a floating reading across islands, never a difference of two references', () => {
    const host = Host.fresh().run([
      ...ENGINE_BENCH,
      // A second, separate circuit: its nodes are against its own reference.
      ['entity.place', { ref: BATTERY, positionMm: origin }],
      ['entity.place', { ref: THERMAL_LOAD, positionMm: origin }],
      ['lead.connect', { ref: LEAD, a: end(5, 'pos'), b: end(6, 'a') }],
      ['lead.connect', { ref: LEAD, a: end(6, 'b'), b: end(5, 'neg') }],
    ]);
    expect(volts(host, [1, 'pos'], [1, 'neg'])).toBeGreaterThan(11);
    expect(volts(host, [5, 'pos'], [5, 'neg'])).toBeGreaterThan(11);
    expect(host.engine.probe(end(1, 'pos'), end(5, 'neg'))).toStrictEqual({ kind: 'floating', tick: 0 });
    expect(host.engine.probe(end(5, 'pos'), end(1, 'pos'))).toStrictEqual({ kind: 'floating', tick: 0 });
    expect(volts(host, [1, 'pos'], [1, 'pos'])).toBe(0);
    expect(() => host.engine.probe(end(99, 'a'), end(1, 'pos'))).toThrow(SimProbeError);
    expect(() => host.engine.probe(end(1, 'pos'), end(1, 'nope'))).toThrow(/end b/);
  });
});

describe('SimEngine: state, saves and starts (ADR 0011 §9.6, ADR 0013)', () => {
  it('an empty netlist exports sim: null, and a props-only world hashes as before', () => {
    const host = Host.fresh().run([['entity.place', { ref: CRATE, positionMm: origin }]]);
    host.advanceTo(30);
    expect(host.engine.exportState()).toStrictEqual({ tick: 30, entities: [], solution: null });
    expect(host.materialised()).toStrictEqual(host.bus.state);
    expect(decodeSnapshot(host.engine.snapshot())).toMatchObject({ tick: 30, lastSolveTick: 0, islands: [] });
  });

  it('exports every netlisted device with its whole bag, initialising null-initial keys, valid for the catalogue', () => {
    const host = Host.fresh().run([...ENGINE_BENCH, ['entity.place', { ref: LAMP, positionMm: origin }]]);
    host.advanceTo(80); // before the fuse melts
    const world = host.materialised();
    expect(world.entities.map((e) => [e.id, e.sim])).toStrictEqual([
      [1, { stateOfCharge: 1 }], // no engine model for the battery until F2.4: its bag as placed
      [2, {}],
      [3, { tempK: expect.any(Number) }],
      [4, { blown: false, heatA2s: expect.any(Number) }],
      [5, { filamentTempK: null }], // no lamp model until F2.5
    ]);
    expect(world.entities[2].sim['tempK']).toBeGreaterThan(THERMAL_PARAMS.ambientK);
    expect(checkWorldDevices(world, ENGINE_TEST_CATALOG)).toStrictEqual([]);
    expect(World.safeParse(world).success).toBe(true);
    expect(world.sim?.lastSolveTick).toBe(70);
  });

  it('export → JSON → start → export is identical under Object.is, and so is the snapshot', () => {
    const host = Host.fresh().run(ENGINE_BENCH).advanceTo(777);
    const json = JSON.parse(JSON.stringify(host.materialised()));
    const loaded = migrateWorld(json);
    if (!loaded.ok) throw new Error(loaded.error.message);
    const engine = SimEngine.start(loaded.value, engineTestOptions());
    const [a, b] = [host.engine.exportState(), engine.exportState()];
    expect(b).toStrictEqual(a);
    a.solution?.nodes.forEach((v, i) => expect(Object.is(v, b.solution?.nodes[i])).toBe(true));
    expect(engine.snapshot()).toStrictEqual(host.engine.snapshot());
    expect(engine.stats.startSolves).toBe(0); // adopted, not re-solved
  });

  it('refuses a solution record that does not fit the netlist (start-failed), never re-solving silently', () => {
    const fixture = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          '../../../../save-format/fixtures/v2/start-failed/world/solution-length-mismatch.json',
        ),
        'utf8',
      ),
    );
    const loaded = migrateWorld(fixture);
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(() => SimEngine.start(loaded.value)).toThrow(SimStartError);

    const world = Host.fresh().run(ENGINE_BENCH).materialised();
    const sim = world.sim as NonNullable<World['sim']>;
    const start = (w: World) => () => SimEngine.start(w, engineTestOptions());
    expect(start({ ...world, sim: { ...sim, topologyHash: '0'.repeat(64) } })).toThrow(
      expect.objectContaining({ code: 'start-failed', reason: 'topology-mismatch' }),
    );
    expect(start({ ...world, sim: { ...sim, nodes: sim.nodes.slice(2) } })).toThrow(
      expect.objectContaining({ reason: 'length-mismatch' }),
    );
    expect(start({ ...world, sim: { ...sim, islands: [...sim.islands, { flags: 0, iterations: 1 }] } })).toThrow(
      expect.objectContaining({ reason: 'length-mismatch' }),
    );
    expect(start({ ...createWorld({ seed: 1 }), sim })).toThrow(
      expect.objectContaining({ reason: 'solution-on-empty-netlist' }),
    );
  });

  it('undoing a delete restores the device as it was deleted; undoing its place drops its state (ADR 0011 §3)', () => {
    const host = Host.fresh().run(ENGINE_BENCH);
    host.advanceTo(1_000); // the fuse has blown
    const blownHeat = host.materialised().entities[3].sim['heatA2s'];
    host.exec('entity.delete', { id: 4 });
    expect(host.engine.exportState().entities.map((e) => e.id)).toStrictEqual([1, 2, 3]);
    host.advanceTo(1_100);
    host.exec('edit.undo'); // the fuse comes back blown, with its leads
    expect(host.materialised().entities[3].sim).toStrictEqual({ blown: true, heatA2s: blownHeat });
    expect(volts(host, [3, 'a'], [3, 'b'])).toBe(0);

    // A device whose place is undone leaves no state behind: placing again starts fresh.
    host.exec('entity.place', { ref: I2T_FUSE, positionMm: origin }); // entity 5
    host.advanceTo(1_200);
    host.exec('lead.connect', { ref: LEAD, a: end(5, 'a'), b: end(5, 'b') });
    host.exec('edit.undo');
    host.exec('edit.undo'); // un-places 5
    host.exec('entity.place', { ref: I2T_FUSE, positionMm: origin }); // 5 again, fresh
    expect(host.materialised().entities.find((e) => e.id === 5)?.sim).toStrictEqual({ blown: false, heatA2s: 0 });
    // Un-placing must drop the state even when another kind takes the id next (a fuzzed counterexample).
    host.exec('edit.undo'); // un-places the fuse at 5
    host.exec('entity.place', { ref: THERMAL_LOAD, positionMm: origin }); // 5, a thermal load
    expect(host.materialised().entities.find((e) => e.id === 5)?.sim).toStrictEqual({ tempK: THERMAL_PARAMS.ambientK });
  });

  it('a replay with the engine as its time host reaches byte-identical snapshots and the same events', () => {
    const live = Host.fresh().run(ENGINE_BENCH.slice(0, 4));
    const liveEvents = [];
    live.advanceTo(17);
    live.run(ENGINE_BENCH.slice(4));
    live.advanceTo(900);
    live.exec('device.operate', { id: 2, control: 'closed', value: false });
    live.advanceTo(1_250);
    live.exec('device.operate', { id: 2, control: 'closed', value: true });
    live.advanceTo(4_000);
    // A second load in its own loop, a delete and its undo (a tombstone), then on to 10 s.
    live.run([
      ['entity.place', { ref: BATTERY, positionMm: origin }],
      ['entity.place', { ref: DROOP, positionMm: origin }],
      ['lead.connect', { ref: LEAD, a: end(5, 'pos'), b: end(6, 'a') }],
      ['lead.connect', { ref: LEAD, a: end(6, 'b'), b: end(5, 'neg') }],
    ]);
    live.advanceTo(6_333);
    live.exec('entity.delete', { id: 3 });
    live.advanceTo(7_001);
    live.exec('edit.undo');
    live.advanceTo(10_000);
    liveEvents.push(...live.engine.takeEvents());

    const replayed = new Host(engineBus());
    const result = replayEntries(replayed.bus, live.bus.entries, { time: replayed.engine, endTick: 10_000 });
    expect(result).toStrictEqual({ ok: true });
    expect(replayed.engine.tick).toBe(10_000);
    expect(replayed.engine.snapshot()).toStrictEqual(live.engine.snapshot());
    expect(replayed.engine.takeEvents()).toStrictEqual(liveEvents);
    expect(liveEvents.map((e) => e.kind)).toStrictEqual(['blown']);
    expect(replayed.materialised()).toStrictEqual(live.materialised());
  });
});

describe('SimEngine: the snapshot', () => {
  it('holds the solution, the islands and the device records in the ADR 0011 layout', () => {
    const host = Host.fresh().run(ENGINE_BENCH).advanceTo(100); // before the fuse melts
    const snapshot = decodeSnapshot(host.engine.snapshot());
    const exported = host.engine.exportState();
    expect(SIM_PROTOCOL_VERSION).toBe(1);
    expect(snapshot).toMatchObject({
      tick: 100,
      lastSolveTick: 90,
      topologyHash: host.engine.netlist.topologyHash,
      deviceCount: 2,
    });
    expect([...snapshot.nodes]).toStrictEqual(exported.solution?.nodes);
    expect([...snapshot.branches]).toStrictEqual(exported.solution?.branches);
    expect(snapshot.islands).toStrictEqual([
      { kind: 'dc', flags: 0, iterations: 1, referenceNode: 0, unknowns: expect.any(Number), band: 0 },
    ]);
    // Records in entity order: the load (3) then the fuse (4), 16 bytes each.
    const view = new DataView(snapshot.devices.buffer);
    expect(view.getFloat64(8, true)).toBe(host.materialised().entities[2].sim['tempK']);
    expect(view.getFloat64(16, true)).toBeGreaterThan(0); // the fuse's melt fraction
    expect(view.getUint8(24)).toBe(0); // intact
    expect(host.engine.snapshotHash()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the same seed and commands give byte-identical snapshots over 10 s of sim time, in two runs', () => {
    const run = () => {
      const host = Host.fresh().run(ENGINE_BENCH);
      const hashes: string[] = [];
      for (let t = 250; t <= 10_000; t += 250) hashes.push(host.advanceTo(t).engine.snapshotHash());
      return hashes;
    };
    const first = run();
    expect(new Set(first).size).toBe(first.length); // the state really moves
    expect(run()).toStrictEqual(first);
  });

  it('the generation counts topology changes and is never hashed', () => {
    const host = Host.fresh().run(ENGINE_BENCH);
    const generation = host.engine.topologyGeneration;
    const hash = host.engine.snapshotHash();
    host.exec('device.operate', { id: 2, control: 'closed', value: false });
    host.exec('device.operate', { id: 2, control: 'closed', value: true });
    expect(host.engine.topologyGeneration).toBe(generation + 2);
    expect(host.engine.snapshotHash()).toBe(hash);
  });
});

describe('SimEngine: the warm start, readability and revisions', () => {
  const droopLoop: readonly (readonly [string, object])[] = [
    ['entity.place', { ref: BATTERY, positionMm: origin }],
    ['entity.place', { ref: DROOP, positionMm: origin }],
    ['lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') }],
    ['lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(1, 'neg') }],
  ];

  it('a steady re-solve warm-started from the solution record takes 1 iteration, a cold one more', () => {
    const host = Host.fresh().run(droopLoop);
    // The last command changed the topology: solved cold, the outer loop iterating to its tolerance.
    const cold = host.engine.islands()[0].iterations;
    expect(cold).toBeGreaterThan(1);
    expect(host.engine.islands()[0].status).toBe('solved');
    host.advanceTo(11); // the cadence solve at 10, warm from the record: already at the fixed point
    expect(host.engine.lastSolveTick).toBe(10);
    expect(host.engine.islands()[0].iterations).toBe(1);
    // After a load, the record is the warm start too.
    const loaded = SimEngine.start(host.materialised(), engineTestOptions());
    loaded.advanceTo(21);
    expect(loaded.islands()[0].iterations).toBe(1);
  });

  it('a non-converged island is not readable: a load in it never heats', () => {
    const host = Host.fresh().run([
      ['entity.place', { ref: BATTERY, positionMm: origin }],
      ['entity.place', { ref: FLIP, positionMm: origin }],
      ['entity.place', { ref: THERMAL_LOAD, positionMm: origin }],
      ['lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') }],
      ['lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(3, 'a') }],
      ['lead.connect', { ref: LEAD, a: end(3, 'b'), b: end(1, 'neg') }],
    ]);
    expect(host.engine.islands()[0].status).toBe('nonConverged');
    host.advanceTo(50);
    expect(host.materialised().entities[2].sim['tempK']).toBe(THERMAL_PARAMS.ambientK);
  });

  it('advancing bumps the revision (the cache key of hashes and exports)', () => {
    const host = Host.fresh().run(ENGINE_BENCH);
    const revision = host.engine.revision;
    host.engine.advanceTo(1);
    expect(host.engine.revision).toBeGreaterThan(revision);
  });

  it('the per-tick hot path allocates nothing: scavenges do not grow with the number of steps', () => {
    // A thermal load in a battery loop: continuous work every tick, a cadence solve every 10.
    const host = Host.fresh().run([
      ['entity.place', { ref: BATTERY, positionMm: origin }],
      ['entity.place', { ref: THERMAL_LOAD, positionMm: origin }],
      ['lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') }],
      ['lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(1, 'neg') }],
    ]);
    host.engine.advanceTo(50_000); // warm: every buffer grown, the JIT settled
    const scavenges = (steps: number) => {
      const profiler = new GCProfiler();
      profiler.start();
      host.engine.advanceTo(host.engine.tick + steps);
      return (profiler.stop()?.statistics ?? []).filter((s) => s.gcType === 'Scavenge').length;
    };
    // A few scavenges happen whatever the length (the runtime's own, measured 2–4 at 1M and at 3M
    // steps alike), so the gate is growth: 1M steps in all, and three times the steps may add at most
    // one. A per-step allocation of 64 bytes or more adds about two per 500 000 steps.
    const short = scavenges(250_000);
    const long = scavenges(750_000);
    expect(long).toBeLessThanOrEqual(short + 1);
  });
});

describe('SimEngine with the built-in models', () => {
  it('runs a world bus on the built-in catalogue, the battery at its placeholder EMF', () => {
    const bus = createWorldBus(createWorld({ seed: 3 }), createWorldRegistry());
    const host = new Host(bus, {});
    host.run([
      ['entity.place', { ref: BATTERY, positionMm: origin }],
      ['entity.place', { ref: SPST, positionMm: origin }],
      ['lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') }],
      ['lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(1, 'neg') }],
    ]);
    // Open: only gmin's 1e-12 S per node draws current, so the EMF less ~5e-13 V.
    expect(volts(host, [1, 'pos'], [1, 'neg'])).toBeCloseTo(12, 9);
    host.exec('device.operate', { id: 2, control: 'closed', value: true });
    expect(volts(host, [1, 'pos'], [1, 'neg'])).toBeLessThan(12);
  });
});
