import type { ReplayEntry } from '@controls/save-format';
import fc from 'fast-check';
import { z } from 'zod';
import { editCommands, NoArgs, viewCommands } from './builtin';
import { CommandBus, type ExecutedEvent } from './bus';
import { type CommandDef, defineCommand, fail, succeed } from './command';
import { CommandRegistry } from './registry';
import { replayEntries, type ReplayTime } from './replay';

/*
 * Time passing (ADR 0011 §3, plan F2.3a): `CommandBus.advanceTo` and replay advancing. A toy state
 * (a list of integers and a tick), like `bus.spec.ts`, so the bus's guarantees are proven
 * independently of the world model; `world-model` repeats them with the real world commands.
 */

interface Toy {
  readonly tick: number;
  readonly items: readonly number[];
}

const initial: Toy = Object.freeze({ tick: 0, items: Object.freeze([]) });

const push = defineCommand<{ value: number }, Toy>({
  id: 'list.push',
  title: 'Push',
  category: 'List',
  args: z.strictObject({ value: z.int() }),
  undoable: true,
  run: (_ctx, { value }) =>
    succeed({
      apply: (s) => ({ ...s, items: [...s.items, value] }),
      invert: (s) => ({ ...s, items: s.items.slice(0, -1) }),
    }),
});

const pop = defineCommand<NoArgs, Toy>({
  id: 'list.pop',
  title: 'Pop',
  category: 'List',
  args: NoArgs,
  undoable: true,
  run: ({ state }) => {
    if (state.items.length === 0) return fail('empty', 'The list is empty');
    const last = state.items[state.items.length - 1];
    return succeed({
      apply: (s) => ({ ...s, items: s.items.slice(0, -1) }),
      invert: (s) => ({ ...s, items: [...s.items, last] }),
    });
  },
});

const chrome = defineCommand<NoArgs, Toy>({
  id: 'test.chrome',
  title: 'Chrome',
  category: 'Test',
  args: NoArgs,
  undoable: false,
  logged: false,
  run: () => succeed(),
});

const defs = [push, pop, chrome, ...editCommands<Toy>(), ...viewCommands<Toy>()] as CommandDef<never, Toy>[];

/** A bus that can move time (`withTick`), as world buses are. */
function timedBus(state: Toy = initial): CommandBus<Toy> {
  return new CommandBus<Toy>({
    registry: new CommandRegistry<Toy>().registerAll(defs),
    initialState: state,
    tickOf: (s) => s.tick,
    withTick: (s, tick) => ({ ...s, tick }),
  });
}

/** A bus without `withTick`: it can't move time. */
function fixedBus(): CommandBus<Toy> {
  return new CommandBus<Toy>({
    registry: new CommandRegistry<Toy>().registerAll(defs),
    initialState: initial,
    tickOf: (s) => s.tick,
  });
}

/** Records what a replay asks of its time host, and checks it is only ever asked to go forwards. */
function recordingTime(): { readonly calls: string[]; readonly time: ReplayTime<Toy> } {
  const calls: string[] = [];
  let tick = 0;
  return {
    calls,
    time: {
      advanceTo(to) {
        if (to <= tick) throw new Error(`time didn't move forwards: ${tick} → ${to}`);
        tick = to;
        calls.push(`advance ${to}`);
      },
      applied(entry, state) {
        if (entry.tick !== tick || state.tick !== tick) throw new Error(`applied ${entry.seq} away from tick ${tick}`);
        calls.push(`applied ${entry.seq}@${entry.tick}`);
      },
    },
  };
}

type Op = { kind: 'push'; value: number } | { kind: 'pop' } | { kind: 'undo' } | { kind: 'redo' } | { kind: 'view' };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('push' as const), value: fc.integer({ min: -5, max: 5 }) }),
  fc.constant({ kind: 'pop' as const }),
  fc.constant({ kind: 'undo' as const }),
  fc.constant({ kind: 'redo' as const }),
  fc.constant({ kind: 'view' as const }),
);
/** A session: each op after advancing some ticks (often none, so several commands share a tick). */
const sessionArb = fc.array(fc.tuple(opArb, fc.oneof(fc.constant(0), fc.nat({ max: 40 }))), {
  minLength: 1,
  maxLength: 30,
  size: 'medium',
});

function run(bus: CommandBus<Toy>, op: Op): void {
  if (op.kind === 'push') bus.exec('list.push', { value: op.value });
  else if (op.kind === 'pop') bus.exec('list.pop');
  else if (op.kind === 'undo') bus.exec('edit.undo');
  else if (op.kind === 'redo') bus.exec('edit.redo');
  else bus.exec('view.resetLayout');
}

describe('CommandBus.advanceTo (time passing is not a command)', () => {
  it('moves the tick without logging, taking a seq, touching the history or firing an event', () => {
    const bus = timedBus();
    const events: ExecutedEvent<Toy>[] = [];
    bus.subscribe((e) => events.push(e));
    bus.exec('list.push', { value: 1 });
    bus.exec('list.push', { value: 2 });
    bus.exec('edit.undo');
    const [entries, canUndo, canRedo, items] = [[...bus.entries], bus.canUndo, bus.canRedo, bus.state.items];
    bus.advanceTo(250);
    expect(bus.currentTick()).toBe(250);
    expect(bus.state.items).toBe(items);
    expect(bus.entries).toStrictEqual(entries);
    expect([bus.canUndo, bus.canRedo]).toStrictEqual([canUndo, canRedo]);
    expect(bus.nextSeq()).toBe(3);
    expect(events).toHaveLength(3);
    // Later commands are stamped at the new tick; undo and redo don't rewind it.
    expect(bus.exec('list.push', { value: 3 })).toMatchObject({ entry: { seq: 3, tick: 250 } });
    bus.exec('edit.undo');
    bus.exec('edit.undo');
    expect(bus.currentTick()).toBe(250);
    expect(bus.state.items).toStrictEqual([]);
  });

  it('is a no-op at the current tick, and refuses going back, unsafe ticks and a bus without withTick', () => {
    const bus = timedBus();
    bus.advanceTo(5);
    const state = bus.state;
    bus.advanceTo(5);
    expect(bus.state).toBe(state);
    expect(() => bus.advanceTo(4)).toThrow(RangeError);
    for (const bad of [5.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
      expect(() => bus.advanceTo(bad)).toThrow(RangeError);
    }
    expect(bus.currentTick()).toBe(5);
    expect(bus.canAdvance).toBe(true);
    const fixed = fixedBus();
    expect(fixed.canAdvance).toBe(false);
    expect(() => fixed.advanceTo(1)).toThrow(/withTick/);
  });

  it('time passing between commands never changes what they do, and undo and redo never rewind it (property)', () => {
    fc.assert(
      fc.property(sessionArb, (steps) => {
        const timed = timedBus();
        const still = fixedBus();
        for (const [op, dt] of steps) {
          timed.advanceTo(timed.currentTick() + dt);
          const before = timed.currentTick();
          run(timed, op);
          run(still, op);
          expect(timed.currentTick()).toBe(before);
          expect(timed.state.items).toStrictEqual(still.state.items);
          expect([timed.canUndo, timed.canRedo]).toStrictEqual([still.canUndo, still.canRedo]);
        }
        expect(timed.entries.map(({ id, args }) => ({ id, args }))).toStrictEqual(
          still.entries.map(({ id, args }) => ({ id, args })),
        );
      }),
    );
  });
});

describe('replayEntries with time', () => {
  /** A live session that advances between commands, as a running game does. */
  function timedLog(): CommandBus<Toy> {
    const live = timedBus();
    live.exec('list.push', { value: 1 });
    live.advanceTo(10);
    live.exec('list.push', { value: 2 });
    live.exec('view.resetLayout');
    live.advanceTo(37);
    live.exec('edit.undo');
    live.advanceTo(90);
    return live;
  }

  it("advances the time host and the bus to each entry's tick, applies it there, then advances to endTick", () => {
    const live = timedLog();
    const replayed = timedBus();
    const { calls, time } = recordingTime();
    expect(replayEntries(replayed, live.entries, { time, endTick: 90 })).toStrictEqual({ ok: true });
    expect(calls).toStrictEqual([
      'applied 0@0',
      'advance 10',
      'applied 1@10',
      'applied 2@10',
      'advance 37',
      'applied 3@37',
      'advance 90',
    ]);
    expect(replayed.state).toStrictEqual(live.state);
    expect(replayed.entries).toStrictEqual(live.entries);
  });

  it('without a time host only the bus moves; without endTick it stops at the last entry', () => {
    const live = timedLog();
    const replayed = timedBus();
    expect(replayEntries(replayed, live.entries)).toStrictEqual({ ok: true });
    expect(replayed.currentTick()).toBe(37);
    expect(replayed.state.items).toStrictEqual(live.state.items);
  });

  it('refuses an entry before the current tick, and a later one on a bus that cannot advance', () => {
    const live = timedLog();
    const [first, second] = live.entries;
    expect(
      replayEntries(timedBus(), [
        { ...second, seq: 0 },
        { ...first, seq: 1 },
      ]),
    ).toStrictEqual({
      ok: false,
      error: { kind: 'tick-mismatch', seq: 1, message: 'Entry 1 was logged at tick 0 but replayed at tick 10' },
    });
    expect(replayEntries(fixedBus(), live.entries)).toMatchObject({
      ok: false,
      error: { kind: 'tick-mismatch', seq: 1 },
    });
  });

  it('refuses an endTick before the last entry, or one a bus without withTick cannot reach', () => {
    const live = timedLog();
    expect(replayEntries(timedBus(), live.entries, { endTick: 20 })).toStrictEqual({
      ok: false,
      error: { kind: 'tick-mismatch', seq: 4, message: 'The log ends at tick 20 but replay reached tick 37' },
    });
    expect(replayEntries(timedBus(), live.entries, { endTick: 37.5 })).toMatchObject({ ok: false });
    const still = fixedBus();
    still.exec('list.push', { value: 1 });
    expect(replayEntries(fixedBus(), still.entries, { endTick: 0 })).toStrictEqual({ ok: true });
    expect(replayEntries(fixedBus(), still.entries, { endTick: 5 })).toMatchObject({
      ok: false,
      error: { kind: 'tick-mismatch' },
    });
  });

  it('carries an unlogged entry over at its own tick, telling the time host', () => {
    const replayed = timedBus();
    const { calls, time } = recordingTime();
    const old: ReplayEntry[] = [
      { seq: 0, tick: 0, id: 'list.push', args: { value: 1 } },
      { seq: 1, tick: 4, id: 'test.chrome', args: {} },
    ];
    expect(replayEntries(replayed, old, { time, endTick: 4 })).toStrictEqual({ ok: true });
    expect(calls).toStrictEqual(['applied 0@0', 'advance 4', 'applied 1@4']);
    expect(replayed.entries).toStrictEqual(old);
  });

  it('a replay of any timed session reaches the live state, log and tick, the host only moving forwards (property)', () => {
    fc.assert(
      fc.property(sessionArb, fc.nat({ max: 20 }), (steps, tail) => {
        const live = timedBus();
        for (const [op, dt] of steps) {
          live.advanceTo(live.currentTick() + dt);
          run(live, op);
        }
        live.advanceTo(live.currentTick() + tail);
        const replayed = timedBus();
        const { calls, time } = recordingTime();
        expect(replayEntries(replayed, live.entries, { time, endTick: live.currentTick() })).toStrictEqual({
          ok: true,
        });
        expect(replayed.state).toStrictEqual(live.state);
        expect(replayed.entries).toStrictEqual(live.entries);
        expect(calls.filter((c) => c.startsWith('applied'))).toHaveLength(live.entries.length);
      }),
    );
  });

  it('the timed-session generator spreads commands over many ticks and shares some (generator health)', () => {
    const samples = fc.sample(sessionArb, { seed: 20261031, numRuns: 200 });
    // At least three advances, and at least one command sharing its tick with the one before it.
    const spread = samples.filter((steps) => steps.filter(([, dt]) => dt > 0).length >= 3).length;
    const shared = samples.filter((steps) => steps.slice(1).some(([, dt]) => dt === 0)).length;
    expect(spread).toBeGreaterThan(100);
    expect(shared).toBeGreaterThan(100);
  });
});
