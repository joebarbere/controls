import { replayEntries } from '@controls/commands';
import { worldHash } from '@controls/world-model';
import fc from 'fast-check';
import { AC_SOURCE } from '../../../testing/bench';
import { RESISTOR_12, RHEOSTAT } from '../../../testing/engine';
import {
  A19_60W,
  A19_100W,
  acSourceAt,
  DIMMER,
  LED_A19,
  LED_FIXTURE,
  socket,
  SWITCH_1P,
  SWITCH_3WAY,
} from '../../../testing/lighting';
import { SourceHost } from '../../../testing/sources';
import { OUTER_LOOP_MAX_ITERATIONS } from '../../constants';

/*
 * Determinism properties of P4 F4.1 part 1's lighting models: saving at T, loading and running on equals
 * the uninterrupted run, and a replay of the log reaches the same bytes, over sessions on one bench that
 * holds every lighting model with sim behaviour:
 *
 * - a 3-way pair (2, 3) switching a 60 W A19 bulb (5) in a lampholder (4) on the 120 V test source (1);
 * - a dimmer (6) on that source feeding a 100 W bulb (8) in a second holder (7) (its reactance is fitted
 *   from the warm start, so a cut must continue from the solution record alone);
 * - an LED fixture (11) across the lower arm of a divider (12 Ω (9) over a rheostat (10)) on that source,
 *   whose supply the session moves into and out of its hysteresis band (its `running` is committed state);
 * - a 60 W bulb (14) in a holder (13) behind a single-pole switch (15) on the 200 V test source (12):
 *   closed long enough, it burns out (the sticky `burnedOut`, a topology key set by the protection layer);
 * - an LED A19 bulb (17) in a holder (16) straight across the 120 V source.
 *
 * Cuts land mid-warm-up, mid-dimming and with the driver inside its band. Every AC island's outer loop
 * stays within its cap (bounded iterations).
 */

type Op =
  | { kind: 'advance'; ticks: number }
  | { kind: 'threeWay'; which: 2 | 3; position: 't1' | 't2' }
  | { kind: 'dimmerOn'; on: boolean }
  | { kind: 'dimmerLevel'; level: number }
  | { kind: 'supply'; ohms: number }
  | { kind: 'burn'; closed: boolean }
  | { kind: 'deleteUndo'; pick: number }
  | { kind: 'undo' }
  | { kind: 'redo' };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('advance' as const),
      ticks: fc.oneof(
        { weight: 2, arbitrary: fc.nat({ max: 23 }) },
        { weight: 3, arbitrary: fc.integer({ min: 24, max: 200 }) },
        { weight: 1, arbitrary: fc.integer({ min: 300, max: 1200 }) },
      ),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('threeWay' as const),
      which: fc.constantFrom(2 as const, 3 as const),
      position: fc.constantFrom('t1' as const, 't2' as const),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('dimmerOn' as const), on: fc.boolean() }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('dimmerLevel' as const), level: fc.constantFrom(0, 0.25, 0.5, 0.75, 1) }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('supply' as const), ohms: fc.constantFrom(1e7, 39.43, 24) }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('burn' as const), closed: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('deleteUndo' as const), pick: fc.nat({ max: 20 }) }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'undo' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'redo' as const }) },
);
const sessionArb = fc.record({
  before: fc.array(opArb, { minLength: 1, maxLength: 7 }),
  after: fc.array(opArb, { minLength: 1, maxLength: 6 }),
});

/** Runs a command; refusals (an id that no longer exists) are fine. */
function exec(host: SourceHost, id: string, args: object): boolean {
  const result = host.bus.exec(id, args);
  if (result.ok && result.logged) host.engine.applied(result.entry, host.bus.state);
  host.events.push(...host.engine.takeEvents());
  return result.ok;
}

/** The bench (see the file comment), with the dimmer on at 0.5, the 3-way lamp lit and the 200 V bulb switched on. */
function lightingBench(): SourceHost {
  const host = new SourceHost();
  const source = host.place(AC_SOURCE); // 1
  const s1 = host.place(SWITCH_3WAY); // 2
  const s2 = host.place(SWITCH_3WAY); // 3
  const lamp = socket(host, A19_60W); // 4, 5
  host.lead(source, 'l', s1, 'common').lead(s1, 't1', s2, 't1').lead(s1, 't2', s2, 't2');
  host.lead(s2, 'common', lamp.holder, 'hot').lead(lamp.holder, 'neutral', source, 'n');
  const dimmer = host.place(DIMMER); // 6
  const dimmed = socket(host, A19_100W); // 7, 8
  host.lead(source, 'l', dimmer, 'line').lead(dimmer, 'load', dimmed.holder, 'hot');
  host.lead(dimmed.holder, 'neutral', source, 'n');
  host.operate(dimmer, 'on', true).operate(dimmer, 'level', 0.5);
  const upper = host.place(RESISTOR_12); // 9
  const lower = host.place(RHEOSTAT); // 10
  const fixture = host.place(LED_FIXTURE); // 11
  host.operate(lower, 'ohms', 1e7);
  host.lead(source, 'l', upper, 'a').lead(upper, 'b', lower, 'a').lead(lower, 'b', source, 'n');
  host.lead(upper, 'b', fixture, 'hot').lead(fixture, 'neutral', source, 'n');
  const high = host.place(acSourceAt(200)); // 12
  const burn = socket(host, A19_60W); // 13, 14
  const sw = host.place(SWITCH_1P); // 15
  host.lead(high, 'l', sw, 'a').lead(sw, 'b', burn.holder, 'hot').lead(burn.holder, 'neutral', high, 'n');
  const led = socket(host, LED_A19); // 16, 17
  host.lead(source, 'l', led.holder, 'hot').lead(led.holder, 'neutral', source, 'n');
  // Closed: the 200 V bulb heats from the first tick and burns out after a few hundred ms of advancing.
  host.operate(sw, 'closed', true);
  return host;
}

function apply(host: SourceHost, op: Op): void {
  switch (op.kind) {
    case 'advance':
      host.advance(op.ticks);
      return;
    case 'threeWay':
      exec(host, 'device.operate', { id: op.which, control: 'position', value: op.position });
      return;
    case 'dimmerOn':
      exec(host, 'device.operate', { id: 6, control: 'on', value: op.on });
      return;
    case 'dimmerLevel':
      exec(host, 'device.operate', { id: 6, control: 'level', value: op.level });
      return;
    case 'supply':
      exec(host, 'device.operate', { id: 10, control: 'ohms', value: op.ohms });
      return;
    case 'burn':
      exec(host, 'device.operate', { id: 15, control: 'closed', value: op.closed });
      return;
    case 'deleteUndo': {
      const connections = host.bus.state.connections;
      const id = connections[op.pick % Math.max(connections.length, 1)]?.id ?? 1;
      if (exec(host, 'lead.disconnect', { id })) exec(host, 'edit.undo', {});
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

const fingerprint = (host: SourceHost) => ({
  tick: host.engine.tick,
  snapshot: host.engine.snapshotHash(),
  world: worldHash(host.materialised()),
});

/** Every AC island's outer loop stayed within its cap. */
function bounded(host: SourceHost): void {
  for (const island of host.engine.islands()) {
    expect(island.iterations).toBeLessThanOrEqual(OUTER_LOOP_MAX_ITERATIONS.value);
  }
}

const HEALTH_SAMPLES = fc.sample(sessionArb, { seed: 20261118, numRuns: 24 });

describe('lighting determinism properties (F4.1 part 1)', () => {
  it('saving at T, loading and running on to T2 equals the uninterrupted run, step by step, events included', () => {
    fc.assert(
      fc.property(sessionArb, ({ before, after }) => {
        const straight = lightingBench();
        before.forEach((op) => apply(straight, op));
        bounded(straight);
        let loaded = straight.reload();
        straight.bus.clearHistory();
        straight.events.length = 0;
        expect(fingerprint(loaded)).toStrictEqual(fingerprint(straight));
        for (const op of after) {
          apply(straight, op);
          apply(loaded, op);
          expect(loaded.engine.snapshotHash()).toBe(straight.engine.snapshotHash());
          expect(loaded.events).toStrictEqual(straight.events);
          bounded(loaded);
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
        const live = lightingBench();
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

  it('the cuts land mid-dimming, inside the driver’s band and after a burnout (generator health)', () => {
    const counts = { dimmed: 0, inBand: 0, burnedOut: 0, midInterval: 0 };
    for (const { before } of HEALTH_SAMPLES) {
      const host = lightingBench();
      before.forEach((op) => apply(host, op));
      if (host.engine.tick % 10 !== 0) counts.midInterval++;
      const state = host.bus.state.entities;
      const dimmer = state.find((e) => e.id === 6);
      if (dimmer?.state['on'] === true && (dimmer.state['level'] as number) < 1) counts.dimmed++;
      if (state.find((e) => e.id === 10)?.state['ohms'] === 39.43) counts.inBand++;
      if (host.sim(14)['burnedOut'] === true) counts.burnedOut++;
    }
    // Measured on this seed, of 24: 20 dimmed, 6 with the driver's supply in its band, 9 burned out, 13
    // cut mid-interval.
    expect(counts.dimmed).toBeGreaterThan(8);
    expect(counts.inBand).toBeGreaterThan(3);
    expect(counts.burnedOut).toBeGreaterThan(4);
    expect(counts.midInterval).toBeGreaterThan(8);
  });

  it('starts with the 3-way lamp lit, the bulb dimmed, the LEDs running and the 200 V bulb burning out', () => {
    const host = lightingBench();
    expect(host.sim(14)['burnedOut']).toBe(false);
    host.advance(300);
    expect(host.engine.branchAmps({ kind: 'entity', entity: 5, part: 'filament' })).toBeGreaterThan(0.4);
    expect(host.record(8)['lightOutputRel']).toBeLessThan(0.5);
    expect(host.sim(11)['running']).toBe(true);
    expect(host.sim(17)['running']).toBe(true);
    expect(host.sim(14)['burnedOut']).toBe(true);
  });
});
