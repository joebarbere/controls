import { replayEntries } from '@controls/commands';
import type { CatalogRef } from '@controls/save-format';
import { worldHash } from '@controls/world-model';
import fc from 'fast-check';
import { BATTERY, LAMP } from '../../../testing/bench';
import { RHEOSTAT } from '../../../testing/engine';
import { HEATER, RESISTOR_10R } from '../../../testing/loads';
import { BREAKER, FUSE_1A } from '../../../testing/protection';
import { SourceHost } from '../../../testing/sources';

/*
 * Determinism properties of F2.5 part 2's protection (plan F2.5): saving at T, loading and running on
 * equals the uninterrupted run, and a replay of the log reaches the same bytes, for sessions built
 * around melt and trip state. The bench: a battery (1) through the fuse (2) into a rheostat (3) at 6.7 Ω
 * (1.85 A: the two-body fuse melts after about 1.5 s), and a battery (4) shorted through the breaker (5, handle on:
 * about 7.5 × its rating, a thermal trip after about 1.7 s). Random edits turn the last breaker's handle
 * off and on (a reset), add more protected loops (a lamp, the resistor, the heater or a short behind a
 * fuse or a breaker), remove leads and undo deletes, with time in steps long enough to melt and trip,
 * so cuts land part-melted, warm, blown and tripped. Kept apart from the load sessions so each stays
 * small (the simulation caveats: split a slow property by concern).
 */

type Op =
  | { kind: 'advance'; ticks: number }
  /** Turns the handle of the last breaker placed off or on (a reset needs off, then on). */
  | { kind: 'handle'; on: boolean }
  /** A battery through a fuse or a breaker (handle on) into a load, or a short. */
  | { kind: 'protected'; breaker: boolean; load: number }
  | { kind: 'disconnect'; pick: number }
  | { kind: 'deleteUndo'; pick: number }
  | { kind: 'undo' }
  | { kind: 'redo' };

/** Behind a fuse or breaker: a lamp (no trip), the resistor (the fuse melts), the heater (4.3 A), or a short. */
const LOADS: readonly (CatalogRef | null)[] = [LAMP, RESISTOR_10R, HEATER, null];
const pick = fc.nat({ max: 9 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('advance' as const),
      ticks: fc.oneof(
        { weight: 2, arbitrary: fc.nat({ max: 23 }) },
        { weight: 2, arbitrary: fc.integer({ min: 24, max: 400 }) },
        { weight: 2, arbitrary: fc.integer({ min: 600, max: 2500 }) },
      ),
    }),
  },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('handle' as const), on: fc.boolean() }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('protected' as const),
      breaker: fc.boolean(),
      load: fc.nat({ max: LOADS.length - 1 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('disconnect' as const), pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('deleteUndo' as const), pick }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'undo' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'redo' as const }) },
);
const sessionArb = fc.record({
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

/** A battery, then the fuse or breaker (handle on) from its + to the load (or straight back to −). */
function protectedLoop(host: SourceHost, breaker: boolean, load: CatalogRef | null): void {
  if (!exec(host, 'entity.place', { ref: BATTERY, positionMm: { x: 0, y: 0, z: 0 } })) return;
  const battery = host.bus.state.nextEntityId - 1;
  if (!exec(host, 'entity.place', { ref: breaker ? BREAKER : FUSE_1A, positionMm: { x: 0, y: 0, z: 0 } })) return;
  const device = battery + 1;
  const [a, b] = breaker ? ['line', 'load'] : ['a', 'b'];
  if (breaker) exec(host, 'device.operate', { id: device, control: 'on', value: true });
  exec(host, 'lead.connect', { ref: LEAD, a: end(battery, 'pos'), b: end(device, a) });
  if (load === null) {
    exec(host, 'lead.connect', { ref: LEAD, a: end(device, b), b: end(battery, 'neg') });
    return;
  }
  if (!exec(host, 'entity.place', { ref: load, positionMm: { x: 0, y: 0, z: 0 } })) return;
  exec(host, 'lead.connect', { ref: LEAD, a: end(device, b), b: end(device + 1, 'a') });
  exec(host, 'lead.connect', { ref: LEAD, a: end(device + 1, 'b'), b: end(battery, 'neg') });
}

function apply(host: SourceHost, op: Op): void {
  const world = host.bus.state;
  switch (op.kind) {
    case 'advance':
      host.advance(op.ticks);
      return;
    case 'handle': {
      const breaker = [...world.entities].reverse().find((e) => e.ref.id === BREAKER.id);
      if (breaker) exec(host, 'device.operate', { id: breaker.id, control: 'on', value: op.on });
      return;
    }
    case 'protected':
      protectedLoop(host, op.breaker, LOADS[op.load]);
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

function protectionBench(): SourceHost {
  const host = new SourceHost();
  protectedLoop(host, false, RHEOSTAT);
  exec(host, 'device.operate', { id: 3, control: 'ohms', value: 6.7 });
  protectedLoop(host, true, null);
  return host;
}

const fingerprint = (host: SourceHost) => ({
  tick: host.engine.tick,
  snapshot: host.engine.snapshotHash(),
  world: worldHash(host.materialised()),
});

/** The generator-health sessions (a fixed seed). */
const HEALTH_SAMPLES = fc.sample(sessionArb, { seed: 20261031, numRuns: 24 });

describe('protection determinism properties (F2.5 part 2)', () => {
  it('saving at T, loading and running on to T2 equals the uninterrupted run, step by step, events included', () => {
    fc.assert(
      fc.property(sessionArb, ({ before, after }) => {
        const straight = protectionBench();
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
      fc.property(sessionArb, ({ before, after }) => {
        const live = protectionBench();
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

  it('the cuts land part-melted, warm, blown and tripped, and trips go on after the reload (generator health)', () => {
    const counts = { midInterval: 0, heating: 0, blown: 0, tripped: 0, eventsAfterReload: 0 };
    for (const { before, after } of HEALTH_SAMPLES) {
      const host = protectionBench();
      before.forEach((op) => apply(host, op));
      if (host.engine.tick % 10 !== 0) counts.midInterval++;
      const sims = host.materialised().entities.map((e) => e.sim);
      const warm = (v: unknown) => typeof v === 'number' && v > 0.05;
      if (
        sims.some(
          (s) =>
            (s['blown'] === false && warm((s['elementHeat'] as number) + (s['bodyHeat'] as number))) ||
            (s['tripped'] === false && warm(s['thermal'])),
        )
      )
        counts.heating++;
      if (sims.some((s) => s['blown'] === true)) counts.blown++;
      if (sims.some((s) => s['tripped'] === true)) counts.tripped++;
      const loaded = host.reload();
      after.forEach((op) => apply(loaded, op));
      if (loaded.events.some((e) => e.kind === 'blown' || e.kind === 'tripped')) counts.eventsAfterReload++;
    }
    // Measured on this seed, of 24 (two-body fuse, F2.5 review): 18 cut mid-interval, 11 with a fuse or
    // breaker part-heated, 6 with a blown fuse, 6 with a tripped breaker, 4 that blow or trip after the
    // reload.
    expect(counts.midInterval).toBeGreaterThan(12);
    expect(counts.heating).toBeGreaterThan(6);
    expect(counts.blown).toBeGreaterThan(3);
    expect(counts.tripped).toBeGreaterThan(3);
    expect(counts.eventsAfterReload).toBeGreaterThan(1);
  });
});
