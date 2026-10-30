import { z } from 'zod';
import { Int } from '../primitives';
import { ReplayEntryV1 } from '../v1/replay-log';
import { WorldV2 } from './world';

/*
 * FROZEN once v0.3.0 ships: schemaVersion 2 (ADR 0013). After that, add `v3/replay-log.ts` and a
 * v2 → v3 migration instead. Command ids and argument shapes recorded here are save format.
 */

/** One successfully executed command: the same shape as v1 (`{ seq, tick, id, args }`). */
export const ReplayEntryV2 = z.strictObject({ ...ReplayEntryV1.shape }).meta({ id: 'ReplayEntryV2' });
export type ReplayEntryV2 = z.infer<typeof ReplayEntryV2>;

/**
 * `replay.log` in a `.ctrl` save, schemaVersion 2: the world the log starts from, the `seq` of its
 * first entry, every command executed since, and the tick the log runs to (ADR 0011 §3, ADR 0013).
 *
 * - `firstSeq`: a rebased or restarted log keeps its `seq`s, so seeded streams keyed by
 *   `commandStreamKey(seq)` stay put. `entries[i].seq === firstSeq + i`.
 * - `endTick`: time passes without commands, so the log says where it ends.
 *   `endTick ≥ last entry tick ≥ … ≥ initialWorld.tick`; a lower `endTick` is refused.
 */
export const ReplayLogV2 = z
  .strictObject({
    schemaVersion: z.literal(2),
    initialWorld: WorldV2,
    /** The `seq` of `entries[0]` (or of the next entry, for an empty log). */
    firstSeq: Int.min(0),
    entries: z.array(ReplayEntryV2),
    /** The tick the session had reached when the log was taken: replay advances to it after the last entry. */
    endTick: Int.min(0),
  })
  .superRefine((log, ctx) => {
    if (!Number.isSafeInteger(log.firstSeq + log.entries.length)) {
      ctx.addIssue({ code: 'custom', path: ['firstSeq'], message: 'firstSeq + entries must stay a safe integer' });
    }
    log.entries.forEach((entry, index) => {
      if (entry.seq !== log.firstSeq + index) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', index, 'seq'],
          message: `seq must be firstSeq + ${index}`,
        });
      }
      const previousTick = index === 0 ? log.initialWorld.tick : log.entries[index - 1].tick;
      if (entry.tick < previousTick) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', index, 'tick'],
          message: 'tick must not go backwards (or start before the initial world)',
        });
      }
    });
    const lastTick = log.entries.at(-1)?.tick ?? log.initialWorld.tick;
    if (log.endTick < lastTick) {
      ctx.addIssue({
        code: 'custom',
        path: ['endTick'],
        message: 'endTick must not be before the last entry (or the initial world)',
      });
    }
  })
  .meta({
    title: 'Controls replay log, schemaVersion 2',
    description:
      'replay.log in a .ctrl save (ADR 0004, ADR 0007, ADR 0013). Zod in @controls/save-format is authoritative; this JSON Schema omits the seq, tick and endTick ordering rules.',
  });
export type ReplayLogV2 = z.infer<typeof ReplayLogV2>;
