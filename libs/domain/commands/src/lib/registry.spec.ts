import { z } from 'zod';
import { CONSOLE_AVAILABLE_KEY, editCommands, NoArgs, viewCommands } from './builtin';
import { type CommandDef, succeed } from './command';
import { CommandRegistrationError, CommandRegistry } from './registry';

const command = (id: string, extra: Partial<CommandDef<object, number>> = {}): CommandDef<object, number> => ({
  id,
  title: id,
  category: 'Test',
  args: NoArgs,
  undoable: false,
  run: () => succeed<number>(),
  ...extra,
});

function registrationError(fn: () => unknown): CommandRegistrationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CommandRegistrationError) return error;
    throw error;
  }
  throw new Error('expected a CommandRegistrationError');
}

describe('CommandRegistry', () => {
  it('registers commands and lists them sorted by id, independent of registration order', () => {
    const registry = new CommandRegistry<number>().registerAll([command('zeta.last'), command('alpha.first')]);
    registry.register(command('mid.dle'));
    expect(registry.list().map((c) => c.id)).toEqual(['alpha.first', 'mid.dle', 'zeta.last']);
    expect(registry.has('mid.dle')).toBe(true);
    expect(registry.get('mid.dle')?.title).toBe('mid.dle');
    expect(registry.get('nope.nope')).toBeUndefined();
    expect(registry.has('nope.nope')).toBe(false);
  });

  it.each([
    ['help'], // a single segment can't be logged
    ['Entity.place'],
    ['entity.Place'],
    ['entity..place'],
    ['entity.place.'],
    ['entity.pla-ce'],
    ['entity.place '],
    [''],
    [`a.${'b'.repeat(127)}`],
  ])('rejects the malformed id %j (same grammar as the replay log)', (id) => {
    const error = registrationError(() => new CommandRegistry<number>().register(command(id)));
    expect(error.reason).toBe('malformed-id');
    expect(error.commandId).toBe(id);
    expect(error.name).toBe('CommandRegistrationError');
  });

  it('accepts ids at the length limit and with camelCase or digits', () => {
    const registry = new CommandRegistry<number>();
    registry
      .register(command(`a.${'b'.repeat(126)}`))
      .register(command('view.resetLayout'))
      .register(command('s1.x2'));
    expect(registry.list()).toHaveLength(3);
  });

  it('rejects a duplicate id and keeps the first definition', () => {
    const registry = new CommandRegistry<number>().register(command('entity.place', { title: 'first' }));
    const error = registrationError(() => registry.register(command('entity.place', { title: 'second' })));
    expect(error.reason).toBe('duplicate-id');
    expect(error.message).toBe('Command "entity.place" is already registered');
    expect(registry.get('entity.place')?.title).toBe('first');
  });

  it('parses when at registration and rejects a malformed one with its column', () => {
    const registry = new CommandRegistry<number>();
    const error = registrationError(() => registry.register(command('view.focus', { when: "mode == 'work' &&" })));
    expect(error.reason).toBe('malformed-when');
    expect(error.message).toBe('Command "view.focus" has a malformed when (column 18): Expression ended early');
    expect(registry.has('view.focus')).toBe(false);
  });

  it('evaluates when against context keys for surfaces; commands without when are always enabled', () => {
    const registry = new CommandRegistry<number>()
      .register(command('view.focus', { when: "mode == 'work'" }))
      .register(command('view.free'));
    expect(registry.whenOf('view.focus')).toEqual({
      type: 'equals',
      left: { type: 'key', key: 'mode' },
      right: { type: 'literal', value: 'work' },
    });
    expect(registry.whenOf('view.free')).toBeNull();
    expect(registry.whenOf('view.none')).toBeUndefined();
    expect(registry.isEnabled('view.focus', { mode: 'work' })).toBe(true);
    expect(registry.isEnabled('view.focus', { mode: 'walk' })).toBe(false);
    expect(registry.isEnabled('view.free', {})).toBe(true);
    expect(registry.isEnabled('view.none', {})).toBe(false);
  });

  it('refuses an unlogged command that is undoable or a cheat', () => {
    for (const extra of [{ undoable: true }, { cheat: true }]) {
      expect(() => new CommandRegistry<number>().register(command('ui.thing', { logged: false, ...extra }))).toThrow(
        expect.objectContaining({ reason: 'unlogged-state-change', commandId: 'ui.thing' }),
      );
    }
    expect(() => new CommandRegistry<number>().register(command('ui.thing', { logged: false }))).not.toThrow();
  });

  it('registers the built-in edit and view commands', () => {
    const registry = new CommandRegistry<number>().registerAll(editCommands<number>()).registerAll(viewCommands());
    expect(registry.list().map((c) => [c.id, c.category, c.keybinding ?? null, c.undoable])).toEqual([
      ['console.toggle', 'View', 'Backquote', false],
      ['edit.redo', 'Edit', 'Mod+Shift+Z', false],
      ['edit.undo', 'Edit', 'Mod+Z', false],
      ['palette.open', 'View', ['Mod+K', 'Mod+Shift+P'], false],
      ['toolbelt.select', 'Tool belt', null, false],
      ['view.resetLayout', 'View', null, false],
    ]);
    expect(registry.isEnabled('edit.undo', { 'history.canUndo': false })).toBe(false);
    expect(registry.isEnabled('edit.redo', { 'history.canRedo': true })).toBe(true);
    // The console toggle is gated by its context key and fires while typing (global).
    expect(registry.isEnabled('console.toggle', {})).toBe(false);
    expect(registry.isEnabled('console.toggle', { [CONSOLE_AVAILABLE_KEY]: true })).toBe(true);
    expect(registry.get('console.toggle')?.globalKeybinding).toBe(true);
  });

  it('rejects args of the wrong shape in NoArgs (strict)', () => {
    expect(NoArgs.safeParse({}).success).toBe(true);
    expect(NoArgs.safeParse({ typo: 1 }).success).toBe(false);
    expect(z.toJSONSchema(NoArgs)).toMatchObject({ type: 'object', additionalProperties: false });
  });
});
