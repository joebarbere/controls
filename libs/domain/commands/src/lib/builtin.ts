import { TOOL_BELT_SLOTS } from '@controls/save-format';
import { z } from 'zod';
import { type AnyCommandDef, type CommandDef, defineCommand, fail, succeed } from './command';
import type { BindingDecl } from './keybindings/keymap';

/** Commands that take no arguments. Strict, so a typo'd flag is an error rather than ignored. */
export const NoArgs = z.strictObject({});
export type NoArgs = z.infer<typeof NoArgs>;

/**
 * `edit.undo`: inverts the change on top of the undo stack and moves it to the redo stack. It is
 * logged like any command, and replay re-runs it against a rebuilt history (ADR 0006). With an
 * empty stack it fails with `nothing-to-undo`, so it is not logged.
 */
export function undoCommand<S>(): CommandDef<NoArgs, S> {
  return defineCommand<NoArgs, S>({
    id: 'edit.undo',
    title: 'Undo',
    category: 'Edit',
    args: NoArgs,
    when: 'history.canUndo',
    keybinding: 'Mod+Z',
    undoable: false,
    run: (ctx) => (ctx.canUndo ? { ok: true, history: 'undo' } : fail('nothing-to-undo', 'Nothing to undo')),
  });
}

/** `edit.redo`: re-applies the change on top of the redo stack. A new world change clears redo. */
export function redoCommand<S>(): CommandDef<NoArgs, S> {
  return defineCommand<NoArgs, S>({
    id: 'edit.redo',
    title: 'Redo',
    category: 'Edit',
    args: NoArgs,
    when: 'history.canRedo',
    keybinding: 'Mod+Shift+Z',
    undoable: false,
    run: (ctx) => (ctx.canRedo ? { ok: true, history: 'redo' } : fail('nothing-to-redo', 'Nothing to redo')),
  });
}

/** `edit.undo` and `edit.redo`, for registering with any state type. */
export function editCommands<S>(): CommandDef<NoArgs, S>[] {
  return [undoCommand<S>(), redoCommand<S>()];
}

/**
 * Defines a **view command**: a UI action that is logged but never changes the state, so it never
 * touches the world hash or the history (ADR 0006). Its `run` is a no-op; the UI performs the
 * effect when the bus reports the command as executed. Declaring view commands in domain code
 * means headless replay (`sim-cli`) knows every id and args schema a log can contain.
 */
export function defineViewCommand<A, S>(
  def: Pick<
    CommandDef<A, S>,
    'id' | 'title' | 'category' | 'args' | 'when' | 'keybinding' | 'globalKeybinding' | 'logged' | 'bindings'
  >,
): CommandDef<A, S> {
  return { ...def, undoable: false, run: () => succeed<S>() };
}

/** `view.resetLayout`: restores the default workspace panel layout (F1.1). */
export function resetLayoutCommand<S>(): CommandDef<NoArgs, S> {
  return defineViewCommand<NoArgs, S>({
    id: 'view.resetLayout',
    title: 'Reset layout',
    category: 'View',
    args: NoArgs,
  });
}

/** Context key that gates the dev console (F1.5): true in Sandbox and dev builds while the workspace shows. */
export const CONSOLE_AVAILABLE_KEY = 'console.available';

/**
 * `console.toggle`: opens the dev console and focuses its input, or closes it when focus is already
 * in it (F1.5, ADR 0008). A view command bound to the backtick key as a **global** binding, so it
 * also fires while typing in the console (a literal backtick can't be typed there unless rebound).
 * UI chrome, so `logged: false`: it never enters the replay log (ADR 0006, "What is logged").
 */
export function consoleToggleCommand<S>(): CommandDef<NoArgs, S> {
  return defineViewCommand<NoArgs, S>({
    id: 'console.toggle',
    title: 'Toggle console',
    category: 'View',
    args: NoArgs,
    when: CONSOLE_AVAILABLE_KEY,
    keybinding: 'Backquote',
    globalKeybinding: true,
    logged: false,
  });
}

/**
 * `toolbelt.select {slot}` arguments: the tool-belt slot, 1 to 9. Persisted in the replay log, so
 * the id and this shape are save format (ADR 0006, ADR 0007): changing either needs a
 * `schemaVersion` bump and a log migration.
 */
export const ToolBeltSelectArgs = z.strictObject({ slot: z.int().min(1).max(TOOL_BELT_SLOTS) });
export type ToolBeltSelectArgs = z.infer<typeof ToolBeltSelectArgs>;

/**
 * `toolbelt.select --slot N`: makes slot N the active tool-belt slot (plan F1.4). A view command:
 * logged, no world change. The active slot is UI state, applied through `Session.onCommand` and
 * published as the `toolbelt.slot` context key. In P1 a slot holds a placeable prop (settings
 * `toolBelt.slots`); placing from it arrives with F1.7. Bound to keys 1-9 by
 * {@link toolBeltBindingDecls}, one binding per slot, since one chord can't carry arguments.
 */
export function toolBeltSelectCommand<S>(): CommandDef<ToolBeltSelectArgs, S> {
  return defineViewCommand<ToolBeltSelectArgs, S>({
    id: 'toolbelt.select',
    title: 'Select tool-belt slot',
    category: 'Tool belt',
    args: ToolBeltSelectArgs,
  });
}

/** Binding id of tool-belt slot `n`'s key (`toolbelt.select.slot3`). */
export const toolBeltBindingId = (slot: number): string => `toolbelt.select.slot${slot}`;

/** Keys 1-9 → `toolbelt.select {slot: n}`. Positional digits, so they stay on the top row on every layout. */
export function toolBeltBindingDecls(): BindingDecl[] {
  return Array.from({ length: TOOL_BELT_SLOTS }, (_, i) => ({
    id: toolBeltBindingId(i + 1),
    title: `Tool-belt slot ${i + 1}`,
    category: 'Tool belt',
    target: { kind: 'command', command: 'toolbelt.select', args: { slot: i + 1 } },
    defaults: [String(i + 1)],
  }));
}

/**
 * `palette.open`: opens the command palette (plan F1.3). A global binding, so Mod+K and Mod+Shift+P
 * also work from a text field or a dialog. The palette applies it through `Session.onCommand`.
 * UI chrome, so `logged: false`: it never enters the replay log (ADR 0006, "What is logged").
 */
export function paletteOpenCommand<S>(): CommandDef<NoArgs, S> {
  return defineViewCommand<NoArgs, S>({
    id: 'palette.open',
    title: 'Open command palette',
    category: 'View',
    args: NoArgs,
    keybinding: ['Mod+K', 'Mod+Shift+P'],
    globalKeybinding: true,
    logged: false,
  });
}

/** Every view command declared so far. */
export function viewCommands<S>(): AnyCommandDef<S>[] {
  return [resetLayoutCommand<S>(), toolBeltSelectCommand<S>(), paletteOpenCommand<S>(), consoleToggleCommand<S>()];
}
