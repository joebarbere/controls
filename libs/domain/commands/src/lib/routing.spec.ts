import { CommandRegistry } from './registry';
import { defaultBindingDecls } from './keybindings/defaults';
import { Keymap } from './keybindings/keymap';
import { routingCommands } from './routing';
import { viewportCommands } from './view';

/*
 * The routing gesture's keys (F3.2 part 3): unlogged view commands, bound under `when`s that hold only
 * while the viewport has focus and a spool is armed, so Tab keeps moving focus everywhere else.
 */
describe('routing.* (F3.2 part 3)', () => {
  const registry = new CommandRegistry<{ n: number }>().registerAll(viewportCommands());
  const keymap = Keymap.create(defaultBindingDecls(registry), {}, 'other');
  const focused = { 'viewport.focused': true };

  it('are unlogged view commands, registered with the viewport commands', () => {
    for (const def of routingCommands()) {
      expect(def.logged).toBe(false);
      expect(def.undoable).toBe(false);
      expect(registry.has(def.id)).toBe(true);
    }
    expect(routingCommands().map((d) => d.id)).toStrictEqual([
      'routing.terminalNext',
      'routing.terminalPrevious',
      'routing.back',
      'routing.cancel',
    ]);
  });

  it('Tab and Shift+Tab cycle terminals only with a device in hand while routing and the viewport focused', () => {
    expect(keymap.resolve('Tab', focused)).toBeNull();
    expect(keymap.resolve('Tab', { 'routing.terminalDevice': 3 })).toBeNull();
    expect(keymap.resolve('Tab', { ...focused, 'routing.terminalDevice': 3 })?.id).toBe('routing.terminalNext');
    expect(keymap.resolve('Shift+Tab', { ...focused, 'routing.terminalDevice': 3 })?.id).toBe(
      'routing.terminalPrevious',
    );
  });

  it('Backspace steps back only once a route is started; Z zooms only to a crowded device', () => {
    expect(keymap.resolve('Backspace', { ...focused, 'routing.active': true })).toBeNull();
    expect(keymap.resolve('Backspace', { ...focused, 'routing.active': true, 'routing.started': true })?.id).toBe(
      'routing.back',
    );
    expect(keymap.resolve('Z', focused)).toBeNull();
    expect(keymap.resolve('Z', { 'routing.zoomTarget': 'entity-2' })?.id).toBe('view.focus.terminals');
    expect(keymap.resolve('Z', { 'routing.zoomTarget': 'entity-2' }, { restricted: true })).toBeNull();
  });

  it('the player may rebind them, but not to a reserved chord, and the defaults are conflict-free', () => {
    expect(keymap.conflicts).toStrictEqual([]);
    const rebound = Keymap.create(
      defaultBindingDecls(registry),
      { 'routing.terminalNext': 'BracketRight', 'routing.back': 'Tab' },
      'other',
    );
    expect(rebound.get('routing.terminalNext')?.chords).toStrictEqual(['BracketRight']);
    expect(rebound.invalid).toMatchObject([{ id: 'routing.back', reason: 'Tab is reserved' }]);
  });
});
