/**
 * Rebindable **input actions** (plan F1.4, ADR 0006 "Input actions versus commands"): continuous or
 * viewport-local input that the renderer handles itself and that never enters the replay log. They
 * are declared here, next to the commands, so the keybinding service, the rebinding UI and the
 * renderer read one table. The renderer implements each `action`; its spec checks this table
 * against what it implements.
 *
 * Their binding ids (`input.<action>`) share the settings `controls.keybindings` record with command
 * bindings. `input` is a reserved namespace: no command may use it (`createKeymap` checks).
 *
 * Mouse look is an input action on the mouse axes, not a key: its options are the settings' look
 * sensitivity and invert-Y. Releasing pointer lock is the browser's Escape and can't be rebound.
 */

/** Binding-id namespace of input actions. */
export const INPUT_ACTION_PREFIX = 'input.';

/**
 * The context key that is true while the 3D viewport has keyboard focus. Input actions listen on
 * the viewport only, so conflict detection treats each as `when: viewport.focused`; a command whose
 * `when` is `!viewport.focused` can share a key with them.
 */
export const VIEWPORT_FOCUSED_KEY = 'viewport.focused';

export interface InputActionDef {
  /** Binding id, `input.<action>`. */
  readonly id: string;
  /** The renderer's action name. */
  readonly action: string;
  readonly title: string;
  /** Held actions are sampled every frame while down; the others fire once per press. */
  readonly held: boolean;
  /** Default keys (canonical, bare, positional). The first is the primary. */
  readonly keys: readonly string[];
}

const def = (action: string, title: string, held: boolean, keys: readonly string[]): InputActionDef => ({
  id: `${INPUT_ACTION_PREFIX}${action}`,
  action,
  title,
  held,
  keys,
});

/** Every input action, in display order. */
export const INPUT_ACTIONS: readonly InputActionDef[] = [
  def('moveForward', 'Walk forward', true, ['W', 'ArrowUp']),
  def('moveBack', 'Walk back', true, ['S', 'ArrowDown']),
  def('moveLeft', 'Strafe left', true, ['A', 'ArrowLeft']),
  def('moveRight', 'Strafe right', true, ['D', 'ArrowRight']),
  def('sprint', 'Sprint (hold)', true, ['ShiftLeft', 'ShiftRight']),
  def('selectNext', 'Select next', false, ['BracketRight']),
  def('selectPrevious', 'Select previous', false, ['BracketLeft']),
  def('clearSelection', 'Clear selection', false, ['Escape']),
  def('focusSelection', 'Focus selection', false, ['F']),
  def('toggleMode', 'Toggle walk and work mode', false, ['V']),
];
