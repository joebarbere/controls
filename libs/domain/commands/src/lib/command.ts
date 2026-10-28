import type { z } from 'zod';
import type { BindingDecl } from './keybindings/keymap';

/**
 * A reversible state change: the apply/invert pair an undoable command produces (ADR 0006).
 * Both functions are pure: they return a new state and never mutate their argument. `invert` is
 * only ever called on the state `apply` returned, and `apply` on the state the command ran against
 * (the undo and redo stacks guarantee it), so a change may capture values from that state.
 */
export interface Change<S> {
  apply(state: S): S;
  invert(state: S): S;
}

/** What `run` sees. Read-only: a command returns its change and never mutates anything. */
export interface CommandContext<S> {
  /** The current state (for world commands, the world document). */
  readonly state: S;
  /** The `seq` this command's replay entry will get if it succeeds. Stable across replays. */
  readonly seq: number;
  /** The sim tick the command runs at. */
  readonly tick: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

/** `run` succeeded. `change` is `null` for commands that leave the state alone (view commands). */
export interface CommandSuccess<S> {
  readonly ok: true;
  readonly change: Change<S> | null;
}

/** `run` refused, for example because an entity id doesn't exist. The state and log stay unchanged. */
export interface CommandFailure {
  readonly ok: false;
  /** Machine-readable reason, e.g. `not-found`, `nothing-to-undo`. */
  readonly code: string;
  readonly message: string;
}

/** Returned only by the built-in `edit.undo` / `edit.redo`: move along the history instead of changing state. */
export interface HistoryMove {
  readonly ok: true;
  readonly history: 'undo' | 'redo';
}

export type CommandResult<S> = CommandSuccess<S> | CommandFailure | HistoryMove;

/**
 * A registered command (plan §4.6). Every world mutation and every logged UI action is one. The
 * `id` and the parsed `args` are written to the replay log, so both are part of the save format.
 */
export interface CommandDef<A = unknown, S = unknown> {
  /** Dotted, camelCase segments: `entity.place`, `view.resetLayout` (the replay-log grammar). */
  readonly id: string;
  readonly title: string;
  /** Display group for the palette and help, e.g. `Edit`, `Entity`, `View`. */
  readonly category: string;
  /** Validates palette forms, console flags and script calls alike. Must produce a JSON object. */
  readonly args: z.ZodType<A>;
  /**
   * Context expression (see `parseWhen`) that decides whether the palette and keybindings offer
   * the command. Advisory: `exec` doesn't check it, because the UI context isn't in the replay log.
   */
  readonly when?: string;
  /**
   * Default keybinding(s), e.g. `Mod+Z` or `['Mod+K', 'Mod+Shift+P']` (chord grammar: `normaliseChord`).
   * Rebindable: a player override replaces all of them (F1.4).
   */
  readonly keybinding?: string | readonly string[];
  /**
   * The keybinding also fires while focus is in a text field, a code editor or a dialog. Only for
   * commands that must work from anywhere: the palette and the console toggle.
   */
  readonly globalKeybinding?: boolean;
  /**
   * Extra default bindings that run this command with fixed arguments or with arguments taken from
   * context keys (`view.mode.walk`, `entity.delete.selection`), for commands whose arguments one
   * chord can't carry. Collected by `defaultBindingDecls`; each has its own binding id.
   */
  readonly bindings?: readonly BindingDecl[];
  /**
   * Whether the change it returns goes on the undo stack. A non-undoable command that still
   * changes the state clears both stacks: history can't be undone past it.
   */
  readonly undoable: boolean;
  /** Marks the world as assisted when it succeeds (the host decides what that means). */
  readonly cheat?: boolean;
  /**
   * Whether a successful run is written to the replay log (default `true`). `false` only for
   * commands that open or close UI chrome and carry no information replay needs (`palette.open`,
   * `console.toggle`). They run through the registry and fire listeners but are never written to
   * the replay log, consume no `seq` and leave undo and redo alone. Because an unlogged state change
   * would break replay, the registry refuses `logged: false` with `undoable` or `cheat`, and `exec`
   * refuses (`unlogged-change`) a run that returns a change or a history move.
   */
  readonly logged?: boolean;
  /** Pure: reads `ctx.state` and returns a change or a failure. Never mutates. */
  run(ctx: CommandContext<S>, args: A): CommandResult<S>;
}

/** A command of any argument type, as the registry stores it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCommandDef<S> = CommandDef<any, S>;

/** Identity helper that infers `A` from the `args` schema. */
export function defineCommand<A, S>(def: CommandDef<A, S>): CommandDef<A, S> {
  return def;
}

/** Shorthand for a successful `run` result. */
export function succeed<S>(change: Change<S> | null = null): CommandSuccess<S> {
  return { ok: true, change };
}

/** Shorthand for a refused `run` result. */
export function fail(code: string, message: string): CommandFailure {
  return { ok: false, code, message };
}
