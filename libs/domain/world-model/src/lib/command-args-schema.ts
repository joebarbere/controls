import { z } from 'zod';
import { createWorldRegistry } from './session';

/*
 * JSON Schema (draft 2020-12) of every logged command's arguments: what a replay log's `args` can
 * hold for each command id (ADR 0007, ADR 0011 §12, ADR 0013). Command ids and argument shapes are
 * save format, so these files are frozen like the document schemas: `command-args.spec.ts` fails when
 * one changes, and regenerating one (`pnpm nx test world-model -u`) is a save-format change that
 * needs a `schemaVersion` bump and a log migration, unless only `.meta()` hints (titles,
 * descriptions, `x-controls-ref`) changed.
 *
 * The schemas are the **output** side (what parsing produces and the log stores): defaults are filled
 * in, so a defaulted key is required. Every logged command of `createWorldRegistry()` is here, the
 * sim time commands included (registered since F2.3a; their schemas were frozen at the P2 kickoff).
 */
export function commandArgJsonSchemas(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  const add = (id: string, schema: z.ZodType) => {
    out[`${id}.args.schema.json`] = {
      ...z.toJSONSchema(schema, { target: 'draft-2020-12' }),
      title: `Arguments of ${id}`,
    };
  };
  for (const def of createWorldRegistry().list()) {
    if (def.logged !== false) add(def.id, def.args);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}
