import { CommandRegistry, defineViewCommand, editCommands, NoArgs, viewCommands } from '@controls/commands';
import { createWorldRegistry } from '@controls/world-model';
import { disabledReason, PALETTE_HIDDEN_COMMANDS, paletteItems } from './palette-items';

const ids = (items: ReturnType<typeof paletteItems>) => items.map((i) => i.def.id);

describe('paletteItems', () => {
  const registry = createWorldRegistry();
  const idle = { 'history.canUndo': false, 'history.canRedo': false };

  it('lists every command except the palette itself, enabled first, then by category and title', () => {
    const items = paletteItems(registry, idle, '', []);
    expect(ids(items)).toEqual([
      'entity.delete',
      'entity.move',
      'entity.place',
      'entity.rotate',
      'toolbelt.select',
      'view.focus', // View, by title: Focus a work target, Reset layout, Switch walk or work mode
      'view.resetLayout',
      'view.mode',
      'edit.redo',
      'edit.undo',
      'console.toggle', // disabled here: console.available is unset
    ]);
    expect(ids(items)).not.toContain('palette.open');
    expect([...PALETTE_HIDDEN_COMMANDS]).toEqual(['palette.open']);
  });

  it('keeps commands whose when is false, disabled with the reason', () => {
    const undo = paletteItems(registry, idle, 'undo', []).find((i) => i.def.id === 'edit.undo');
    expect(undo).toMatchObject({ enabled: false, reason: 'Not available now (needs history.canUndo)' });
    const enabled = paletteItems(registry, { ...idle, 'history.canUndo': true }, 'undo', []);
    expect(enabled[0]).toMatchObject({ enabled: true, reason: null });
    expect(enabled[0].def.id).toBe('edit.undo');
  });

  it('puts recents first, most recent first, when there is no query', () => {
    const items = paletteItems(registry, idle, '', ['view.resetLayout', 'entity.move', 'unknown.command']);
    expect(ids(items).slice(0, 3)).toEqual(['view.resetLayout', 'entity.move', 'entity.delete']);
    expect(items[0].recentRank).toBe(0);
    expect(items[2].recentRank).toBe(-1);
  });

  it('ranks by fuzzy score with a query, boosting recents', () => {
    expect(ids(paletteItems(registry, idle, 'place', []))[0]).toBe('entity.place');
    expect(ids(paletteItems(registry, idle, 'obj', [])).sort()).toEqual([
      'entity.delete',
      'entity.move',
      'entity.place',
      'entity.rotate',
    ]);
    expect(ids(paletteItems(registry, idle, 'obj', ['entity.rotate']))[0]).toBe('entity.rotate');
    expect(paletteItems(registry, idle, 'no such thing', [])).toEqual([]);
  });

  it('searches ids and categories', () => {
    expect(ids(paletteItems(registry, idle, 'resetLayout', []))).toEqual(['view.resetLayout']);
    expect(ids(paletteItems(registry, idle, 'tool belt', []))).toEqual(['toolbelt.select']);
  });

  it('does not depend on registration order', () => {
    const a = new CommandRegistry<unknown>().registerAll(editCommands()).registerAll(viewCommands());
    const b = new CommandRegistry<unknown>().registerAll([...viewCommands()].reverse()).registerAll(editCommands());
    expect(ids(paletteItems(a, idle, '', []))).toEqual(ids(paletteItems(b, idle, '', [])));
  });

  it('describes a command without a when as plainly unavailable', () => {
    expect(disabledReason(defineViewCommand({ id: 'a.b', title: 'A', category: 'A', args: NoArgs }))).toBe(
      'Not available',
    );
  });
});
