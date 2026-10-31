import { replayEntries } from '@controls/commands';
import type { CatalogRef } from '@controls/save-format';
import { compareSimEvents } from '@controls/sim-protocol';
import { worldHash } from '@controls/world-model';
import fc from 'fast-check';
import { BATTERY } from '../../../testing/bench';
import { FLIP, GENERATOR, RESISTOR_2_4, RHEOSTAT, THERMAL_LOAD } from '../../../testing/engine';
import { BENCH_SUPPLY, DIN_PSU, SourceHost, UTILITY_208, UTILITY_480, UTILITY_SPLIT } from '../../../testing/sources';
import { SimEngine } from '../../engine/engine';

/*
 * Determinism properties of F2.4's sources (plan F2.4, the F2.4 test review): saving at T, loading
 * and running on equals the uninterrupted run, and a replay of the log reaches the same bytes, for
 * sessions built around the sources' own state:
 *
 * - a DIN PSU shorted by a lead (it hiccups: `mode` and `phaseTicks`);
 * - a bench supply in current limit into a rheostat (its `mode`, near the CV/CC crossover);
 * - a battery discharging into a resistor (`stateOfCharge`).
 *
 * Then random edits: the rheostat and the supply's controls operated, more supply and battery loops,
 * utility services and the generator stub feeding loads (AC islands, part 2),
 * leads removed, deletes undone, and time passing in steps long enough (up to 2,500 ticks) that the cut
 * often lands inside a 1,100-tick hiccup cycle. The engine sessions (`engine/properties.spec.ts`) keep
 * F2.3a's op mix; the two together cover every engine model (the parity guard there).
 */

type Op =
  | { kind: 'advance'; ticks: number }
  /** Sets a control: the rheostat (3), or the bench supply's (2) setpoint, limit or output. */
  | { kind: 'operate'; control: number; value: number }
  /** Another supply in a loop with a load, or shorted by a lead. */
  | { kind: 'supplyLoop'; din: boolean; load: number }
  /** Another battery into a load. */
  | { kind: 'batteryLoop'; load: number }
  /** A utility service or the generator stub feeding a load (or a short) from L1 to N: an AC island. */
  | { kind: 'serviceLoop'; source: number; load: number }
  | { kind: 'disconnect'; pick: number }
  | { kind: 'deleteUndo'; pick: number }
  | { kind: 'undo' }
  | { kind: 'redo' };

/** Loads: a resistor, a heating load, a load that never settles, or none (a short). */
const LOADS: readonly (CatalogRef | null)[] = [RESISTOR_2_4, THERMAL_LOAD, FLIP, null];
const CONTROLS = [
  [2, 'setpointV', [0, 5, 12, 30]],
  [2, 'currentLimitA', [0, 0.5, 1, 5]],
  [2, 'outputOn', [true, false, true, true]],
  [3, 'ohms', [2, 9.9, 11.92, 50]],
] as const;

/** Module-level arbitraries (never built inside `.chain`). */
/** AC services, for `serviceLoop`. */
const SERVICES: readonly CatalogRef[] = [UTILITY_SPLIT, UTILITY_208, UTILITY_480, GENERATOR];
const pick = fc.nat({ max: 9 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('advance' as const),
      // A few ticks (mid-interval), a few hundred, or most of a hiccup cycle.
      ticks: fc.oneof(fc.nat({ max: 23 }), fc.integer({ min: 60, max: 400 }), fc.integer({ min: 900, max: 2500 })),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('operate' as const),
      control: fc.nat({ max: CONTROLS.length - 1 }),
      value: fc.nat({ max: 3 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('supplyLoop' as const),
      din: fc.boolean(),
      load: fc.nat({ max: LOADS.length - 1 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant('batteryLoop' as const), load: fc.nat({ max: LOADS.length - 2 }) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('serviceLoop' as const),
      source: fc.nat({ max: SERVICES.length - 1 }),
      load: fc.constantFrom(0, 1, 3),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('disconnect' as const), pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('deleteUndo' as const), pick }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'undo' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'redo' as const }) },
);
const sourceSessionArb = fc.record({
  before: fc.array(opArb, { minLength: 1, maxLength: 5 }),
  after: fc.array(opArb, { minLength: 1, maxLength: 5 }),
});

/** Runs a command; refusals (an id that no longer exists, a control another device lacks) are fine. */
function exec(host: SourceHost, id: string, args: object): boolean {
  const result = host.bus.exec(id, args);
  if (result.ok && result.logged) host.engine.applied(result.entry, host.bus.state);
  host.events.push(...host.engine.takeEvents());
  return result.ok;
}

const LEAD = { id: 'lead.quillfern-test-1m', version: 1 };
const end = (entity: number, terminal: string) => ({ entity, terminal });

function loop(host: SourceHost, source: CatalogRef, pos: string, neg: string, load: CatalogRef | null): void {
  if (!exec(host, 'entity.place', { ref: source, positionMm: { x: 0, y: 0, z: 0 } })) return;
  const id = host.bus.state.nextEntityId - 1;
  if (load === null) {
    exec(host, 'lead.connect', { ref: LEAD, a: end(id, pos), b: end(id, neg) });
    return;
  }
  if (!exec(host, 'entity.place', { ref: load, positionMm: { x: 0, y: 0, z: 0 } })) return;
  exec(host, 'lead.connect', { ref: LEAD, a: end(id, pos), b: end(id + 1, 'a') });
  exec(host, 'lead.connect', { ref: LEAD, a: end(id + 1, 'b'), b: end(id, neg) });
}

/** The starting bench: a shorted DIN PSU (1), a bench supply (2) in CC into a rheostat (3), a battery (4) into 2.4 Ω (5). */
function sourceBench(): SourceHost {
  const host = new SourceHost();
  loop(host, DIN_PSU, 'pos', 'neg', null);
  loop(host, BENCH_SUPPLY, 'pos', 'neg', RHEOSTAT);
  exec(host, 'device.operate', { id: 2, control: 'setpointV', value: 12 });
  exec(host, 'device.operate', { id: 2, control: 'currentLimitA', value: 1 });
  exec(host, 'device.operate', { id: 2, control: 'outputOn', value: true });
  loop(host, BATTERY, 'pos', 'neg', RESISTOR_2_4);
  return host;
}

function apply(host: SourceHost, op: Op): void {
  const world = host.bus.state;
  const entityAt = (i: number) => world.entities[i % Math.max(world.entities.length, 1)]?.id ?? 1;
  switch (op.kind) {
    case 'advance':
      host.advance(op.ticks);
      return;
    case 'operate': {
      const [id, control, values] = CONTROLS[op.control];
      exec(host, 'device.operate', { id, control, value: values[op.value] });
      return;
    }
    case 'supplyLoop':
      loop(host, op.din ? DIN_PSU : BENCH_SUPPLY, 'pos', 'neg', LOADS[op.load]);
      return;
    case 'batteryLoop':
      loop(host, BATTERY, 'pos', 'neg', LOADS[op.load]);
      return;
    case 'serviceLoop':
      loop(host, SERVICES[op.source], 'l1', 'n', LOADS[op.load]);
      return;
    case 'disconnect': {
      const connections = world.connections;
      exec(host, 'lead.disconnect', { id: connections[op.pick % Math.max(connections.length, 1)]?.id ?? 1 });
      return;
    }
    case 'deleteUndo':
      if (exec(host, 'entity.delete', { id: entityAt(op.pick) })) exec(host, 'edit.undo', {});
      return;
    case 'undo':
      exec(host, 'edit.undo', {});
      return;
    case 'redo':
      exec(host, 'edit.redo', {});
      return;
  }
}

/**
 * Replays `ops`' log with the engine as time host and checks it reaches the live session's snapshot,
 * world and events. Events are compared in canonical delivery order (`compareSimEvents`: tick, entity,
 * kind). `takeEvents` sorts each batch it delivers, and the live session takes one batch per command
 * while the replay takes one at the end, so the live concatenation is in order only within each
 * batch. Sorting it is exact, not a loosening: the sort is stable and each batch kept its ties in
 * emission order, so the sorted concatenation is the one sort of everything emitted, which is what
 * the replay's single batch is. Main's engine property drains once, at the end, on both sides.
 */
function checkReplay(ops: readonly Op[]): SourceHost {
  const live = sourceBench();
  ops.forEach((op) => apply(live, op));
  const replay = new SourceHost();
  const replayed = replayEntries(replay.bus, live.bus.entries, { time: replay.engine, endTick: live.engine.tick });
  expect(replayed).toStrictEqual({ ok: true });
  expect(replay.engine.snapshot()).toStrictEqual(live.engine.snapshot());
  expect(replay.engine.takeEvents()).toStrictEqual([...live.events].sort(compareSimEvents));
  expect(worldHash(replay.materialised())).toBe(worldHash(live.materialised()));
  return live;
}

const fingerprint = (host: SourceHost) => ({
  tick: host.engine.tick,
  snapshot: host.engine.snapshotHash(),
  world: worldHash(host.materialised()),
});

/** The generator-health sessions (a fixed seed), shared by the at-cut and after-cut tests. */
const HEALTH_SAMPLES = fc.sample(sourceSessionArb, { seed: 20261031, numRuns: 24 });

describe('source determinism properties (F2.4)', () => {
  it('saving at T, loading and running on to T2 equals the uninterrupted run, step by step, events included', () => {
    fc.assert(
      fc.property(sourceSessionArb, ({ before, after }) => {
        const straight = sourceBench();
        before.forEach((op) => apply(straight, op));
        let loaded = straight.reload();
        straight.bus.clearHistory(); // a load clears the undo history (F1.8b), so the straight run does too
        straight.events.length = 0;
        expect(fingerprint(loaded)).toStrictEqual(fingerprint(straight));
        for (const op of after) {
          apply(straight, op);
          apply(loaded, op);
          expect(loaded.engine.snapshotHash()).toBe(straight.engine.snapshotHash());
          expect(loaded.events).toStrictEqual(straight.events);
        }
        expect(fingerprint(loaded)).toStrictEqual(fingerprint(straight));
        loaded = loaded.reload();
        expect(fingerprint(loaded)).toStrictEqual(fingerprint(straight));
      }),
      { numRuns: 8 },
    );
  });

  it("replaying the session's log with the engine as time host reaches the same snapshot bytes and events", () => {
    fc.assert(
      fc.property(sourceSessionArb, ({ before, after }) => {
        checkReplay([...before, ...after]);
      }),
      { numRuns: 8 },
    );
  });

  it('a replay delivers the same events, in canonical order, as a session taking them command by command', () => {
    // The flake loop's counterexample (seed 682033826, path 1:5:3:4:6:8:7:7): two battery loops into
    // never-settling loads, a lead removed, and a delete undone. Live, the session takes events after
    // every command, so the second loop's `nonConverged` (entities 8, 9) arrives in an earlier batch
    // than the undone delete's (6, 7), both at tick 0; the replay takes them in one batch, in canonical
    // order (6, 7 first). The engine raised the same events both times: comparing the concatenated
    // batches with one batch was the test's error, not the engine's.
    const ops: Op[] = [
      { kind: 'batteryLoop', load: 2 },
      { kind: 'disconnect', pick: 0 },
      { kind: 'batteryLoop', load: 2 },
      { kind: 'deleteUndo', pick: 5 },
    ];
    const live = checkReplay(ops);
    const islandEvents = live.events.filter((e) => e.kind === 'nonConverged').map((e) => e.entities);
    expect(islandEvents.slice(-2)).toStrictEqual([
      [8, 9],
      [6, 7],
    ]);
  });

  it('the cuts land mid-hiccup, in current limit and on a discharged battery (generator health, at the cut)', () => {
    const counts = { midInterval: 0, hiccupOff: 0, limitCounting: 0, benchCc: 0, discharged: 0, service: 0 };
    for (const { before } of HEALTH_SAMPLES) {
      const host = sourceBench();
      before.forEach((op) => apply(host, op));
      if (host.engine.tick % 10 !== 0) counts.midInterval++;
      const world = host.materialised();
      const sims = world.entities.map((e) => e.sim);
      if (sims.some((s) => s['mode'] === 'hiccupOff' && (s['phaseTicks'] as number) > 0)) counts.hiccupOff++;
      if (sims.some((s) => s['mode'] === 'limit' && (s['phaseTicks'] as number) > 0)) counts.limitCounting++;
      if (sims.some((s) => s['mode'] === 'cc')) counts.benchCc++;
      if (sims.some((s) => typeof s['stateOfCharge'] === 'number' && s['stateOfCharge'] < 1)) counts.discharged++;
      if (host.engine.islands().some((i) => i.kind === 'ac' && i.status === 'solved')) counts.service++;
    }
    // Measured on this seed, of 24 (with part 2's service loops): 11 cut mid-interval, 7 inside a
    // hiccup's off period, 3 with a limit counting towards a trip, 23 with the bench supply in CC, 11
    // with a discharged battery and 6 with a solved AC service island.
    expect(counts.midInterval).toBeGreaterThan(7);
    expect(counts.hiccupOff).toBeGreaterThan(4);
    expect(counts.limitCounting).toBeGreaterThan(1);
    expect(counts.benchCc).toBeGreaterThan(17);
    expect(counts.discharged).toBeGreaterThan(7);
    expect(counts.service).toBeGreaterThan(3);
  });

  it('after a reload the sessions still hiccup and change mode (generator health, after the cut)', () => {
    const counts = { hiccupsAfterReload: 0, modeChangesAfterReload: 0 };
    for (const { before, after } of HEALTH_SAMPLES) {
      const host = sourceBench();
      before.forEach((op) => apply(host, op));
      const loaded = host.reload();
      const modes = () => loaded.materialised().entities.map((e) => e.sim['mode']);
      const first = JSON.stringify(modes());
      after.forEach((op) => apply(loaded, op));
      if (loaded.events.some((e) => e.kind === 'hiccup')) counts.hiccupsAfterReload++;
      if (JSON.stringify(modes()) !== first) counts.modeChangesAfterReload++;
    }
    // Measured on this seed, of 24: 11 reloaded sessions hiccup after the cut, 17 change a mode.
    expect(counts.hiccupsAfterReload).toBeGreaterThan(7);
    expect(counts.modeChangesAfterReload).toBeGreaterThan(11);
  });

  it('starts from an engine that solves the bench at once (the base of every session)', () => {
    const host = sourceBench();
    expect(host.engine).toBeInstanceOf(SimEngine);
    expect(host.materialised().entities.map((e) => e.sim)).toMatchObject([
      { mode: 'limit', phaseTicks: 0 },
      { mode: 'cc' },
      {},
      { stateOfCharge: 1 },
      {},
    ]);
  });
});
