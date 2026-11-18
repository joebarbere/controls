import { replayEntries } from '@controls/commands';
import { worldHash } from '@controls/world-model';
import fc from 'fast-check';
import { BUSBAR, engineBus, RHEOSTAT } from '../../../testing/engine';
import { AFCI_15, GFCI_20, PLUG_ON_20, PLUG_ON_2P_20 } from '../../../testing/plug-on';
import { SourceHost, UTILITY_SPLIT } from '../../../testing/sources';

/*
 * Determinism properties of breakers v2 (P4 PR 10, ADR 0021 part 2): saving at T, loading and running
 * on equals the uninterrupted run, step by step with its events, and a replay of the log reaches the
 * same bytes, for sessions built around trip, opening-window, residual and test-hold state. The bench,
 * on the utility stand-in (1): a 20 A plug-on breaker (2) into a rheostat (3); a 20 A two-pole one (4)
 * into rheostats (5, 6) from each pole; a GFCI breaker (7) into a rheostat (8) with a ground-fault
 * rheostat (9) from its load to N; a 15 A AFCI breaker (10) into a rheostat (11). Random edits set a
 * load (from 12 Ω to a bolted 0.1 Ω), a ground fault (none, 12 kΩ ≈ 10 mA, 9.6 Ω), turn a handle off
 * or on, press a test button, undo and redo, with time in steps long enough to open, trip and let a
 * test go, so cuts land inside opening windows, mid-integral, held and tripped.
 */

type Op =
  | { kind: 'advance'; ticks: number }
  | { kind: 'load'; pick: number; ohms: number }
  | { kind: 'fault'; ohms: number }
  | { kind: 'handle'; pick: number; on: boolean }
  | { kind: 'press'; afci: boolean }
  | { kind: 'undo' }
  | { kind: 'redo' };

const BREAKERS = [2, 4, 7, 10];
const LOADS = [3, 5, 6, 8, 11];
const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('advance' as const),
      ticks: fc.oneof(
        { weight: 2, arbitrary: fc.nat({ max: 23 }) },
        { weight: 2, arbitrary: fc.integer({ min: 24, max: 600 }) },
        { weight: 1, arbitrary: fc.integer({ min: 600, max: 3000 }) },
      ),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('load' as const),
      pick: fc.nat({ max: LOADS.length - 1 }),
      ohms: fc.constantFrom(12, 4, 1, 0.3, 0.1),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('fault' as const), ohms: fc.constantFrom(1e7, 12_000, 9.6) }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('handle' as const),
      pick: fc.nat({ max: BREAKERS.length - 1 }),
      on: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('press' as const), afci: fc.boolean() }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'undo' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'redo' as const }) },
);
const sessionArb = fc.record({
  before: fc.array(opArb, { minLength: 1, maxLength: 6 }),
  after: fc.array(opArb, { minLength: 1, maxLength: 6 }),
});

function exec(host: SourceHost, id: string, args: object): void {
  const result = host.bus.exec(id, args);
  if (result.ok && result.logged) host.engine.applied(result.entry, host.bus.state);
  host.events.push(...host.engine.takeEvents());
}

function apply(host: SourceHost, op: Op): void {
  switch (op.kind) {
    case 'advance':
      host.advance(op.ticks);
      return;
    case 'load':
      exec(host, 'device.operate', { id: LOADS[op.pick], control: 'ohms', value: op.ohms });
      return;
    case 'fault':
      exec(host, 'device.operate', { id: 9, control: 'ohms', value: op.ohms });
      return;
    case 'handle':
      exec(host, 'device.operate', { id: BREAKERS[op.pick], control: 'on', value: op.on });
      return;
    case 'press':
      exec(host, 'device.press', { id: op.afci ? 10 : 7, control: 'test' });
      return;
    case 'undo':
      exec(host, 'edit.undo', {});
      return;
    case 'redo':
      exec(host, 'edit.redo', {});
      return;
  }
}

function bench(): SourceHost {
  const host = new SourceHost(engineBus(20261118));
  const link = (a: number, ta: string, b: number, tb: string) =>
    host.exec('lead.connect', { ref: BUSBAR, a: { entity: a, terminal: ta }, b: { entity: b, terminal: tb } });
  host.place(UTILITY_SPLIT);
  host.place(PLUG_ON_20); // 2
  host.place(RHEOSTAT); // 3
  host.place(PLUG_ON_2P_20); // 4
  host.place(RHEOSTAT); // 5
  host.place(RHEOSTAT); // 6
  host.place(GFCI_20); // 7
  host.place(RHEOSTAT); // 8
  host.place(RHEOSTAT); // 9
  host.place(AFCI_15); // 10
  host.place(RHEOSTAT); // 11
  link(1, 'l1', 2, 'line');
  link(2, 'load', 3, 'a');
  link(3, 'b', 1, 'n');
  link(1, 'l1', 4, 'line1');
  link(1, 'l2', 4, 'line2');
  link(4, 'load1', 5, 'a');
  link(4, 'load2', 6, 'a');
  link(5, 'b', 1, 'n');
  link(6, 'b', 1, 'n');
  link(1, 'l2', 7, 'line');
  link(7, 'pigtail', 1, 'n');
  link(7, 'load', 8, 'a');
  link(8, 'b', 7, 'loadNeutral');
  link(7, 'load', 9, 'a');
  link(9, 'b', 1, 'n');
  link(1, 'l1', 10, 'line');
  link(10, 'pigtail', 1, 'n');
  link(10, 'load', 11, 'a');
  link(11, 'b', 10, 'loadNeutral');
  for (const id of LOADS) host.operate(id, 'ohms', 12);
  host.operate(9, 'ohms', 1e7);
  for (const id of BREAKERS) host.operate(id, 'on', true);
  return host;
}

const fingerprint = (host: SourceHost) => ({
  tick: host.engine.tick,
  snapshot: host.engine.snapshotHash(),
  world: worldHash(host.materialised()),
});

describe('breakers v2 determinism properties (P4 PR 10)', () => {
  it('saving at T, loading and running on to T2 equals the uninterrupted run, step by step, events included', () => {
    fc.assert(
      fc.property(sessionArb, ({ before, after }) => {
        const straight = bench();
        before.forEach((op) => apply(straight, op));
        let loaded = straight.reload();
        straight.bus.clearHistory();
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
      { numRuns: 10 },
    );
  });

  it("replaying the session's log with the engine as time host reaches the same snapshot bytes and events", () => {
    fc.assert(
      fc.property(sessionArb, ({ before, after }) => {
        const live = bench();
        [...before, ...after].forEach((op) => apply(live, op));
        const replay = new SourceHost(engineBus(20261118));
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

  it('the sessions reach trips of every cause but arcing, opening windows, held tests and residual integrals (generator health)', () => {
    const seen = new Set<string>();
    for (const { before, after } of fc.sample(sessionArb, { seed: 20261118, numRuns: 40 })) {
      const host = bench();
      for (const op of [...before, ...after]) {
        apply(host, op);
        for (const e of host.materialised().entities) {
          const s = e.sim;
          if (typeof s['magneticSinceTick'] === 'number') seen.add('opening');
          if (typeof s['testHeldSinceTick'] === 'number') seen.add('held');
          if ((s['residualIntegral'] as number) > 0) seen.add('residual');
        }
      }
      for (const e of host.events) if (e.kind === 'tripped') seen.add(String(e.detail['cause']));
    }
    expect([...seen].sort()).toStrictEqual([
      'groundFault',
      'held',
      'magnetic',
      'opening',
      'residual',
      'test',
      'thermal',
    ]);
  });
});
