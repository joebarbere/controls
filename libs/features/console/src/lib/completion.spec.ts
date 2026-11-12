import { CommandRegistry, defineCommand, succeed } from '@controls/commands';
import { createWorldRegistry } from '@controls/world-model';
import * as z from 'zod';
import { commonPrefix, completeConsoleInput, consoleIds, TabCompleter } from './completion';

const registry = createWorldRegistry();
const at = (text: string) => completeConsoleInput(registry, text, text.length);

/** A registry with an enum and a boolean arg, to complete values. */
const modes = new CommandRegistry<number>().register(
  defineCommand({
    id: 'view.mode',
    title: 'Mode',
    category: 'View',
    args: z.strictObject({ mode: z.enum(['walk', 'work', 'editor']), smooth: z.boolean().optional() }),
    undoable: false,
    run: () => succeed<number>(),
  }),
);

describe('completeConsoleInput', () => {
  it('completes command ids, console verbs and queries from the registry', () => {
    expect(consoleIds(registry)).toEqual(
      expect.arrayContaining(['entity.place', 'help', 'run', 'clear', 'world.hash']),
    );
    expect(at('ent')?.candidates).toEqual([
      'entity.delete',
      'entity.label',
      'entity.move',
      'entity.place',
      'entity.rotate',
    ]);
    expect(at('')?.candidates.length).toBe(consoleIds(registry).length);
    expect(at('world.')).toMatchObject({ from: 0, to: 6, prefix: 'world.', candidates: ['world.hash'] });
    expect(at('netl')?.candidates).toEqual(['netlist.dump']);
    expect(at('wire.i')?.candidates).toEqual(['wire.info']);
    expect(at('wire.info --')?.candidates).toEqual(['--id']); // a query's flags, from CONSOLE_QUERY_ARGS
    expect(at('wire.info --id 2 --')).toBeNull();
    expect(at('netlist.dump --')).toBeNull();
    expect(at('  he')).toMatchObject({ from: 2, candidates: ['help'] });
    expect(at('help ent')?.candidates).toContain('entity.move');
  });

  it('completes flag names from the args shape, leaving out flags already given', () => {
    expect(at('entity.place --ref')?.candidates).toEqual(['--ref.id', '--ref.version']);
    expect(at('entity.place --ref.id prop.crate --')?.candidates).toEqual([
      // World v3 (ADR 0015): a nullable object is a literal (`--mountedOn null`) or dotted flags.
      '--mountedOn',
      '--mountedOn.entity',
      '--mountedOn.mount',
      '--orientationMdeg.pitch',
      '--orientationMdeg.roll',
      '--orientationMdeg.yaw',
      '--positionMm.x',
      '--positionMm.y',
      '--positionMm.z',
      '--ref.version',
    ]);
    expect(at('entity.delete -')?.candidates).toEqual(['--id']);
  });

  it('completes enum and boolean values, as flags or positionals', () => {
    const value = (text: string) => completeConsoleInput(modes, text, text.length)?.candidates;
    expect(value('view.mode --mode w')).toEqual(['walk', 'work']);
    expect(value('view.mode ')).toEqual(['editor', 'walk', 'work']); // positional #1 is `mode`
    expect(value('view.mode walk ')).toEqual(['false', 'true']); // positional #2 is `smooth`
    expect(value('view.mode --smooth ')).toEqual(['false', 'true']);
    expect(value('view.mode --mode walk w')).toBeUndefined(); // positionals can't follow flags
  });

  it('offers nothing for free text, unknown ids, quotes, comments and console words', () => {
    expect(at('entity.place --ref.id pr')).toBeNull(); // a string value
    expect(at('nope.cmd --')).toBeNull();
    expect(at('entity.place --ref.id "pr')).toBeNull();
    expect(at('entity.place # --')).toBeNull();
    expect(at('world.hash ')).toBeNull();
    expect(at('help entity.place ')).toBeNull();
    expect(at('zzz')).toBeNull();
  });

  it('replaces the whole word under the cursor', () => {
    expect(completeConsoleInput(registry, 'entity.plXYZ --id 1', 9)).toMatchObject({ from: 0, to: 12 });
  });
});

describe('completing JSON-word arguments (ADR 0008 amendment)', () => {
  const wires = new CommandRegistry<number>().register(
    defineCommand({
      id: 'wire.add',
      title: 'Add wire',
      category: 'Wiring',
      args: z.strictObject({
        route: z.array(z.strictObject({ x: z.int() })),
        a: z
          .strictObject({
            entity: z.int(),
            termination: z.union([z.literal('auto'), z.strictObject({ m: z.string() })]),
          })
          .nullable(),
      }),
      undoable: true,
      run: () => succeed<number>(),
    }),
  );
  const on = (text: string) => completeConsoleInput(wires, text, text.length);

  it('offers flags inside nullable objects and unions, and their literal words and null', () => {
    expect(on('wire.add --a')?.candidates).toEqual(['--a', '--a.entity', '--a.termination', '--a.termination.m']);
    expect(on('wire.add --a ')?.candidates).toEqual(['null']);
    expect(on('wire.add --a.termination a')?.candidates).toEqual(['auto']);
    expect(on('wire.add --route ')).toBeNull(); // a JSON list is typed by hand
  });

  it('skips a JSON word with spaces in its strings, and completes nothing inside one', () => {
    expect(on('wire.add --route [{"x":1, "y":"a b"}] --a.ter')?.candidates).toEqual([
      '--a.termination',
      '--a.termination.m',
    ]);
    expect(on('wire.add --route [{"x":1, "y":"a b')).toBeNull();
    expect(on('wire.add --route [1]')).toBeNull();
  });
});

describe('TabCompleter', () => {
  it('inserts a unique candidate with a space, or extends to the common prefix', () => {
    const tab = new TabCompleter(registry);
    expect(tab.tab('entity.pl', 9)).toEqual({ text: 'entity.place ', cursor: 13, candidates: [], selected: -1 });
    expect(tab.tab('entity.place --pos', 18)).toMatchObject({ text: 'entity.place --positionMm.', cursor: 26 });
    expect(tab.tab('entity.pl --id 1', 9)).toMatchObject({ text: 'entity.place --id 1', cursor: 13 });
  });

  it('cycles through candidates when the common prefix adds nothing, until another edit', () => {
    const tab = new TabCompleter(registry);
    const first = tab.tab('entity.', 7);
    expect(first).toMatchObject({ text: 'entity.delete', selected: 0 });
    const second = tab.tab(first?.text ?? '', first?.cursor ?? 0);
    expect(second).toMatchObject({ text: 'entity.label', selected: 1 });
    const third = tab.tab(second?.text ?? '', second?.cursor ?? 0);
    expect(third).toMatchObject({ text: 'entity.move' });
    expect(tab.tab('entity.', 7)).toMatchObject({ text: 'entity.delete', selected: 0 }); // edited: fresh
    tab.reset();
    expect(tab.tab('nothing.here --', 15)).toBeNull();
  });

  it('commonPrefix', () => {
    expect(commonPrefix(['abc', 'abd', 'ab'])).toBe('ab');
    expect(commonPrefix([])).toBe('');
  });
});
