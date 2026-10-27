import { z } from 'zod';
import { SettingsV1 } from './settings/v1';
import { ManifestV1 } from './v1/manifest';
import { ReplayLogV1 } from './v1/replay-log';
import { WorldV1 } from './v1/world';

/**
 * JSON Schema (draft 2020-12) generated from the Zod schemas, for docs, mods and external tools. Zod
 * stays authoritative: refinements (sorted ids, surrogate checks, nesting limits) are not expressible
 * here. Every published version keeps its file. The checked-in copies under `json-schema/` are
 * compared to this by a test; regenerate them with `pnpm nx test save-format -u`.
 */
export function jsonSchemas(): Record<string, Record<string, unknown>> {
  const generate = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'draft-2020-12' });
  return {
    'manifest.v1.schema.json': generate(ManifestV1),
    'world.v1.schema.json': generate(WorldV1),
    'replay-log.v1.schema.json': generate(ReplayLogV1),
    'settings.v1.schema.json': generate(SettingsV1),
  };
}
