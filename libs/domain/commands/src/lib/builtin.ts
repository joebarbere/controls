import { z } from 'zod';
import { type CommandDef, defineCommand, fail, succeed } from './command';

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
  def: Pick<CommandDef<A, S>, 'id' | 'title' | 'category' | 'args' | 'when' | 'keybinding'>,
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

/** Every view command declared so far. */
export function viewCommands<S>(): CommandDef<NoArgs, S>[] {
  return [resetLayoutCommand<S>()];
}
