import { z } from 'zod';
import {
  editCommands,
  NoArgs,
  toolBeltBindingDecls,
  toolBeltBindingId,
  ToolBeltSelectArgs,
  viewCommands,
} from '../builtin';
import { defineCommand, succeed } from '../command';
import { CommandRegistry } from '../registry';
import { defaultBindingDecls } from './defaults';
import { INPUT_ACTIONS } from './input-actions';
import { type BindingDecl, bindingArgs, commandBindingDecls, inputActionDecls, Keymap, KeymapError } from './keymap';
import { viewportCommands } from '../view';

const command = (id: string, defaults: string[], extra: Partial<BindingDecl> = {}): BindingDecl => ({
  id,
  title: id,
  category: 'Test',
  target: { kind: 'command', command: id, args: {} },
  defaults,
  ...extra,
});
const input = (action: string, defaults: string[]): BindingDecl => ({
  id: `input.${action}`,
  title: action,
  category: 'Input',
  target: { kind: 'input', action, held: true },
  defaults,
});

describe('Keymap.create', () => {
  it('normalises default chords and starts every binding on its defaults', () => {
    const keymap = Keymap.create([command('edit.undo', ['ctrl+z', 'Mod+Z'])], {}, 'other');
    expect(keymap.get('edit.undo')).toMatchObject({ chords: ['Mod+Z'], defaults: ['Mod+Z'], source: 'default' });
    expect(keymap.bindings.map((b) => b.id)).toEqual(['edit.undo']);
    expect(keymap.get('nope')).toBeUndefined();
  });

  it('applies overrides: a chord replaces every default, null unbinds', () => {
    const keymap = Keymap.create(
      [command('a.one', ['Mod+K', 'Mod+Shift+P']), command('a.two', ['Mod+J'])],
      { 'a.one': 'Alt+K', 'a.two': null, 'gone.command': 'Mod+Q' },
      'other',
    );
    expect(keymap.get('a.one')).toMatchObject({ chords: ['Alt+K'], source: 'user' });
    expect(keymap.get('a.two')).toMatchObject({ chords: [], source: 'user' });
    expect(keymap.invalid).toEqual([]);
    expect(keymap.on('Mod+K')).toEqual([]);
  });

  it('ignores unusable overrides, keeps the defaults and reports why', () => {
    const keymap = Keymap.create(
      [
        command('a.one', ['Mod+K']),
        command('a.two', ['Mod+J']),
        command('a.three', ['Mod+L']),
        input('moveForward', ['W']),
        command('a.four', ['Mod+H']),
      ],
      {
        'a.one': 'Mod+Banana',
        'a.two': 'ShiftLeft',
        'a.three': 'Shift+Tab',
        'input.moveForward': 'Shift+W',
        'a.four': 'esc',
      },
      'other',
    );
    expect(keymap.get('a.one')).toMatchObject({ chords: ['Mod+K'], source: 'default' });
    expect(keymap.invalid.map((i) => [i.id, i.chord])).toEqual([
      ['a.one', 'Mod+Banana'],
      ['a.two', 'ShiftLeft'],
      ['a.three', 'Shift+Tab'],
      ['input.moveForward', 'Shift+W'],
      ['a.four', 'esc'],
    ]);
    expect(keymap.invalid[1].reason).toMatch(/modifier key/);
    expect(keymap.invalid[2].reason).toMatch(/reserved/);
    expect(keymap.invalid[3].reason).toMatch(/single key/);
    expect(keymap.invalid[4].reason).toMatch(/Escape is reserved/);
  });

  it('throws on malformed declarations', () => {
    const create = (decls: BindingDecl[]) => () => Keymap.create(decls, {}, 'other');
    expect(create([command('Bad Id', [])])).toThrow(KeymapError);
    expect(create([command('a.one', []), command('a.one', [])])).toThrow(/duplicate/);
    expect(create([command('input.sneaky', [])])).toThrow(/reserved/);
    expect(create([command('a.one', [], { target: { kind: 'command', command: 'input.x', args: {} } })])).toThrow(
      /reserved/,
    );
    expect(create([{ ...input('walk', []), id: 'move.walk' }])).toThrow(/namespace/);
    expect(create([command('a.one', ['Mod+Nope'])])).toThrow(/not a valid chord/);
    expect(create([input('walk', ['Shift+W'])])).toThrow(/single key/);
    expect(create([command('a.one', ['ShiftLeft'])])).toThrow(/modifier key/);
    expect(create([command('a.one', [], { when: 'a ==' })])).toThrow(/malformed when/);
  });
});

describe('conflicts', () => {
  it('reports two bindings on one chord whose contexts may overlap, in resolution order', () => {
    const keymap = Keymap.create(
      [command('b.cmd', ['Mod+K']), command('a.cmd', ['Mod+K']), command('c.cmd', ['Mod+J'])],
      {},
      'other',
    );
    expect(keymap.conflicts).toEqual([{ chord: 'Mod+K', first: 'a.cmd', second: 'b.cmd' }]);
    expect(keymap.conflictsOf('b.cmd')).toHaveLength(1);
    expect(keymap.conflictsOf('c.cmd')).toEqual([]);
  });

  it('does not report bindings whose `when`s are provably disjoint', () => {
    const keymap = Keymap.create(
      [
        command('a.walk', ['F'], { when: 'mode == "walk"' }),
        command('a.work', ['F'], { when: 'mode == "work"' }),
        command('a.any', ['G'], { when: 'mode == "walk"' }),
        command('a.other', ['G']),
      ],
      {},
      'other',
    );
    expect(keymap.conflicts).toEqual([{ chord: 'G', first: 'a.any', second: 'a.other' }]);
  });

  it('puts the player’s bindings first, then orders by id', () => {
    const keymap = Keymap.create(
      [command('a.cmd', ['Mod+K']), command('z.cmd', ['Mod+J'])],
      { 'z.cmd': 'Mod+K' },
      'other',
    );
    expect(keymap.on('Mod+K').map((b) => b.id)).toEqual(['z.cmd', 'a.cmd']);
    expect(keymap.conflicts).toEqual([{ chord: 'Mod+K', first: 'z.cmd', second: 'a.cmd' }]);
    expect(keymap.resolve('Mod+K', {})?.id).toBe('z.cmd');
  });

  it('counts input actions as active while the viewport is focused', () => {
    const decls = [
      input('moveForward', ['W']),
      command('a.cmd', ['W']),
      command('b.cmd', ['W'], { when: '!viewport.focused' }),
    ];
    const keymap = Keymap.create(decls, {}, 'other');
    expect(keymap.conflicts).toEqual([
      { chord: 'W', first: 'a.cmd', second: 'b.cmd' },
      { chord: 'W', first: 'a.cmd', second: 'input.moveForward' },
    ]);
  });

  it('the shipped defaults have no conflicts', () => {
    const registry = new CommandRegistry<unknown>().registerAll(editCommands()).registerAll(viewCommands());
    for (const platform of ['mac', 'other'] as const) {
      const keymap = Keymap.create(defaultBindingDecls(registry), {}, platform);
      expect(keymap.conflicts).toEqual([]);
      expect(keymap.invalid).toEqual([]);
    }
  });
});

describe('resolve', () => {
  const decls = [
    command('edit.undo', ['Mod+Z'], { when: 'history.canUndo' }),
    command('palette.open', ['Mod+K'], { global: true }),
    command('a.walk', ['F'], { when: 'mode == "walk"' }),
    command('a.work', ['F'], { when: 'mode == "work"' }),
    input('moveForward', ['W']),
    command('a.w', ['W']),
  ];
  const keymap = Keymap.create(decls, {}, 'other');

  it('returns the first enabled command binding on the chord', () => {
    expect(keymap.resolve('Mod+Z', { 'history.canUndo': true })?.id).toBe('edit.undo');
    expect(keymap.resolve('Mod+Z', { 'history.canUndo': false })).toBeNull();
    expect(keymap.resolve('F', { mode: 'work' })?.id).toBe('a.work');
    expect(keymap.resolve('F', { mode: 'walk' })?.id).toBe('a.walk');
    expect(keymap.resolve('F', {})).toBeNull();
    expect(keymap.resolve('Mod+Q', {})).toBeNull();
  });

  it('never returns an input action', () => {
    expect(keymap.resolve('W', { 'viewport.focused': true })?.id).toBe('a.w');
  });

  it('runs only global bindings while typing or in a dialog', () => {
    expect(keymap.resolve('Mod+Z', { 'history.canUndo': true }, { restricted: true })).toBeNull();
    expect(keymap.resolve('Mod+K', {}, { restricted: true })?.id).toBe('palette.open');
  });
});

describe('inputCodes', () => {
  it('gives the renderer KeyboardEvent codes per action', () => {
    const keymap = Keymap.create(inputActionDecls(), { 'input.moveForward': 'I' }, 'other');
    const codes = keymap.inputCodes();
    expect(Object.keys(codes)).toEqual(INPUT_ACTIONS.map((a) => a.action));
    expect(codes['moveForward']).toEqual(['KeyI']);
    expect(codes['moveBack']).toEqual(['KeyS', 'ArrowDown']);
    expect(codes['sprint']).toEqual(['ShiftLeft', 'ShiftRight']);
    expect(codes['selectNext']).toEqual(['BracketRight']);
  });

  it('gives a shared key to one action only, the first in resolution order', () => {
    const keymap = Keymap.create(inputActionDecls(), { 'input.moveSelection': 'W' }, 'other');
    const codes = keymap.inputCodes();
    expect(codes['moveSelection']).toEqual(['KeyW']);
    expect(codes['moveForward']).toEqual(['ArrowUp']);
    expect(keymap.conflictsOf('input.moveForward')).toEqual([
      { chord: 'W', first: 'input.moveSelection', second: 'input.moveForward' },
    ]);
  });
});

describe('declarations', () => {
  it('derives command bindings from CommandDef.keybinding, single or list, and the global flag', () => {
    const defs = [
      ...editCommands<unknown>(),
      defineCommand<NoArgs, unknown>({
        id: 'palette.open',
        title: 'Open palette',
        category: 'View',
        args: NoArgs,
        keybinding: ['Mod+K', 'Mod+Shift+P'],
        globalKeybinding: true,
        undoable: false,
        run: () => succeed(),
      }),
      defineCommand<NoArgs, unknown>({
        id: 'a.unbound',
        title: 'Unbound',
        category: 'Test',
        args: NoArgs,
        undoable: false,
        run: () => succeed(),
      }),
    ];
    expect(commandBindingDecls(defs)).toEqual([
      expect.objectContaining({ id: 'edit.undo', defaults: ['Mod+Z'], when: 'history.canUndo', global: false }),
      expect.objectContaining({ id: 'edit.redo', defaults: ['Mod+Shift+Z'] }),
      expect.objectContaining({ id: 'palette.open', defaults: ['Mod+K', 'Mod+Shift+P'], global: true }),
    ]);
  });

  it('binds keys 1-9 to toolbelt.select with that slot', () => {
    const decls = toolBeltBindingDecls();
    expect(decls.map((d) => [d.id, d.defaults])).toEqual(
      Array.from({ length: 9 }, (_, i) => [toolBeltBindingId(i + 1), [String(i + 1)]]),
    );
    for (const decl of decls) {
      expect(decl.target.kind === 'command' && ToolBeltSelectArgs.safeParse(decl.target.args).success).toBe(true);
    }
  });

  it('adds the tool-belt keys only when toolbelt.select is registered', () => {
    const registry = new CommandRegistry<unknown>().registerAll(editCommands());
    const ids = defaultBindingDecls(registry).map((d) => d.id);
    expect(ids).toContain('edit.undo');
    expect(ids).not.toContain(toolBeltBindingId(1));
    expect(ids).toContain('input.moveForward');
  });

  it('ToolBeltSelectArgs takes an integer slot 1-9 and nothing else', () => {
    expect(ToolBeltSelectArgs.parse({ slot: 9 })).toEqual({ slot: 9 });
    for (const bad of [{ slot: 0 }, { slot: 10 }, { slot: 1.5 }, {}, { slot: 1, extra: true }]) {
      expect(ToolBeltSelectArgs.safeParse(bad).success).toBe(false);
    }
    expect(z.toJSONSchema(ToolBeltSelectArgs)).toMatchObject({ required: ['slot'] });
  });
});

describe('context arguments (F1.7)', () => {
  const del: BindingDecl = {
    id: 'entity.delete.selection',
    title: 'Delete',
    category: 'Test',
    target: { kind: 'command', command: 'entity.delete', args: {}, contextArgs: { id: 'selection.entityId' } },
    defaults: ['Delete'],
  };

  it('resolves only while every context argument is set, and fills it from the context', () => {
    const keymap = Keymap.create([del], {}, 'other');
    expect(keymap.resolve('Delete', {})).toBeNull();
    expect(keymap.resolve('Delete', { 'selection.entityId': null })).toBeNull();
    const binding = keymap.resolve('Delete', { 'selection.entityId': 3 });
    expect(binding?.id).toBe('entity.delete.selection');
    expect(bindingArgs(del.target, { 'selection.entityId': 3 })).toEqual({ id: 3 });
    expect(bindingArgs(del.target, {})).toEqual({ id: null });
    expect(bindingArgs({ kind: 'input', action: 'x', held: false }, {})).toEqual({});
  });

  it('falls through to the next binding on the chord when a context argument is missing', () => {
    const fallback = command('a.fallback', ['Delete']);
    const keymap = Keymap.create([del, fallback], {}, 'other');
    expect(keymap.resolve('Delete', {})?.id).toBe('a.fallback');
  });

  it('refuses an argument that is both fixed and from the context', () => {
    const bad: BindingDecl = {
      ...del,
      target: { kind: 'command', command: 'entity.delete', args: { id: 1 }, contextArgs: { id: 'selection.entityId' } },
    };
    expect(() => Keymap.create([bad], {}, 'other')).toThrow(/both fixed and taken from the context/);
  });
});

describe('view.mode and view.focus bindings (F1.7)', () => {
  const registry = new CommandRegistry<unknown>().registerAll(viewCommands()).registerAll(viewportCommands());
  const keymap = Keymap.create(defaultBindingDecls(registry), {}, 'other');
  const focused = { 'viewport.focused': true };

  it('V toggles: one binding per mode, on disjoint whens', () => {
    expect(keymap.resolve('V', { ...focused, mode: 'work' })).toMatchObject({
      id: 'view.mode.walk',
      decl: { target: { args: { mode: 'walk' } } },
    });
    expect(keymap.resolve('V', { ...focused, mode: 'walk' })?.id).toBe('view.mode.work');
    expect(keymap.resolve('V', { mode: 'walk' })).toBeNull(); // only on the focused viewport
    expect(keymap.resolve('V', focused)).toBeNull(); // before the viewport reports a mode
    expect(keymap.conflicts).toEqual([]);
  });

  it('F focuses the selection when it is focusable', () => {
    const context = { ...focused, 'selection.id': 'din-rail-1', 'selection.focusable': true };
    const binding = keymap.resolve('F', context);
    expect(binding?.id).toBe('view.focus.selection');
    expect(binding && bindingArgs(binding.decl.target, context)).toEqual({ target: 'din-rail-1' });
    expect(keymap.resolve('F', { ...focused, 'selection.id': 'entity-1' })).toBeNull();
  });

  it('F and V are no longer input actions, and stale input.* overrides are ignored', () => {
    expect(INPUT_ACTIONS.map((a) => a.action)).not.toContain('toggleMode');
    expect(INPUT_ACTIONS.map((a) => a.action)).not.toContain('focusSelection');
    const stale = Keymap.create(
      defaultBindingDecls(registry),
      { 'input.toggleMode': 'G', 'input.focusSelection': null },
      'other',
    );
    expect(stale.invalid).toEqual([]);
    expect(stale.get('input.toggleMode')).toBeUndefined();
    expect(stale.on('G')).toEqual([]);
    expect(stale.get('view.mode.walk')?.chords).toEqual(['V']);
  });
});
