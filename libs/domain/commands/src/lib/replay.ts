import type { ReplayEntry } from '@controls/save-format';
import type { CommandBus, ExecError } from './bus';

export type ReplayError =
  | { readonly kind: 'out-of-order'; readonly seq: number; readonly message: string }
  | { readonly kind: 'tick-mismatch'; readonly seq: number; readonly message: string }
  | { readonly kind: 'failed'; readonly seq: number; readonly message: string; readonly cause: ExecError }
  | { readonly kind: 'diverged'; readonly seq: number; readonly message: string };

export type ReplayResult = { readonly ok: true } | { readonly ok: false; readonly error: ReplayError };

/**
 * What moves sim time during a replay (ADR 0011 §3): the headless engine, or the game's sim host.
 * `advanceTo(tick)` brings it to the start of `tick` (every step before it run); `applied(entry, state)`
 * hands it each entry once the bus has run it, with the state it produced, so it applies the command
 * at the entry's tick, before stepping that tick.
 */
export interface ReplayTime<S> {
  advanceTo(tick: number): void;
  applied(entry: ReplayEntry, state: S): void;
}

export interface ReplayOptions<S> {
  /** Advanced to each entry's tick, then to `endTick`, and told of every entry. Without it only the bus's tick moves. */
  readonly time?: ReplayTime<S>;
  /** Advance to this tick after the last entry (the log's `endTick`). */
  readonly endTick?: number;
}

/**
 * Re-runs logged entries through `bus`, which must start from the log's initial state with an
 * empty history and an empty log at the log's `firstSeq` (or be continuing that same log). Because the bus is
 * deterministic, the state it reaches equals the live session's. Fails, with the offending `seq`,
 * if an entry is out of order, is at a tick before the bus's (time never runs backwards), no longer
 * succeeds, or logs different arguments than it recorded (for example after a schema change without
 * a log migration). After a failure the bus has run the entries before it (and possibly the failing
 * one): discard it.
 *
 * **Time (ADR 0011 §3).** An entry at a later tick than the bus's is not an error: replay advances
 * `options.time` to the entry's tick, then the bus (`CommandBus.advanceTo`), runs the entry and calls
 * `time.applied(entry, state)`. After the last entry it advances both to `options.endTick`, if given.
 * Time in a replay comes only from entry ticks and `endTick`: a `sim.step` entry doesn't advance
 * anything here, the next entry's tick (or `endTick`) carries its effect. A bus built without
 * `withTick` can't advance, so on it an entry at a later tick is still `tick-mismatch`. v1 logs (every
 * entry at tick 0) replay exactly as before.
 *
 * Entries of commands that are now `logged: false` (UI chrome; older logs may hold them) are kept
 * in the bus's log as they are, without running, so `seq` numbering is unchanged.
 */
export function replayEntries<S>(
  bus: CommandBus<S>,
  entries: readonly ReplayEntry[],
  options: ReplayOptions<S> = {},
): ReplayResult {
  const time = options.time;
  for (const entry of entries) {
    const expectedSeq = bus.nextSeq();
    if (entry.seq !== expectedSeq) {
      return {
        ok: false,
        error: { kind: 'out-of-order', seq: entry.seq, message: `Expected seq ${expectedSeq}, found ${entry.seq}` },
      };
    }
    if (entry.tick < bus.currentTick() || (entry.tick > bus.currentTick() && !bus.canAdvance)) {
      return { ok: false, error: tickMismatch(entry.seq, entry.tick, bus.currentTick()) };
    }
    if (entry.tick > bus.currentTick()) {
      time?.advanceTo(entry.tick);
      bus.advanceTo(entry.tick);
    }
    if (bus.registry.get(entry.id)?.logged === false) {
      // An older log may hold a command that is no longer logged (UI chrome such as `palette.open`).
      // It can't have changed the state, so keep the entry as it is instead of running it.
      bus.carryOver(entry);
      time?.applied(entry, bus.state);
      continue;
    }
    const result = bus.exec(entry.id, entry.args);
    if (!result.ok) {
      return {
        ok: false,
        error: {
          kind: 'failed',
          seq: entry.seq,
          message: `Entry ${entry.seq} (${entry.id}) failed on replay: ${result.error.message}`,
          cause: result.error,
        },
      };
    }
    if (!result.logged) {
      // Unreachable: the registry said this command is logged. Guards against a changed registry.
      return {
        ok: false,
        error: {
          kind: 'diverged',
          seq: entry.seq,
          message: `Entry ${entry.seq} (${entry.id}) was not logged on replay`,
        },
      };
    }
    // The entry ran at `entry.tick`: the bus was checked (or advanced) to it above, and `exec` stamps
    // the tick before `run`, so the logged tick can't differ.
    if (!jsonEqual(result.entry.args, entry.args)) {
      return {
        ok: false,
        error: {
          kind: 'diverged',
          seq: entry.seq,
          message: `Entry ${entry.seq} (${entry.id}) parsed to different arguments on replay`,
        },
      };
    }
    time?.applied(result.entry, bus.state);
  }
  const endTick = options.endTick;
  if (endTick !== undefined && endTick !== bus.currentTick()) {
    if (!Number.isSafeInteger(endTick) || endTick < bus.currentTick() || !bus.canAdvance) {
      return {
        ok: false,
        error: {
          kind: 'tick-mismatch',
          seq: bus.nextSeq(),
          message: `The log ends at tick ${endTick} but replay reached tick ${bus.currentTick()}`,
        },
      };
    }
    time?.advanceTo(endTick);
    bus.advanceTo(endTick);
  }
  return { ok: true };
}

function tickMismatch(seq: number, logged: number, replayed: number): ReplayError {
  return {
    kind: 'tick-mismatch',
    seq,
    message: `Entry ${seq} was logged at tick ${logged} but replayed at tick ${replayed}`,
  };
}

/** Structural equality of two JSON values; object key order doesn't matter. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const keys = Object.keys(aRecord);
  if (keys.length !== Object.keys(bRecord).length) return false;
  return keys.every(
    (key) => Object.prototype.hasOwnProperty.call(bRecord, key) && jsonEqual(aRecord[key], bRecord[key]),
  );
}
