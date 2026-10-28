import { z } from 'zod';
import type { AnyCommandDef, CommandDef } from './command';
import { defineViewCommand } from './builtin';
import { VIEWPORT_FOCUSED_KEY } from './keybindings/input-actions';
import type { BindingDecl } from './keybindings/keymap';

/*
 * The viewport's view commands (plan F1.7, ADR 0006 "View commands versus world commands"): switching
 * walk/work mode and focusing a work-mode target. Logged, never a world change; the workspace applies
 * them through `Session.onCommand`. Their ids and argument shapes are save format (ADR 0007).
 *
 * They replace the F1.4 input actions `toggleMode` and `focusSelection`. One chord can't carry the
 * "other" mode or the selected target, so the keys are bindings with `when`s and context arguments:
 * `V` is two bindings on disjoint `mode` values, and `F` takes `target` from the `selection.id` key.
 */

/** Context key: the viewport's mode, `'walk'` or `'work'` (absent until the viewport starts). */
export const MODE_KEY = 'mode';
/** Context key: the selected selectable's id (`backplate`, `din-rail-1`, `entity-3`), absent if none. */
export const SELECTION_ID_KEY = 'selection.id';
/** Context key: the selected selectable's kind (`backplate`, `din-rail`, `prop`, …). */
export const SELECTION_KIND_KEY = 'selection.kind';
// The selected world entity's id is `SELECTION_ENTITY_ID_KEY` (`selection.entityId`, `arg-hints.ts`, F1.3).
/** Context key: `true` when the selection can be focused in work mode. */
export const SELECTION_FOCUSABLE_KEY = 'selection.focusable';

export const ViewModeName = z.enum(['walk', 'work']);
export type ViewModeName = z.infer<typeof ViewModeName>;

/** `view.mode {mode}`: strict, so `view.mode walk` is the only shape a log can hold. */
export const ViewModeArgs = z.strictObject({ mode: ViewModeName });
export type ViewModeArgs = z.infer<typeof ViewModeArgs>;

/**
 * A view target id: lower-case words joined by single hyphens, at most 64 characters
 * (`backplate`, `din-rail-1`, and from F1.9 walls and benches).
 */
export const ViewTargetId = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'a view target id: lower-case words joined by hyphens');

/** `view.focus {target}`: the selectable id to focus. */
export const ViewFocusArgs = z.strictObject({ target: ViewTargetId });
export type ViewFocusArgs = z.infer<typeof ViewFocusArgs>;

/** Binding ids of the view keys (settings `controls.keybindings` keys; stable, like command ids). */
export const VIEW_MODE_WALK_BINDING = 'view.mode.walk';
export const VIEW_MODE_WORK_BINDING = 'view.mode.work';
export const VIEW_FOCUS_SELECTION_BINDING = 'view.focus.selection';

const viewportAnd = (when: string): string => `${VIEWPORT_FOCUSED_KEY} && ${when}`;

/**
 * `view.mode --mode walk|work`: switches the viewport between walking (WASD and mouse look) and
 * working at a focused surface (orbit and pan). `V` toggles: it is two bindings with disjoint `when`s.
 */
export function viewModeCommand<S>(): CommandDef<ViewModeArgs, S> {
  return defineViewCommand<ViewModeArgs, S>({
    id: 'view.mode',
    title: 'Switch walk or work mode',
    category: 'View',
    args: ViewModeArgs,
    bindings: [
      {
        id: VIEW_MODE_WALK_BINDING,
        title: 'Walk mode (toggle)',
        category: 'View',
        target: { kind: 'command', command: 'view.mode', args: { mode: 'walk' } },
        defaults: ['V'],
        when: viewportAnd(`${MODE_KEY} == 'work'`),
      },
      {
        id: VIEW_MODE_WORK_BINDING,
        title: 'Work mode (toggle)',
        category: 'View',
        target: { kind: 'command', command: 'view.mode', args: { mode: 'work' } },
        defaults: ['V'],
        when: viewportAnd(`${MODE_KEY} == 'walk'`),
      },
    ],
  });
}

/**
 * `view.focus --target <id>`: frames a work-mode target (the backplate, a rail; walls and benches in
 * F1.9) and limits orbit and pan around it, switching to work mode if needed. An id the viewport
 * can't focus is ignored (a view command can't see the scene). `F` focuses the selection.
 */
export function viewFocusCommand<S>(): CommandDef<ViewFocusArgs, S> {
  return defineViewCommand<ViewFocusArgs, S>({
    id: 'view.focus',
    title: 'Focus a work target',
    category: 'View',
    args: ViewFocusArgs,
    bindings: [
      {
        id: VIEW_FOCUS_SELECTION_BINDING,
        title: 'Focus the selection',
        category: 'View',
        target: { kind: 'command', command: 'view.focus', args: {}, contextArgs: { target: SELECTION_ID_KEY } },
        defaults: ['F'],
        when: viewportAnd(SELECTION_FOCUSABLE_KEY),
      },
    ],
  });
}

/** `view.mode` and `view.focus`, for registering with any state type (world registries add them). */
export function viewportCommands<S>(): AnyCommandDef<S>[] {
  return [viewModeCommand<S>(), viewFocusCommand<S>()];
}

/** The extra binding declarations of a list of commands (`CommandDef.bindings`), in list order. */
export function extraBindingDecls(defs: readonly { readonly bindings?: readonly BindingDecl[] }[]): BindingDecl[] {
  return defs.flatMap((d) => d.bindings ?? []);
}
