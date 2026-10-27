/**
 * Rebindable **input actions** for continuous and viewport-local input. These are not Commands:
 * per-frame movement must never enter the replay log (plan F1.4; formalised in ADR 0006, written
 * with F1.2). Bindings use `KeyboardEvent.code`, so WASD stays physical on AZERTY and Dvorak.
 *
 * TODO(F1.4): user overrides come from settings via the keybinding service; `toggleMode` and
 * `focusSelection` become the `view.mode` / `view.focus` Commands once the registry exists (F1.2).
 */

/** Held while the key is down (sampled every frame). */
export const HELD_ACTIONS = ['moveForward', 'moveBack', 'moveLeft', 'moveRight', 'sprint'] as const;
/** Fired once per key press. */
export const TRIGGERED_ACTIONS = [
  'selectNext',
  'selectPrevious',
  'clearSelection',
  'focusSelection',
  'toggleMode',
] as const;

export type HeldAction = (typeof HELD_ACTIONS)[number];
export type TriggeredAction = (typeof TRIGGERED_ACTIONS)[number];
export type InputAction = HeldAction | TriggeredAction;

/** Action → physical key codes. Each code maps to at most one action. */
export type InputBindings = Readonly<Record<InputAction, readonly string[]>>;

export const DEFAULT_INPUT_BINDINGS: InputBindings = {
  moveForward: ['KeyW', 'ArrowUp'],
  moveBack: ['KeyS', 'ArrowDown'],
  moveLeft: ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  selectNext: ['BracketRight'],
  selectPrevious: ['BracketLeft'],
  clearSelection: ['Escape'],
  focusSelection: ['KeyF'],
  toggleMode: ['KeyV'],
};

const ACTIONS: readonly InputAction[] = [...HELD_ACTIONS, ...TRIGGERED_ACTIONS];

export const isHeldAction = (a: InputAction): a is HeldAction => (HELD_ACTIONS as readonly string[]).includes(a);

/** Code → action lookup. Throws if two actions claim one code (bindings must be unambiguous). */
export function compileBindings(bindings: InputBindings): ReadonlyMap<string, InputAction> {
  const byCode = new Map<string, InputAction>();
  for (const action of ACTIONS) {
    for (const code of bindings[action]) {
      const existing = byCode.get(code);
      if (existing && existing !== action) throw new Error(`key ${code} is bound to both ${existing} and ${action}`);
      byCode.set(code, action);
    }
  }
  return byCode;
}

/**
 * Rebinds one action. Codes taken from other actions are removed from them (the newest binding
 * wins), and the result is returned as a new object; the input is not modified.
 */
export function rebind(bindings: InputBindings, action: InputAction, codes: readonly string[]): InputBindings {
  const taken = new Set(codes);
  const next = {} as Record<InputAction, readonly string[]>;
  for (const a of ACTIONS) next[a] = a === action ? [...new Set(codes)] : bindings[a].filter((c) => !taken.has(c));
  return next;
}

/** Walk intent from held actions: forward/strafe in −1…1 and a sprint flag. */
export interface MoveIntent {
  forward: number;
  strafe: number;
  sprint: boolean;
}

/** Fills `out` (no allocation) from the set of held actions. */
export function moveIntent(held: ReadonlySet<HeldAction>, out: MoveIntent): MoveIntent {
  out.forward = (held.has('moveForward') ? 1 : 0) - (held.has('moveBack') ? 1 : 0);
  out.strafe = (held.has('moveRight') ? 1 : 0) - (held.has('moveLeft') ? 1 : 0);
  out.sprint = held.has('sprint');
  return out;
}
