import { CommandRegistry } from './registry';
import { defaultBindingDecls } from './keybindings/defaults';
import { Keymap } from './keybindings/keymap';
import { viewportCommands } from './view';
import { WiringLabelArgs, WiringPullArgs, wiringCommands } from './wiring';

/*
 * The cable prompts' keys (F3.2 part 4): unlogged view commands that open a prompt or a picking mode;
 * their keys hold only with the viewport focused and a wire (or cable) selected.
 */
describe('wiring.* (F3.2 part 4)', () => {
  const registry = new CommandRegistry<{ n: number }>().registerAll(viewportCommands());
  const keymap = Keymap.create(defaultBindingDecls(registry), {}, 'other');
  const focused = { 'viewport.focused': true };

  it('are unlogged view commands, registered with the viewport commands', () => {
    expect(wiringCommands().map((d) => d.id)).toStrictEqual([
      'wiring.strip',
      'wiring.land',
      'wiring.label',
      'wiring.pull',
    ]);
    for (const def of wiringCommands()) {
      expect(def.logged).toBe(false);
      expect(def.undoable).toBe(false);
      expect(registry.has(def.id)).toBe(true);
    }
  });

  it('J strips the strip target, L lands the selected conductor, Shift+L labels the selected wire or cable', () => {
    expect(keymap.resolve('J', { ...focused, 'wiring.stripTarget': 2 })).toMatchObject({
      id: 'wiring.strip.selection',
    });
    expect(keymap.resolve('J', { 'wiring.stripTarget': 2 })).toBeNull();
    expect(keymap.resolve('L', { ...focused, 'selection.connectionId': 4 })).toMatchObject({
      id: 'wiring.land.selection',
    });
    expect(keymap.resolve('L', focused)).toBeNull();
    expect(keymap.resolve('Shift+L', { ...focused, 'selection.cableId': 1 })?.id).toBe('wiring.label.selection');
    expect(keymap.resolve('Shift+L', { ...focused, 'selection.connectionId': 1 })?.id).toBe('wiring.label.selection');
    expect(keymap.resolve('Shift+L', focused)).toBeNull();
    expect(keymap.conflicts).toStrictEqual([]);
  });

  it('U opens the fish tape prompt on the pull target (F3.4 part 2)', () => {
    expect(keymap.resolve('U', { ...focused, 'wiring.pullTarget': 3 })).toMatchObject({
      id: 'wiring.pull.selection',
    });
    expect(keymap.resolve('U', { 'wiring.pullTarget': 3 })).toBeNull();
    expect(keymap.resolve('U', focused)).toBeNull();
    expect(WiringPullArgs.safeParse({ conduit: 3 }).success).toBe(true);
    expect(WiringPullArgs.safeParse({}).success).toBe(false);
  });

  it('label arguments default to the selection (both null)', () => {
    expect(WiringLabelArgs.parse({})).toStrictEqual({ wire: null, cable: null });
    expect(WiringLabelArgs.safeParse({ wire: 0 }).success).toBe(false);
  });
});
