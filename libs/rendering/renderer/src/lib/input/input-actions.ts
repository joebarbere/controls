import { INPUT_ACTIONS, keyNameToCode } from '@controls/commands';

/**
 * Rebindable **input actions** for continuous and viewport-local input. These are not Commands:
 * per-frame movement must never enter the replay log (plan F1.4, ADR 0006). Bindings use
 * `KeyboardEvent.code`, so WASD stays physical on AZERTY and Dvorak.
 *
 * The actions, their titles and default keys are data in `@controls/commands` (`INPUT_ACTIONS`),
 * shared with the keybinding service and the rebinding UI; this module implements them. The
 * player's overrides arrive through `ViewportRenderer.setBindings` (from `KeybindingService`).
 * TODO(F1.7): `toggleMode` and `focusSelection` become the `view.mode` / `view.focus` Commands.
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

const ACTIONS: readonly InputAction[] = [...HELD_ACTIONS, ...TRIGGERED_ACTIONS];

/**
 * Complete bindings from an action → codes record (as `Keymap.inputCodes()` returns): actions the
 * record leaves out get no keys, and names this renderer doesn't implement are ignored.
 */
export function inputBindingsFrom(codes: Readonly<Record<string, readonly string[]>>): InputBindings {
  const out = {} as Record<InputAction, readonly string[]>;
  for (const action of ACTIONS)
    out[action] = Object.prototype.hasOwnProperty.call(codes, action) ? [...codes[action]] : [];
  return out;
}

/** The default keys from the shared `INPUT_ACTIONS` table, as codes. */
export const DEFAULT_INPUT_BINDINGS: InputBindings = inputBindingsFrom(
  Object.fromEntries(INPUT_ACTIONS.map((a) => [a.action, a.keys.map(keyNameToCode)])),
);

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
