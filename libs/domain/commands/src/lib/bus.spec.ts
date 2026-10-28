import fc from 'fast-check';
import { z } from 'zod';
import { editCommands, NoArgs, viewCommands } from './builtin';
import { CommandBus, type ExecutedEvent } from './bus';
import { type CommandDef, defineCommand, fail, succeed } from './command';
import { CommandRegistry } from './registry';
import { replayEntries } from './replay';

/*
 * The bus is generic over its state. These tests use a toy state (a list of integers) so that the
 * engine's own guarantees are proven independently of the world model; `@controls/world-model`
 * repeats the properties with the real world commands and `world.hash`.
 */

interface Toy {
  readonly tick: number;
  readonly assisted: boolean;
  readonly items: readonly number[];
}

const initial: Toy = Object.freeze({ tick: 0, assisted: false, items: Object.freeze([]) });

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

/** A non-undoable state change, like a future `sim.step`: it clears the history. */
const advance = defineCommand<NoArgs, Toy>({
  id: 'sim.advance',
  title: 'Advance tick',
  category: 'Sim',
  args: NoArgs,
  undoable: false,
  run: () => succeed({ apply: (s) => ({ ...s, tick: s.tick + 1 }), invert: (s) => ({ ...s, tick: s.tick - 1 }) }),
});

const cheat = defineCommand<NoArgs, Toy>({
  id: 'cheat.fill',
  title: 'Fill',
  category: 'Cheat',
  args: NoArgs,
  undoable: true,
  cheat: true,
  run: () =>
    succeed({
      apply: (s) => ({ ...s, items: [...s.items, 99] }),
      invert: (s) => ({ ...s, items: s.items.slice(0, -1) }),
    }),
});

const throws = defineCommand<NoArgs, Toy>({
  id: 'test.throws',
  title: 'Throws',
  category: 'Test',
  args: NoArgs,
  undoable: true,
  run: () => {
    throw new Error('boom');
  },
});

const throwsInApply = defineCommand<NoArgs, Toy>({
  id: 'test.throwsInApply',
  title: 'Throws in apply',
  category: 'Test',
  args: NoArgs,
  undoable: true,
  run: () =>
    succeed({
      apply: () => {
        throw 'not an Error';
      },
      invert: (s) => s,
    }),
});

/** Parses, but to something a replay entry can't hold (a non-finite number). */
const notJson = defineCommand<{ value: number }, Toy>({
  id: 'test.notJson',
  title: 'Not JSON',
  category: 'Test',
  args: z.strictObject({}).transform(() => ({ value: Number.POSITIVE_INFINITY })),
  undoable: false,
  run: () => succeed(),
});

/** A history move from a custom command when the stack is empty (the built-ins check first). */
const rogueUndo = defineCommand<NoArgs, Toy>({
  id: 'test.rogueUndo',
  title: 'Rogue undo',
  category: 'Test',
  args: NoArgs,
  undoable: false,
  run: () => ({ ok: true, history: 'undo' }),
});

/** UI chrome: runs and notifies, never logged. */
const chrome = defineCommand<NoArgs, Toy>({
  id: 'test.chrome',
  title: 'Chrome',
  category: 'Test',
  args: NoArgs,
  undoable: false,
  logged: false,
  run: () => succeed(),
});

/** Unlogged but returns a change: refused at exec, since replay could never see it. */
const unloggedChange = defineCommand<NoArgs, Toy>({
  id: 'test.unloggedChange',
  title: 'Unlogged change',
  category: 'Test',
  args: NoArgs,
  undoable: false,
  logged: false,
  run: () => succeed({ apply: (s) => ({ ...s, items: [...s.items, 9] }), invert: (s) => s }),
});

/** Unlogged but moves the history: refused too. */
const unloggedUndo = defineCommand<NoArgs, Toy>({
  id: 'test.unloggedUndo',
  title: 'Unlogged undo',
  category: 'Test',
  args: NoArgs,
  undoable: false,
  logged: false,
  run: (ctx) => (ctx.canUndo ? { ok: true, history: 'undo' } : fail('nothing-to-undo', 'Nothing to undo')),
});

const defs: CommandDef<never, Toy>[] = [
  chrome,
  unloggedChange,
  unloggedUndo,
  push,
  pop,
  advance,
  cheat,
  throws,
  throwsInApply,
  notJson,
  rogueUndo,
  ...editCommands<Toy>(),
  ...viewCommands<Toy>(),
] as CommandDef<never, Toy>[];

function createBus(state: Toy = initial): CommandBus<Toy> {
  return new CommandBus<Toy>({
    registry: new CommandRegistry<Toy>().registerAll(defs),
    initialState: state,
    tickOf: (s) => s.tick,
    markAssisted: (s) => ({ ...s, assisted: true }),
  });
}

describe('CommandBus.exec', () => {
  it('parses args, applies the change, logs the entry and notifies subscribers', () => {
    const bus = createBus();
    const events: ExecutedEvent<Toy>[] = [];
    const unsubscribe = bus.subscribe((e) => events.push(e));
    const result = bus.exec('list.push', { value: -0 });
    expect(result).toEqual({
      ok: true,
      logged: true,
      entry: { seq: 0, tick: 0, id: 'list.push', args: { value: 0 } },
      command: { id: 'list.push', tick: 0, args: { value: 0 } },
    });
    expect(bus.state.items).toEqual([0]);
    expect(bus.entries).toEqual([{ seq: 0, tick: 0, id: 'list.push', args: { value: 0 } }]);
    expect(Object.isFrozen(bus.entries[0].args)).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].previous).toBe(initial);
    expect(events[0].state).toBe(bus.state);
    expect(events[0].def.id).toBe('list.push');
    unsubscribe();
    bus.exec('list.push', { value: 2 });
    expect(events).toHaveLength(1);
  });

  it('defaults args to {} for commands without arguments', () => {
    const bus = createBus();
    bus.exec('list.push', { value: 1 });
    expect(bus.exec('list.pop').ok).toBe(true);
  });

  it('returns a typed error for an unknown command and changes nothing', () => {
    const bus = createBus();
    expect(bus.exec('no.such', {})).toEqual({
      ok: false,
      error: { kind: 'unknown-command', id: 'no.such', message: 'Unknown command "no.such"' },
    });
    expect(bus.entries).toEqual([]);
  });

  it('rejects invalid args before run, with issues that never echo the value', () => {
    const bus = createBus();
    bus.exec('list.push', { value: 1 });
    const before = bus.state;
    const result = bus.exec('list.push', { value: 'secret-value' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-args');
    expect(result.error.message).toBe('Invalid arguments for "list.push"');
    expect(result.error.kind === 'invalid-args' && result.error.issues[0].path).toBe('value');
    expect(JSON.stringify(result.error)).not.toContain('secret-value');
    expect(bus.state).toBe(before);
    expect(bus.entries).toHaveLength(1);
    expect(bus.canRedo).toBe(false);
    expect(bus.exec('list.push', { value: 1, extra: true }).ok).toBe(false);
    expect(bus.exec('list.push', null).ok).toBe(false);
  });

  it('refuses parsed args that cannot be logged', () => {
    const bus = createBus();
    const result = bus.exec('test.notJson', {});
    expect(result.ok === false && result.error.kind).toBe('invalid-args');
    expect(result.ok === false && result.error.message).toBe(
      `Arguments for "test.notJson" can't be logged (they must form a JSON object)`,
    );
    expect(bus.entries).toEqual([]);
  });

  it('reports a refusal from run and changes nothing', () => {
    const bus = createBus();
    expect(bus.exec('list.pop')).toEqual({
      ok: false,
      error: { kind: 'rejected', id: 'list.pop', code: 'empty', message: 'The list is empty' },
    });
    expect(bus.state).toBe(initial);
    expect(bus.entries).toEqual([]);
  });

  it('turns a throwing run or change into an error and changes nothing', () => {
    const bus = createBus();
    bus.exec('list.push', { value: 1 });
    bus.exec('edit.undo');
    const before = bus.state;
    expect(bus.exec('test.throws')).toEqual({
      ok: false,
      error: { kind: 'threw', id: 'test.throws', message: 'boom' },
    });
    expect(bus.exec('test.throwsInApply')).toEqual({
      ok: false,
      error: { kind: 'threw', id: 'test.throwsInApply', message: 'not an Error' },
    });
    expect(bus.state).toBe(before);
    expect(bus.canRedo).toBe(true); // a failed mutation doesn't clear redo
    expect(bus.entries).toHaveLength(2);
  });

  it('guards a history move with an empty stack', () => {
    const bus = createBus();
    expect(bus.exec('test.rogueUndo')).toEqual({
      ok: false,
      error: { kind: 'threw', id: 'test.rogueUndo', message: 'Nothing to undo' },
    });
  });
});

describe('undo and redo', () => {
  it('undoes and redoes through the edit commands, which are logged', () => {
    const bus = createBus();
    bus.exec('list.push', { value: 1 });
    bus.exec('list.push', { value: 2 });
    expect(bus.contextKeys()).toEqual({ 'history.canUndo': true, 'history.canRedo': false });
    expect(bus.exec('edit.undo').ok).toBe(true);
    expect(bus.state.items).toEqual([1]);
    expect(bus.contextKeys()).toEqual({ 'history.canUndo': true, 'history.canRedo': true });
    expect(bus.exec('edit.redo').ok).toBe(true);
    expect(bus.state.items).toEqual([1, 2]);
    expect(bus.entries.map((e) => e.id)).toEqual(['list.push', 'list.push', 'edit.undo', 'edit.redo']);
  });

  it('fails (and logs nothing) when there is nothing to undo or redo', () => {
    const bus = createBus();
    expect(bus.exec('edit.undo')).toEqual({
      ok: false,
      error: { kind: 'rejected', id: 'edit.undo', code: 'nothing-to-undo', message: 'Nothing to undo' },
    });
    expect(bus.exec('edit.redo')).toEqual({
      ok: false,
      error: { kind: 'rejected', id: 'edit.redo', code: 'nothing-to-redo', message: 'Nothing to redo' },
    });
    expect(bus.entries).toEqual([]);
  });

  it('clears redo on a new mutation, but not on a view command', () => {
    const bus = createBus();
    bus.exec('list.push', { value: 1 });
    bus.exec('edit.undo');
    bus.exec('view.resetLayout');
    expect(bus.canRedo).toBe(true);
    bus.exec('list.push', { value: 2 });
    expect(bus.canRedo).toBe(false);
    expect(bus.state.items).toEqual([2]);
  });

  it('keeps the state object for view commands and logs them', () => {
    const bus = createBus();
    bus.exec('list.push', { value: 1 });
    const before = bus.state;
    expect(bus.exec('view.resetLayout')).toEqual({
      ok: true,
      logged: true,
      command: { id: 'view.resetLayout', tick: 0, args: {} },
      entry: { seq: 1, tick: 0, id: 'view.resetLayout', args: {} },
    });
    expect(bus.state).toBe(before);
    expect(bus.canUndo).toBe(true);
  });

  it('clears both stacks after a non-undoable change', () => {
    const bus = createBus();
    bus.exec('list.push', { value: 1 });
    bus.exec('list.push', { value: 2 });
    bus.exec('edit.undo');
    bus.exec('sim.advance');
    expect(bus.state).toEqual({ tick: 1, assisted: false, items: [1] });
    expect(bus.canUndo).toBe(false);
    expect(bus.canRedo).toBe(false);
    bus.exec('list.push', { value: 3 });
    expect(bus.entries.at(-1)?.tick).toBe(1);
  });

  it('marks cheats assisted outside the change, so undo keeps the mark', () => {
    const bus = createBus();
    bus.exec('cheat.fill');
    expect(bus.state).toEqual({ tick: 0, assisted: true, items: [99] });
    bus.exec('edit.undo');
    expect(bus.state).toEqual({ tick: 0, assisted: true, items: [] });
  });

  it('runs cheats without a markAssisted hook', () => {
    const bus = new CommandBus<Toy>({
      registry: new CommandRegistry<Toy>().register(cheat),
      initialState: initial,
      tickOf: (s) => s.tick,
    });
    bus.exec('cheat.fill');
    expect(bus.state.assisted).toBe(false);
  });
});

type Op =
  | { kind: 'push'; value: number }
  | { kind: 'pop' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'view' }
  | { kind: 'bad' };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('push' as const), value: fc.integer({ min: -5, max: 5 }) }),
  fc.constant({ kind: 'pop' as const }),
  fc.constant({ kind: 'undo' as const }),
  fc.constant({ kind: 'redo' as const }),
  fc.constant({ kind: 'view' as const }),
  fc.constant({ kind: 'bad' as const }),
);

function run(bus: CommandBus<Toy>, op: Op): void {
  switch (op.kind) {
    case 'push':
      bus.exec('list.push', { value: op.value });
      break;
    case 'pop':
      bus.exec('list.pop');
      break;
    case 'undo':
      bus.exec('edit.undo');
      break;
    case 'redo':
      bus.exec('edit.redo');
      break;
    case 'view':
      bus.exec('view.resetLayout');
      break;
    case 'bad':
      bus.exec('list.push', { value: 0.5 });
      break;
  }
}

describe('properties (toy state)', () => {
  it('undoing everything returns the initial state, for any command sequence', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), (ops) => {
        const bus = createBus();
        ops.forEach((op) => run(bus, op));
        while (bus.exec('edit.undo').ok);
        expect(bus.state).toEqual(initial);
      }),
    );
  });

  it('replaying the log from the initial state reaches the live state and the same log', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), (ops) => {
        const live = createBus();
        ops.forEach((op) => run(live, op));
        const replayed = createBus();
        expect(replayEntries(replayed, live.entries)).toEqual({ ok: true });
        expect(replayed.state).toEqual(live.state);
        expect(replayed.entries).toEqual(live.entries);
        expect(replayed.canUndo).toBe(live.canUndo);
        expect(replayed.canRedo).toBe(live.canRedo);
      }),
    );
  });

  it('only successful commands are logged, with gap-free seq', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), (ops) => {
        const bus = createBus();
        let successes = 0;
        for (const op of ops) {
          const before = bus.entries.length;
          run(bus, op);
          successes += bus.entries.length - before;
        }
        expect(bus.entries.length).toBe(successes);
        bus.entries.forEach((entry, index) => expect(entry.seq).toBe(index));
      }),
    );
  });
});

describe('replayEntries', () => {
  function liveLog() {
    const bus = createBus();
    bus.exec('list.push', { value: 1 });
    bus.exec('list.pop');
    bus.exec('edit.undo');
    return bus.entries;
  }

  it('rejects entries out of order', () => {
    const [first, second] = liveLog();
    expect(replayEntries(createBus(), [second, first])).toEqual({
      ok: false,
      error: { kind: 'out-of-order', seq: 1, message: 'Expected seq 0, found 1' },
    });
  });

  it('rejects an entry that no longer succeeds', () => {
    const [, second] = liveLog();
    const result = replayEntries(createBus(), [{ ...second, seq: 0 }]);
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'failed', seq: 0, message: 'Entry 0 (list.pop) failed on replay: The list is empty' },
    });
  });

  it('rejects an entry logged at another tick', () => {
    const [first] = liveLog();
    expect(replayEntries(createBus(), [{ ...first, tick: 3 }])).toEqual({
      ok: false,
      error: { kind: 'tick-mismatch', seq: 0, message: 'Entry 0 was logged at tick 3 but replayed at tick 0' },
    });
  });

  it('rejects an entry whose args parse differently now', () => {
    const transformed = defineCommand<{ value: number }, Toy>({
      ...push,
      args: z.strictObject({ value: z.int() }).transform(({ value }) => ({ value: value + 1 })),
    });
    const bus = new CommandBus<Toy>({
      registry: new CommandRegistry<Toy>().register(transformed),
      initialState: initial,
      tickOf: (s) => s.tick,
    });
    expect(replayEntries(bus, [{ seq: 0, tick: 0, id: 'list.push', args: { value: 1 } }])).toEqual({
      ok: false,
      error: { kind: 'diverged', seq: 0, message: 'Entry 0 (list.push) parsed to different arguments on replay' },
    });
  });

  it('compares args structurally: key order is ignored, any other difference diverges', () => {
    // Accepts any object and always logs the same canonical args, so only the comparison varies.
    const canonical = { a: [1, { b: 2 }], c: null };
    const fixed = defineCommand<object, Toy>({
      id: 'test.fixed',
      title: 'Fixed',
      category: 'Test',
      args: z.record(z.string(), z.unknown()).transform(() => canonical),
      undoable: false,
      run: () => succeed(),
    });
    const registry = new CommandRegistry<Toy>().register(fixed);
    const replays = (args: object) =>
      replayEntries(new CommandBus<Toy>({ registry, initialState: initial, tickOf: (s) => s.tick }), [
        { seq: 0, tick: 0, id: 'test.fixed', args: args as Record<string, never> },
      ]).ok;
    expect(replays({ c: null, a: [1, { b: 2 }] })).toBe(true);
    expect(replays({ a: { 0: 1, 1: { b: 2 } }, c: null })).toBe(false); // object vs array
    expect(replays({ a: [1, { b: 2 }], c: null, d: 1 })).toBe(false); // extra key
    expect(replays({ a: [1, { b: 2 }], d: null })).toBe(false); // other key
    expect(replays({ a: [1, { b: 3 }], c: null })).toBe(false); // leaf
    expect(replays({ a: [1, null], c: null })).toBe(false); // null vs object
    expect(replays({ a: [1, { b: 2 }], c: 0 })).toBe(false); // scalar vs null
  });
});

describe('unlogged commands (logged: false)', () => {
  it('run and notify listeners, but take no seq, no log entry and no history', () => {
    const bus = createBus();
    const events: ExecutedEvent<Toy>[] = [];
    bus.subscribe((e) => events.push(e));
    bus.exec('list.push', { value: 1 });
    const result = bus.exec('test.chrome');
    expect(result).toEqual({
      ok: true,
      logged: false,
      entry: null,
      command: { id: 'test.chrome', tick: 0, args: {} },
    });
    expect(events.map((e) => [e.command.id, e.logged, e.entry?.seq ?? null])).toEqual([
      ['list.push', true, 0],
      ['test.chrome', false, null],
    ]);
    expect(events[1].state).toBe(events[1].previous);
    expect(bus.entries.map((e) => e.id)).toEqual(['list.push']);
    expect(bus.canUndo).toBe(true);
    expect(bus.exec('list.push', { value: 2 })).toMatchObject({ logged: true, entry: { seq: 1 } });
  });

  it('are refused (unlogged-change) if run returns a change or a history move, and change nothing', () => {
    const bus = createBus();
    bus.exec('list.push', { value: 1 });
    const before = bus.state;
    expect(bus.exec('test.unloggedChange')).toMatchObject({ ok: false, error: { kind: 'unlogged-change' } });
    expect(bus.exec('test.unloggedUndo')).toMatchObject({ ok: false, error: { kind: 'unlogged-change' } });
    expect(bus.state).toBe(before);
    expect(bus.entries).toHaveLength(1);
    expect(bus.canUndo).toBe(true);
    expect(bus.canRedo).toBe(false);
  });

  it('replays an older log that still records one, keeping its seq numbering', () => {
    const live = createBus();
    live.exec('list.push', { value: 1 });
    live.exec('list.push', { value: 2 });
    // As an older build would have logged it, with test.chrome taking seq 1.
    const old = [
      { ...live.entries[0] },
      { seq: 1, tick: 0, id: 'test.chrome', args: {} },
      { ...live.entries[1], seq: 2 },
    ];
    const replayed = createBus();
    expect(replayEntries(replayed, old)).toEqual({ ok: true });
    expect(replayed.state.items).toEqual([1, 2]);
    expect(replayed.entries).toEqual(old);
    expect(replayed.exec('list.push', { value: 3 })).toMatchObject({ entry: { seq: 3 } });

    expect(replayEntries(createBus(), [{ seq: 0, tick: 7, id: 'test.chrome', args: {} }])).toMatchObject({
      ok: false,
      error: { kind: 'tick-mismatch', seq: 0 },
    });
  });

  it('carryOver refuses misuse', () => {
    const bus = createBus();
    expect(() => bus.carryOver({ seq: 0, tick: 0, id: 'list.push', args: { value: 1 } })).toThrow(/not an unlogged/);
    expect(() => bus.carryOver({ seq: 0, tick: 0, id: 'nope.nope', args: {} })).toThrow(/not an unlogged/);
    expect(() => bus.carryOver({ seq: 3, tick: 0, id: 'test.chrome', args: {} })).toThrow(/Expected seq 0/);
    expect(() => bus.carryOver({ seq: 0, tick: 1, id: 'test.chrome', args: {} })).toThrow(/different tick/);
    expect(bus.entries).toEqual([]);
  });

  it('palette.open is unlogged', () => {
    expect(viewCommands<Toy>().find((c) => c.id === 'palette.open')?.logged).toBe(false);
  });
});
