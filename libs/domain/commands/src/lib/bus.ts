import { ReplayEntry } from '@controls/save-format';
import type { z } from 'zod';
import type { AnyCommandDef, Change, CommandContext, CommandFailure, CommandResult } from './command';
import type { CommandRegistry } from './registry';

/** One problem with a command's arguments. Never echoes the value. */
export interface ArgIssue {
  readonly path: string;
  readonly message: string;
}

/** Why `exec` did nothing. The state, the history and the log are unchanged after any of these. */
export type ExecError =
  | { readonly kind: 'unknown-command'; readonly id: string; readonly message: string }
  | { readonly kind: 'invalid-args'; readonly id: string; readonly message: string; readonly issues: ArgIssue[] }
  | { readonly kind: 'rejected'; readonly id: string; readonly code: string; readonly message: string }
  | { readonly kind: 'threw'; readonly id: string; readonly message: string };

export type ExecResult =
  { readonly ok: true; readonly entry: ReplayEntry } | { readonly ok: false; readonly error: ExecError };

/** Emitted after every successful command, once the state and the log are updated. */
export interface ExecutedEvent<S> {
  readonly entry: ReplayEntry;
  readonly def: AnyCommandDef<S>;
  /** The state before the command (identical to `state` for commands that changed nothing). */
  readonly previous: S;
  readonly state: S;
}

export type ExecutedListener<S> = (event: ExecutedEvent<S>) => void;

export interface CommandBusOptions<S> {
  readonly registry: CommandRegistry<S>;
  readonly initialState: S;
  /** The sim tick of a state, written into each replay entry. */
  tickOf(state: S): number;
  /**
   * Applied after a successful `cheat` command, outside its change, so undoing the cheat doesn't
   * clear the mark (the world's `assisted` flag is never cleared). Optional for states without one.
   */
  markAssisted?(state: S): S;
}

/** Reported at most this many argument issues per error. */
const MAX_ISSUES = 20;
const MAX_TEXT = 200;

function issues(error: z.ZodError): ArgIssue[] {
  return error.issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: issue.path.map(String).join('.').slice(0, MAX_TEXT),
    message: issue.message.slice(0, MAX_TEXT),
  }));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * The command bus: runs registered commands against a state, keeps the undo and redo stacks and
 * appends each successful command to the replay log (ADR 0006). Framework-free and synchronous.
 *
 * - `exec` parses `args` with the command's Zod schema before `run`, then checks that the parsed
 *   args form a valid replay entry (JSON object, finite numbers). Any failure returns a typed error
 *   and leaves the state, the history and the log untouched. So does a `run` that throws.
 * - Only successful commands are logged, including view commands and `edit.undo` / `edit.redo`.
 *   Replaying the log against the initial state through a fresh bus rebuilds the same history, so
 *   it reaches the same state.
 * - An undoable change goes on the undo stack and clears redo. A non-undoable change clears both.
 */
export class CommandBus<S> {
  readonly registry: CommandRegistry<S>;
  private current: S;
  private readonly undoStack: Change<S>[] = [];
  private readonly redoStack: Change<S>[] = [];
  private readonly log: ReplayEntry[] = [];
  private readonly listeners = new Set<ExecutedListener<S>>();
  private readonly tickOf: (state: S) => number;
  private readonly markAssisted: ((state: S) => S) | undefined;

  constructor(options: CommandBusOptions<S>) {
    this.registry = options.registry;
    this.current = options.initialState;
    this.tickOf = options.tickOf;
    this.markAssisted = options.markAssisted;
  }

  /** The current state. Treat it as immutable. */
  get state(): S {
    return this.current;
  }

  /** The replay entries logged so far (frozen). */
  get entries(): readonly ReplayEntry[] {
    return this.log;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Context keys the bus owns, for `when`: `history.canUndo` and `history.canRedo`. */
  contextKeys(): { 'history.canUndo': boolean; 'history.canRedo': boolean } {
    return { 'history.canUndo': this.canUndo, 'history.canRedo': this.canRedo };
  }

  /** Runs a command by id. `args` defaults to `{}` (commands without arguments). */
  exec(id: string, args: unknown = {}): ExecResult {
    const def = this.registry.get(id);
    if (!def) return { ok: false, error: { kind: 'unknown-command', id, message: `Unknown command "${id}"` } };

    const parsed = def.args.safeParse(args);
    if (!parsed.success) {
      return {
        ok: false,
        error: { kind: 'invalid-args', id, message: `Invalid arguments for "${id}"`, issues: issues(parsed.error) },
      };
    }
    const seq = this.log.length;
    const tick = this.tickOf(this.current);
    const entry = ReplayEntry.safeParse({ seq, tick, id, args: parsed.data });
    if (!entry.success) {
      return {
        ok: false,
        error: {
          kind: 'invalid-args',
          id,
          message: `Arguments for "${id}" can't be logged (they must form a JSON object)`,
          issues: issues(entry.error),
        },
      };
    }

    const ctx: CommandContext<S> = { state: this.current, seq, tick, canUndo: this.canUndo, canRedo: this.canRedo };
    let result: CommandResult<S>;
    let next: S;
    try {
      // `run` gets the logged form of the args (JSON-normalised, `-0` → 0), so live and replay agree.
      result = def.run(ctx, entry.data.args as typeof parsed.data);
      next = this.next(def, result);
    } catch (error) {
      return {
        ok: false,
        error: { kind: 'threw', id, message: error instanceof Error ? error.message : String(error) },
      };
    }
    if (!result.ok) return { ok: false, error: { kind: 'rejected', id, code: result.code, message: result.message } };

    this.commit(def, result);
    const previous = this.current;
    this.current = next;
    const logged = deepFreeze(entry.data);
    this.log.push(logged);
    const event: ExecutedEvent<S> = { entry: logged, def, previous, state: next };
    for (const listener of [...this.listeners]) listener(event);
    return { ok: true, entry: logged };
  }

  /** Calls `listener` after every successful command. Returns an unsubscribe function. */
  subscribe(listener: ExecutedListener<S>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The state a result leads to, computed before anything is committed so that a throwing change
   * leaves the bus untouched.
   */
  private next(def: AnyCommandDef<S>, result: CommandResult<S>): S {
    if (!result.ok) return this.current;
    let next = this.current;
    if ('history' in result) {
      const stack = result.history === 'undo' ? this.undoStack : this.redoStack;
      const change = stack.at(-1);
      // The built-in edit commands check `ctx.canUndo` / `ctx.canRedo` first; this guards a custom one.
      if (!change) throw new Error(`Nothing to ${result.history}`);
      next = result.history === 'undo' ? change.invert(next) : change.apply(next);
    } else if (result.change) {
      next = result.change.apply(next);
    }
    if (def.cheat && this.markAssisted) next = this.markAssisted(next);
    return next;
  }

  private commit(def: AnyCommandDef<S>, result: Exclude<CommandResult<S>, CommandFailure>): void {
    if ('history' in result) {
      const [from, to] =
        result.history === 'undo' ? [this.undoStack, this.redoStack] : [this.redoStack, this.undoStack];
      to.push(from.pop() as Change<S>);
    } else if (result.change) {
      this.redoStack.length = 0;
      if (def.undoable) this.undoStack.push(result.change);
      else this.undoStack.length = 0;
    }
  }
}
