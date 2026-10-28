import type { ReplayEntry } from '@controls/save-format';
import type { CommandBus, ExecError } from './bus';

export type ReplayError =
  | { readonly kind: 'out-of-order'; readonly seq: number; readonly message: string }
  | { readonly kind: 'tick-mismatch'; readonly seq: number; readonly message: string }
  | { readonly kind: 'failed'; readonly seq: number; readonly message: string; readonly cause: ExecError }
  | { readonly kind: 'diverged'; readonly seq: number; readonly message: string };

export type ReplayResult = { readonly ok: true } | { readonly ok: false; readonly error: ReplayError };

/**
 * Re-runs logged entries through `bus`, which must start from the log's initial state with an
 * empty history and an empty log (or be continuing that same log). Because the bus is
 * deterministic, the state it reaches equals the live session's. Fails, with the offending `seq`,
 * if an entry is out of order, ran at a different tick, no longer succeeds, or logs different
 * arguments than it recorded (for example after a schema change without a log migration). After a
 * failure the bus has run the entries before it (and possibly the failing one): discard it.
 *
 * Entries of commands that are now `logged: false` (UI chrome; older logs may hold them) are kept
 * in the bus's log as they are, without running, so `seq` numbering is unchanged.
 */
export function replayEntries<S>(bus: CommandBus<S>, entries: readonly ReplayEntry[]): ReplayResult {
  for (const entry of entries) {
    const expectedSeq = bus.entries.length;
    if (entry.seq !== expectedSeq) {
      return {
        ok: false,
        error: { kind: 'out-of-order', seq: entry.seq, message: `Expected seq ${expectedSeq}, found ${entry.seq}` },
      };
    }
    if (bus.registry.get(entry.id)?.logged === false) {
      // An older log may hold a command that is no longer logged (UI chrome such as `palette.open`).
      // It can't have changed the state, so keep the entry as it is instead of running it.
      if (entry.tick !== bus.currentTick()) {
        return {
          ok: false,
          error: {
            kind: 'tick-mismatch',
            seq: entry.seq,
            message: `Entry ${entry.seq} was logged at tick ${entry.tick} but replayed at tick ${bus.currentTick()}`,
          },
        };
      }
      bus.carryOver(entry);
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
    if (result.entry.tick !== entry.tick) {
      return {
        ok: false,
        error: {
          kind: 'tick-mismatch',
          seq: entry.seq,
          message: `Entry ${entry.seq} was logged at tick ${entry.tick} but replayed at tick ${result.entry.tick}`,
        },
      };
    }
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
  }
  return { ok: true };
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
