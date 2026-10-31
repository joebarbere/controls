import { replayEntries } from '@controls/commands';
import type { CatalogRef } from '@controls/save-format';
import { worldHash } from '@controls/world-model';
import fc from 'fast-check';
import { BATTERY, LAMP, SPST } from '../../../testing/bench';
import { benchLampHost, HEATER, RESISTOR_10R } from '../../../testing/loads';
import { BENCH_SUPPLY, SourceHost } from '../../../testing/sources';
import { LAMP_AMBIENT_K } from './lamp';

/*
 * Determinism properties of F2.5's loads (plan F2.5): saving at T, loading and running on equals the
 * uninterrupted run, and a replay of the log reaches the same bytes, for sessions built around the
 * lamp's filament: the bench demo (a battery, a switch and the lamp) whose switch is flipped while the
 * filament heats or cools, so cuts land mid-warm-up, where the continuous layer re-solves within steps
 * (its trigger reads the solution, never a cached value). Random edits add more loops (the lamp, the
 * resistor and the heater on a battery or a bench supply), remove leads and undo deletes. The engine
 * sessions (`engine/properties.spec.ts`) and the source sessions cover the other models; the parity
 * guard there checks every model is in one of them.
 */

type Op =
  | { kind: 'advance'; ticks: number }
  /** Flips the bench switch (2). */
  | { kind: 'flip'; closed: boolean }
  /** A battery or a bench supply (12 V, output on) into a load. */
  | { kind: 'loop'; supply: boolean; load: number }
  | { kind: 'disconnect'; pick: number }
  | { kind: 'deleteUndo'; pick: number }
  | { kind: 'undo' }
  | { kind: 'redo' };

const LOADS: readonly CatalogRef[] = [LAMP, RESISTOR_10R, HEATER];
const pick = fc.nat({ max: 9 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('advance' as const),
      // A few ticks (mid-interval, mid-warm-up), a warm-up's worth, or long enough to settle or go dark.
      ticks: fc.oneof(
        { weight: 2, arbitrary: fc.nat({ max: 23 }) },
        { weight: 3, arbitrary: fc.integer({ min: 24, max: 180 }) },
        { weight: 1, arbitrary: fc.integer({ min: 300, max: 1500 }) },
      ),
    }),
  },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('flip' as const), closed: fc.boolean() }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('loop' as const),
      supply: fc.boolean(),
      load: fc.nat({ max: LOADS.length - 1 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('disconnect' as const), pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('deleteUndo' as const), pick }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'undo' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'redo' as const }) },
);
const loadSessionArb = fc.record({
  before: fc.array(opArb, { minLength: 1, maxLength: 6 }),
  after: fc.array(opArb, { minLength: 1, maxLength: 6 }),
});

/** Runs a command; refusals (an id that no longer exists) are fine. */
function exec(host: SourceHost, id: string, args: object): boolean {
  const result = host.bus.exec(id, args);
  if (result.ok && result.logged) host.engine.applied(result.entry, host.bus.state);
  host.events.push(...host.engine.takeEvents());
  return result.ok;
}

const LEAD = { id: 'lead.quillfern-test-1m', version: 1 };
const end = (entity: number, terminal: string) => ({ entity, terminal });

function loop(host: SourceHost, supply: boolean, load: CatalogRef): void {
  if (!exec(host, 'entity.place', { ref: supply ? BENCH_SUPPLY : BATTERY, positionMm: { x: 0, y: 0, z: 0 } })) return;
  const id = host.bus.state.nextEntityId - 1;
  if (supply) {
    exec(host, 'device.operate', { id, control: 'setpointV', value: 12 });
    exec(host, 'device.operate', { id, control: 'currentLimitA', value: 5 });
    exec(host, 'device.operate', { id, control: 'outputOn', value: true });
  }
  if (!exec(host, 'entity.place', { ref: load, positionMm: { x: 0, y: 0, z: 0 } })) return;
  exec(host, 'lead.connect', { ref: LEAD, a: end(id, 'pos'), b: end(id + 1, 'a') });
  exec(host, 'lead.connect', { ref: LEAD, a: end(id + 1, 'b'), b: end(id, 'neg') });
}

function apply(host: SourceHost, op: Op): void {
  const world = host.bus.state;
  switch (op.kind) {
    case 'advance':
      host.advance(op.ticks);
      return;
    case 'flip':
      exec(host, 'device.operate', { id: 2, control: 'closed', value: op.closed });
      return;
    case 'loop':
      loop(host, op.supply, LOADS[op.load]);
      return;
    case 'disconnect': {
      const connections = world.connections;
      exec(host, 'lead.disconnect', { id: connections[op.pick % Math.max(connections.length, 1)]?.id ?? 1 });
      return;
    }
    case 'deleteUndo': {
      const id = world.entities[op.pick % Math.max(world.entities.length, 1)]?.id ?? 1;
      if (exec(host, 'entity.delete', { id })) exec(host, 'edit.undo', {});
      return;
    }
    case 'undo':
      exec(host, 'edit.undo', {});
      return;
    case 'redo':
      exec(host, 'edit.redo', {});
      return;
  }
}

/** The bench demo with its switch closed at tick 0: the lamp starts heating at once. */
function loadBench(): SourceHost {
  const host = benchLampHost();
  exec(host, 'device.operate', { id: 2, control: 'closed', value: true });
  return host;
}

const fingerprint = (host: SourceHost) => ({
  tick: host.engine.tick,
  snapshot: host.engine.snapshotHash(),
  world: worldHash(host.materialised()),
});

/** The generator-health sessions (a fixed seed). */
const HEALTH_SAMPLES = fc.sample(loadSessionArb, { seed: 20261031, numRuns: 24 });

describe('load determinism properties (F2.5)', () => {
  it('saving at T, loading and running on to T2 equals the uninterrupted run, step by step, events included', () => {
    fc.assert(
      fc.property(loadSessionArb, ({ before, after }) => {
        const straight = loadBench();
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
      fc.property(loadSessionArb, ({ before, after }) => {
        const live = loadBench();
        [...before, ...after].forEach((op) => apply(live, op));
        const replay = new SourceHost();
        expect(
          replayEntries(replay.bus, live.bus.entries, { time: replay.engine, endTick: live.engine.tick }),
        ).toStrictEqual({ ok: true });
        expect(replay.engine.snapshot()).toStrictEqual(live.engine.snapshot());
        expect(replay.engine.takeEvents()).toStrictEqual(live.events);
        expect(worldHash(replay.materialised())).toBe(worldHash(live.materialised()));
      }),
      { numRuns: 8 },
    );
  });

  it('the cuts land with a filament mid-warm-up or cooling, and the re-solves go on after the reload (generator health)', () => {
    const counts = { midInterval: 0, warming: 0, resolvesAfterReload: 0, loops: 0 };
    for (const { before, after } of HEALTH_SAMPLES) {
      const host = loadBench();
      before.forEach((op) => apply(host, op));
      if (host.engine.tick % 10 !== 0) counts.midInterval++;
      const temps = host
        .materialised()
        .entities.map((e) => e.sim['filamentTempK'])
        .filter((t): t is number => typeof t === 'number');
      if (temps.some((t) => t > LAMP_AMBIENT_K.value + 100 && t < 2700)) counts.warming++;
      if (host.bus.state.entities.length > 3) counts.loops++;
      const loaded = host.reload();
      after.forEach((op) => apply(loaded, op));
      if (loaded.engine.stats.continuousSolves > 0) counts.resolvesAfterReload++;
    }
    // Measured on this seed, of 24: 13 cut mid-interval, 7 with a filament between ambient and its
    // settled temperature (heating or cooling), 13 re-solving within steps after the reload, 8 with
    // loops added.
    expect(counts.midInterval).toBeGreaterThan(8);
    expect(counts.warming).toBeGreaterThan(4);
    expect(counts.resolvesAfterReload).toBeGreaterThan(8);
    expect(counts.loops).toBeGreaterThan(4);
  });

  it('starts from the bench demo with the lamp at ambient and the switch closed', () => {
    const host = loadBench();
    expect(host.bus.state.entities.map((e) => e.ref.id)).toStrictEqual([BATTERY.id, SPST.id, LAMP.id]);
    expect(host.sim(3)).toStrictEqual({ filamentTempK: LAMP_AMBIENT_K.value });
    expect(host.record(3)['currentA']).toBeGreaterThan(5);
  });
});
