import { NoArgs, defineViewCommand } from './builtin';
import type { AnyCommandDef, CommandDef } from './command';

/*
 * Save and load (F1.8b part 3). Saving writes the session out and loading replaces it; neither is a
 * world mutation, and neither carries anything a replay needs. So they are **unlogged UI commands**
 * (`logged: false`, like `palette.open`): registered so the palette, keybindings and console reach
 * them through the one registry, never written to the replay log, never on the undo stack. Logging
 * them would put a host action into the save format: a replay can't re-run a file dialog, and a
 * `file.load` entry would describe a session the log no longer belongs to (a load replaces the log).
 *
 * The game host registers them (`Session`), not `createWorldRegistry()`: a headless game has no save
 * directory or file dialogs, and `sim-cli` saves with `run --save`. The UI performs them when the
 * session reports the command (`Session.onCommand`), as for every view command.
 */

/** Context key: a game is in progress (New sandbox or a loaded save), as opposed to the menu backdrop. */
export const SESSION_ACTIVE_KEY = 'session.active';

/** `file.save`: saves the game under its save name, or asks for a name if it has none yet. */
export function fileSaveCommand<S>(): CommandDef<NoArgs, S> {
  return defineViewCommand<NoArgs, S>({
    id: 'file.save',
    title: 'Save game',
    category: 'File',
    args: NoArgs,
    when: SESSION_ACTIVE_KEY,
    keybinding: 'Mod+S',
    logged: false,
  });
}

/** `file.saveAs`: writes the game to a file the player picks (a download in the web harness). */
export function fileSaveAsCommand<S>(): CommandDef<NoArgs, S> {
  return defineViewCommand<NoArgs, S>({
    id: 'file.saveAs',
    title: 'Save game to a file…',
    category: 'File',
    args: NoArgs,
    when: SESSION_ACTIVE_KEY,
    keybinding: 'Mod+Shift+S',
    logged: false,
  });
}

/** `file.open`: loads a save from a file the player picks (an upload in the web harness). */
export function fileOpenCommand<S>(): CommandDef<NoArgs, S> {
  return defineViewCommand<NoArgs, S>({
    id: 'file.open',
    title: 'Open a save file…',
    category: 'File',
    args: NoArgs,
    keybinding: 'Mod+O',
    logged: false,
  });
}

/** `file.load`: shows the saved games (manual saves and autosaves) to pick one to load. */
export function fileLoadCommand<S>(): CommandDef<NoArgs, S> {
  return defineViewCommand<NoArgs, S>({
    id: 'file.load',
    title: 'Load game…',
    category: 'File',
    args: NoArgs,
    keybinding: 'Mod+L',
    logged: false,
  });
}

/** `file.save`, `file.saveAs`, `file.open` and `file.load`, for a game host's registry. */
export function fileCommands<S>(): AnyCommandDef<S>[] {
  return [fileSaveCommand<S>(), fileSaveAsCommand<S>(), fileOpenCommand<S>(), fileLoadCommand<S>()];
}
