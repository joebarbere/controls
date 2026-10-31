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
  | { readonly kind: 'threw'; readonly id: string; readonly message: string }
  /** A `logged: false` command returned a change or a history move, which replay could never see. */
  | { readonly kind: 'unlogged-change'; readonly id: string; readonly message: string };

/** What ran: the id, the tick and the args in their logged (JSON-normalised) form. Logged or not. */
export interface ExecutedCommand {
  readonly id: string;
  readonly tick: number;
  readonly args: ReplayEntry['args'];
}

/**
 * How a success was recorded. A logged command (the default) has its replay `entry`; a
 * `logged: false` command (UI chrome such as `palette.open`) has `entry: null`, consumed no `seq`
 * and left the history alone.
 */
export type ExecRecord =
  { readonly logged: true; readonly entry: ReplayEntry } | { readonly logged: false; readonly entry: null };

export type ExecSuccess = { readonly ok: true; readonly command: ExecutedCommand } & ExecRecord;

export type ExecResult = ExecSuccess | { readonly ok: false; readonly error: ExecError };

/** Emitted after every successful command (logged or not), once the state and the log are updated. */
export type ExecutedEvent<S> = {
  readonly command: ExecutedCommand;
  readonly def: AnyCommandDef<S>;
  /** The state before the command (identical to `state` for commands that changed nothing). */
  readonly previous: S;
  readonly state: S;
} & ExecRecord;

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
  /**
   * The `seq` of the first entry this bus logs (default 0). A bus continuing a rebased or restarted
   * log starts at that log's `firstSeq`, with an empty log and history, so `seq`-keyed randomness
   * (`commandStreamKey(seq)`) stays put (ADR 0011 §3, `ReplayLogV2.firstSeq`).
   */
  readonly firstSeq?: number;
  /**
   * A copy of `state` at sim tick `tick`, everything else unchanged (for a world, `{ ...world, tick }`).
   * Needed by {@link CommandBus.advanceTo}; a bus without it can't move time (ADR 0011 §3).
   */
  withTick?(state: S, tick: number): S;
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

/** A copy of a JSON value (entries are plain JSON), so the log never aliases a caller's object. */
function structuredCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
 * - A `logged: false` command (UI chrome) runs and notifies listeners but is never logged, consumes
 *   no `seq` and never touches the history; if its `run` returns a change it is refused.
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
  private readonly withTick: ((state: S, tick: number) => S) | undefined;
  /** The `seq` of `entries[0]`: `entries[i].seq === firstSeq + i`. */
  readonly firstSeq: number;

  constructor(options: CommandBusOptions<S>) {
    const firstSeq = options.firstSeq ?? 0;
    if (!Number.isSafeInteger(firstSeq) || firstSeq < 0) throw new RangeError('firstSeq must be a safe integer >= 0');
    this.registry = options.registry;
    this.current = options.initialState;
    this.tickOf = options.tickOf;
    this.markAssisted = options.markAssisted;
    this.withTick = options.withTick;
    this.firstSeq = firstSeq;
  }

  /** Whether this bus can move time ({@link advanceTo}): it was built with `withTick`. */
  get canAdvance(): boolean {
    return this.withTick !== undefined;
  }

  /**
   * Moves the state to sim tick `tick` (ADR 0011 §3): time passing is not a command. Unlogged, it
   * takes no `seq`, leaves the undo and redo stacks alone and fires no `executed` event. A no-op for
   * the current tick. Throws a `RangeError` for a tick that isn't a safe integer or is below the
   * current one (time never runs backwards), and an `Error` on a bus built without `withTick`.
   */
  advanceTo(tick: number): void {
    if (!Number.isSafeInteger(tick)) throw new RangeError(`advanceTo needs a safe integer tick, got ${tick}`);
    const current = this.currentTick();
    if (tick < current) throw new RangeError(`advanceTo(${tick}) is before the current tick ${current}`);
    if (this.withTick === undefined) throw new Error('This bus was built without withTick, so it cannot move time');
    if (tick === current) return;
    this.current = this.withTick(this.current, tick);
  }

  /** The `seq` the next logged command gets: `firstSeq` + the entries logged so far. The one source of `seq`s. */
  nextSeq(): number {
    return this.firstSeq + this.log.length;
  }

  /** The current state. Treat it as immutable. */
  get state(): S {
    return this.current;
  }

  /** The replay entries logged so far (frozen). */
  get entries(): readonly ReplayEntry[] {
    return this.log;
  }

  /** The sim tick of the current state (what the next entry would record). */
  currentTick(): number {
    return this.tickOf(this.current);
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
    const seq = this.nextSeq();
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

    const command: ExecutedCommand = deepFreeze({ id, tick, args: entry.data.args });
    const previous = this.current;
    let record: ExecRecord;
    if (def.logged === false) {
      if ('history' in result || result.change !== null || next !== previous) {
        return {
          ok: false,
          error: {
            kind: 'unlogged-change',
            id,
            message: `"${id}" is not logged, so it must not change the state or the history`,
          },
        };
      }
      record = { logged: false, entry: null };
    } else {
      this.commit(def, result);
      this.current = next;
      const logged = deepFreeze(entry.data);
      this.log.push(logged);
      record = { logged: true, entry: logged };
    }
    const event: ExecutedEvent<S> = { command, def, previous, state: this.current, ...record };
    for (const listener of [...this.listeners]) listener(event);
    return { ok: true, command, ...record };
  }

  /**
   * Replay only: appends a recorded entry of a command that is now `logged: false` without running
   * it, so an older log that still contains one keeps its `seq` numbering (and every later
   * command's `seq`-derived randomness). Such a command can't change the state, so skipping its run
   * is exact. Throws on misuse: an unknown or logged command, or a `seq` or tick that doesn't fit.
   */
  carryOver(entry: ReplayEntry): void {
    const def = this.registry.get(entry.id);
    if (!def || def.logged !== false) throw new Error(`"${entry.id}" is not an unlogged command`);
    if (entry.seq !== this.nextSeq()) throw new Error(`Expected seq ${this.nextSeq()}, found ${entry.seq}`);
    if (entry.tick !== this.currentTick()) throw new Error(`Entry ${entry.seq} is at a different tick`);
    this.log.push(deepFreeze(structuredCloneJson(entry)));
  }

  /**
   * Empties the undo and redo stacks; the state and the log are untouched. Loading a save does
   * this (F1.8b: "the undo stack is cleared and the replay log continues"), so the player can't
   * undo past the load.
   *
   * Replay stays exact: a fresh bus replaying the whole log keeps the pre-load history, but the
   * live stacks are always the top part of the replayed ones (empty after the clear; every later
   * command pushes, pops or clears both alike). So every `edit.undo` / `edit.redo` that succeeds
   * live, and is therefore logged, pops the same change on replay. One that fails live is never
   * logged, so the extra history is never reached.
   */
  clearHistory(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
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
