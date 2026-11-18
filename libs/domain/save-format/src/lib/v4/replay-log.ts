import * as z from 'zod';
import { Int } from '../primitives';
import { ReplayEntryV1 } from '../v1/replay-log';
import { WorldV4 } from './world';

/*
 * PROVISIONAL until v0.5.0 ships: schemaVersion 4 (ADR 0019). After that it is frozen; add
 * `v5/replay-log.ts` and a v4 → v5 migration instead. Command ids and argument shapes recorded here
 * are save format (frozen in world-model's `json-schema/command-args/`).
 */

/** One successfully executed command: the same shape as v1–v3 (`{ seq, tick, id, args }`). */
export const ReplayEntryV4 = z.strictObject({ ...ReplayEntryV1.shape }).meta({ id: 'ReplayEntryV4' });
export type ReplayEntryV4 = z.infer<typeof ReplayEntryV4>;

/**
 * `replay.log` in a `.ctrl` save, schemaVersion 4: v3's log over a v4 initial world. The rules are
 * v2's: `entries[i].seq === firstSeq + i`; `endTick ≥ last entry tick ≥ … ≥ initialWorld.tick`.
 */
export const ReplayLogV4 = z
  .strictObject({
    schemaVersion: z.literal(4),
    initialWorld: WorldV4,
    /** The `seq` of `entries[0]` (or of the next entry, for an empty log). */
    firstSeq: Int.min(0),
    entries: z.array(ReplayEntryV4),
    /** The tick the session had reached when the log was taken: replay advances to it after the last entry. */
    endTick: Int.min(0),
  })
  .superRefine((log, ctx) => {
    if (!Number.isSafeInteger(log.firstSeq + log.entries.length)) {
      ctx.addIssue({ code: 'custom', path: ['firstSeq'], message: 'firstSeq + entries must stay a safe integer' });
    }
    log.entries.forEach((entry, index) => {
      if (entry.seq !== log.firstSeq + index) {
        ctx.addIssue({ code: 'custom', path: ['entries', index, 'seq'], message: `seq must be firstSeq + ${index}` });
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
    title: 'Controls replay log, schemaVersion 4',
    description:
      'replay.log in a .ctrl save (ADR 0004, ADR 0007, ADR 0013, ADR 0015, ADR 0019). Zod in @controls/save-format is authoritative; this JSON Schema omits the seq, tick and endTick ordering rules.',
  });
export type ReplayLogV4 = z.infer<typeof ReplayLogV4>;
