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
 *
 * F1.7: `toggleMode` and `focusSelection` left this table; `V` and `F` are now bindings of the
 * `view.mode` and `view.focus` commands (`view.mode.walk`, `view.mode.work`, `view.focus.selection`).
 * Overrides players stored under `input.toggleMode` / `input.focusSelection` are unknown binding
 * ids now, which the keymap ignores (and leaves in the file). `commitPlacement` and `moveSelection`
 * are gestures, like a click: the workspace turns their commit into `entity.place` / `entity.move`.
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
  def('clearSelection', 'Cancel placement, or clear the selection', false, ['Escape']),
  def('commitPlacement', 'Place or drop at the reticle', false, ['Enter', 'NumpadEnter']),
  def('moveSelection', 'Pick up the selection to move it', false, ['M']),
];
