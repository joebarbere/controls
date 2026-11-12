import { defineCommand, NoArgs, succeed } from '@controls/commands';
import { createWorldRegistry, type World } from '@controls/world-model';
import * as z from 'zod';
import { isConsoleAvailable } from './availability';
import { consoleHelp } from './help';
import { isConsoleWord, resolveConsoleLine } from './interpret';

const registry = createWorldRegistry().register(
  defineCommand<NoArgs, World>({
    id: 'cheat.money',
    title: 'Free money',
    category: 'Cheats',
    args: NoArgs,
    undoable: false,
    cheat: true,
    run: () => succeed<World>(),
  }),
);
const resolve = (line: string) => resolveConsoleLine(registry, line);

describe('resolveConsoleLine', () => {
  it('maps commands through the shared parser and args mapping, flagging cheats', () => {
    expect(resolve('entity.delete 3')).toEqual({ kind: 'command', id: 'entity.delete', args: { id: 3 }, cheat: false });
    expect(resolve('cheat.money')).toEqual({ kind: 'command', id: 'cheat.money', args: {}, cheat: true });
    expect(resolve('   # just a comment')).toEqual({ kind: 'blank' });
  });

  it('maps JSON words, nullable objects and console shorthand through the shared mapping', () => {
    const wires = createWorldRegistry().register(
      defineCommand({
        id: 'test.add',
        title: 'Add wire',
        category: 'Wiring',
        args: z.strictObject({
          route: z.array(z.strictObject({ x: z.int() })),
          a: z.strictObject({ entity: z.int() }).nullable(),
        }),
        undoable: true,
        run: () => succeed<World>(),
      }),
    );
    expect(resolveConsoleLine(wires, 'test.add --route [{"x":1}] --a null')).toEqual({
      kind: 'command',
      id: 'test.add',
      args: { route: [{ x: 1 }], a: null },
      cheat: false,
    });
    expect(resolveConsoleLine(wires, 'test.add --route auto')).toMatchObject({ kind: 'error', column: 10 });
    const shorthand = (id: string, path: string) => id === 'test.add' && path === 'route';
    expect(resolveConsoleLine(wires, 'test.add --route auto', shorthand)).toMatchObject({
      kind: 'command',
      args: { route: 'auto' },
    });
    const help = consoleHelp(wires, 'test.add');
    expect(help.ok && help.lines).toEqual(expect.arrayContaining(['Usage: test.add <route> <a> --a.entity <number>']));
    expect(help.ok && help.lines.join('\n')).toMatch(/--route\s+JSON; required; or positional #1/);
    expect(help.ok && help.lines.join('\n')).toMatch(/--a\s+JSON\|null; required; or positional #2/);
  });

  it('reports grammar and mapping errors at their column', () => {
    expect(resolve('entity.place --idd 1')).toEqual({ kind: 'error', message: 'Unknown argument --idd', column: 14 });
    expect(resolve('entity.delete "3')).toMatchObject({ kind: 'error', column: 15 });
    expect(resolve('nope.cmd')).toEqual({ kind: 'error', message: 'Unknown command "nope.cmd"', column: 1 });
    expect(resolve('--x')).toMatchObject({ kind: 'error', column: 1 });
  });

  it('handles the console words before the registry', () => {
    expect(resolve('help')).toEqual({ kind: 'help', id: null });
    expect(resolve('help entity.place')).toEqual({ kind: 'help', id: 'entity.place' });
    expect(resolve('run')).toEqual({ kind: 'run' });
    expect(resolve('clear')).toEqual({ kind: 'clear' });
    expect(resolve('world.hash')).toEqual({ kind: 'query', id: 'world.hash', args: {} });
    expect(resolve('netlist.dump')).toEqual({ kind: 'query', id: 'netlist.dump', args: {} });
    expect(isConsoleWord(registry, 'netlist.dump')).toBe(true);
    expect(isConsoleWord(registry, 'help')).toBe(true);
    expect(isConsoleWord(registry, 'entity.place')).toBe(false);
  });

  it('refuses arguments the console words do not take', () => {
    expect(resolve('help a b')).toMatchObject({ kind: 'error', column: 8 });
    expect(resolve('help --all')).toMatchObject({ kind: 'error', message: 'help takes no flags', column: 6 });
    expect(resolve('clear now')).toMatchObject({ kind: 'error', message: 'clear takes no arguments', column: 7 });
    expect(resolve('world.hash 1')).toMatchObject({ kind: 'error', column: 12 });
    expect(resolve('netlist.dump --all')).toMatchObject({ kind: 'error', message: 'netlist.dump takes no arguments' });
    expect(resolve('run scenario.console')).toMatchObject({ kind: 'error', column: 5 });
    expect((resolve('run x') as { message: string }).message).toBe(
      "run takes no path: the game can't read files by path. Type run on its own to pick a file, or drop one on the console",
    );
  });
});

describe('wire.info (F3.6 part 3)', () => {
  it('parses an id positionally or by flag, and refuses a missing, non-numeric or zero id at its column', () => {
    expect(resolve('wire.info 2')).toEqual({ kind: 'query', id: 'wire.info', args: { id: 2 } });
    expect(resolve('wire.info --id 2')).toEqual({ kind: 'query', id: 'wire.info', args: { id: 2 } });
    expect(isConsoleWord(registry, 'wire.info')).toBe(true);
    expect(resolve('wire.info')).toMatchObject({ kind: 'error', message: expect.stringMatching(/^wire\.info: id: /) });
    expect(resolve('wire.info x')).toMatchObject({ kind: 'error', column: 11 });
    expect(resolve('wire.info 0')).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/^wire\.info: id: /),
    });
  });

  it('help wire.info gives its usage and argument from CONSOLE_QUERY_ARGS', () => {
    const help = consoleHelp(registry, 'wire.info');
    expect(help.ok && help.lines[0]).toMatch(/^wire\.info: Print a wire’s or lead’s current/);
    expect(help.ok && help.lines).toContain('Usage: wire.info <id>');
    expect(help.ok && help.lines.join('\n')).toMatch(/--id\s+number >= 1; required; or positional #1/);
    // A query without arguments still says so, from its schema.
    expect(consoleHelp(registry, 'netlist.dump')).toMatchObject({
      ok: true,
      lines: expect.arrayContaining(['Arguments: none']),
    });
  });
});

describe('consoleHelp', () => {
  const chords = (id: string) => (id === 'edit.undo' ? ['Ctrl+Z'] : []);

  it('lists every registered command and the console words', () => {
    const help = consoleHelp(registry, null, chords);
    if (!help.ok) throw new Error(help.message);
    const text = help.lines.join('\n');
    for (const def of registry.list()) expect(text).toContain(def.id);
    expect(text).toMatch(/edit\.undo\s+Undo {2}\[Ctrl\+Z]/);
    expect(text).toMatch(/cheat\.money\s+Free money {2}\[cheat]/);
    expect(text).toMatch(/world\.hash\s+Print the current world hash/);
    expect(text).toMatch(/netlist\.dump\s+Print the netlist and each island’s solve status/);
  });

  it('documents one command from its args schema', () => {
    const help = consoleHelp(registry, 'entity.move', chords);
    if (!help.ok) throw new Error(help.message);
    expect(help.lines).toEqual(
      expect.arrayContaining([
        'entity.move: Move object (Entity)',
        'Usage: entity.move <id> --positionMm.x <-10000000..10000000> --positionMm.y <-10000000..10000000> --positionMm.z <-10000000..10000000>',
        'Keys: none',
        'Undoable: yes',
      ]),
    );
    expect(help.lines.join('\n')).toMatch(/--id\s+number >= 1; required; or positional #1/);
    const place = consoleHelp(registry, 'entity.place');
    expect(place.ok && place.lines.join('\n')).toContain('[--orientationMdeg.yaw <');
    const undo = consoleHelp(registry, 'edit.undo', chords);
    expect(undo.ok && undo.lines).toEqual(
      expect.arrayContaining(['Arguments: none', 'Keys: Ctrl+Z', 'When: history.canUndo']),
    );
    const cheat = consoleHelp(registry, 'cheat.money');
    expect(cheat.ok && cheat.lines.join('\n')).toContain('marks the save as assisted');
  });

  it('documents console words and refuses unknown ids', () => {
    expect(consoleHelp(registry, 'run')).toEqual({ ok: true, lines: expect.arrayContaining(['Usage: run']) });
    expect(consoleHelp(registry, 'nope')).toEqual({
      ok: false,
      message: 'Unknown command "nope" (help lists them all)',
    });
    expect(consoleHelp(registry, 'toString').ok).toBe(false);
  });
});

describe('isConsoleAvailable', () => {
  it('is on in Sandbox and in dev builds, only while the workspace shows', () => {
    expect(isConsoleAvailable({ inWorkspace: true, sessionKind: 'sandbox', devBuild: false })).toBe(true);
    expect(isConsoleAvailable({ inWorkspace: true, sessionKind: 'career', devBuild: false })).toBe(false);
    expect(isConsoleAvailable({ inWorkspace: true, sessionKind: 'career', devBuild: true })).toBe(true);
    expect(isConsoleAvailable({ inWorkspace: false, sessionKind: 'sandbox', devBuild: true })).toBe(false);
    expect(isConsoleAvailable({ inWorkspace: true, sessionKind: null, devBuild: false })).toBe(false);
  });
});
