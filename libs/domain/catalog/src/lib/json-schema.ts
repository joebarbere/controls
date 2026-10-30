import { z } from 'zod';
import { DeviceDefinition } from './device';
import { bagSchemas, MODEL_KINDS } from './model-kinds';

/*
 * JSON Schema (draft 2020-12) for the catalogue entry format and for each model kind's state bags,
 * for docs, content tools and mods. Zod stays authoritative. The checked-in copies under
 * `json-schema/` are compared to this by a test; regenerate them with `pnpm nx test catalog -u`.
 *
 * `device-state.<kind>.schema.json` is save format (ADR 0013): it describes what `EntityV2.state` and
 * `EntityV2.sim` hold for a device of that kind. Changing an existing kind's file needs a
 * `schemaVersion` bump; a new kind adds a file.
 */
export function catalogJsonSchemas(): Record<string, Record<string, unknown>> {
  const generate = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'draft-2020-12' });
  const out: Record<string, Record<string, unknown>> = { 'device.v1.schema.json': generate(DeviceDefinition) };
  for (const name of Object.keys(MODEL_KINDS).sort()) {
    const kind = MODEL_KINDS[name];
    if (kind.placement !== 'entity') continue; // connections carry no state bags
    const bags = bagSchemas(kind);
    out[`device-state.${name}.schema.json`] = generate(
      z.strictObject({ state: bags.state, sim: bags.sim }).meta({
        title: `Device state of model kind ${name}`,
        description: `EntityV2.state (commanded) and EntityV2.sim (sim-owned) of a ${name} device (ADR 0011, ADR 0013). Every key is present; null means absent.`,
      }),
    );
  }
  return out;
}
