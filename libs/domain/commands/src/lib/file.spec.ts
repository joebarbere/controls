import { CommandBus } from './bus';
import { fileCommands, SESSION_ACTIVE_KEY } from './file';
import { CommandRegistry } from './registry';

describe('file commands (F1.8b part 3)', () => {
  const registry = new CommandRegistry<{ n: number }>().registerAll(fileCommands());

  it('are file.save, file.saveAs, file.open and file.load, with default keys', () => {
    expect(fileCommands().map((c) => [c.id, c.keybinding, c.when ?? null])).toEqual([
      ['file.save', 'Mod+S', SESSION_ACTIVE_KEY],
      ['file.saveAs', 'Mod+Shift+S', SESSION_ACTIVE_KEY],
      ['file.open', 'Mod+O', null],
      ['file.load', 'Mod+L', null],
    ]);
    expect(registry.list().every((c) => c.logged === false && !c.undoable && !c.cheat)).toBe(true);
  });

  it('are unlogged UI commands: no log entry, no seq, no state or history change', () => {
    const bus = new CommandBus({ registry, initialState: { n: 1 }, tickOf: () => 0 });
    for (const id of ['file.save', 'file.saveAs', 'file.open', 'file.load']) {
      expect(bus.exec(id)).toMatchObject({ ok: true, logged: false, entry: null });
    }
    expect(bus.exec('file.save', { name: 'x' })).toMatchObject({ ok: false, error: { kind: 'invalid-args' } });
    expect(bus.entries).toEqual([]);
    expect(bus.state).toEqual({ n: 1 });
    expect(bus.contextKeys()).toEqual({ 'history.canUndo': false, 'history.canRedo': false });
  });

  it('offer saving only while a game is in progress', () => {
    expect(registry.isEnabled('file.save', {})).toBe(false);
    expect(registry.isEnabled('file.saveAs', { [SESSION_ACTIVE_KEY]: true })).toBe(true);
    expect(registry.isEnabled('file.open', {})).toBe(true);
    expect(registry.isEnabled('file.load', {})).toBe(true);
  });
});
