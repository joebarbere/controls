import { z } from 'zod';
import { CommandId, Int, jsonObject } from '../primitives';
import { WorldV1 } from './world';

/*
 * FROZEN once v0.2.0 ships: schemaVersion 1. Never edit this file after that release; add
 * `v2/replay-log.ts` and a v1 → v2 migration instead. Command ids and argument shapes recorded here
 * are part of the save format: renaming a command or changing its args needs a log migration.
 */

/** One successfully executed command (plan F1.2). */
export const ReplayEntryV1 = z
  .strictObject({
    /** Position in the log: 0 for the first entry, then +1 per entry. */
    seq: Int.min(0),
    /** Sim tick at which the command ran (non-decreasing; 0 throughout P1). */
    tick: Int.min(0),
    /** Registered command id. */
    id: CommandId,
    /** The command's arguments after its Zod `args` schema parsed them. */
    args: jsonObject('args'),
  })
  .meta({ id: 'ReplayEntryV1' });
export type ReplayEntryV1 = z.infer<typeof ReplayEntryV1>;

/**
 * `replay.log` in a `.ctrl` save, schemaVersion 1: a single JSON document holding the world the log
 * starts from and every command executed since. Replaying `entries` against `initialWorld` must give
 * the saved world's hash (ADR 0007).
 */
export const ReplayLogV1 = z
  .strictObject({
    schemaVersion: z.literal(1),
    initialWorld: WorldV1,
    entries: z.array(ReplayEntryV1),
  })
  .superRefine((log, ctx) => {
    log.entries.forEach((entry, index) => {
      if (entry.seq !== index) {
        ctx.addIssue({ code: 'custom', path: ['entries', index, 'seq'], message: `seq must be ${index}` });
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
  })
  .meta({
    title: 'Controls replay log, schemaVersion 1',
    description:
      'replay.log in a .ctrl save (ADR 0004, ADR 0007). Zod in @controls/save-format is authoritative; this JSON Schema omits the seq and tick ordering rules.',
  });
export type ReplayLogV1 = z.infer<typeof ReplayLogV1>;
