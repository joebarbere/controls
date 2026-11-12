import * as z from 'zod';
import { DeviceDefinition } from './device';
import { AccessoryDefinition, CableDefinition, ToolDefinition } from './families';
import { bagSchemas, MODEL_KINDS } from './model-kinds';
import { TABLE_KINDS, TableDocument } from './tables';

/*
 * JSON Schema (draft 2020-12) for the catalogue formats and for each model kind's state bags, for
 * docs, content tools and mods. Zod stays authoritative. The checked-in copies under `json-schema/`
 * are compared to this by a test; regenerate them with `pnpm nx test catalog -u`.
 *
 * - `<family>.v2.schema.json`: catalogue format v2 (ADR 0016) for devices, cables, tools, accessories
 *   and tables; `table-row.<table>.schema.json`: each table's row shape. Catalogue data, not save format.
 * - `device-state.<kind>.schema.json` and `connection-state.<kind>.schema.json` are save format
 *   (ADR 0013, ADR 0015): what `EntityV2.state`/`sim` and world v3's `ConnectionV3.state`/`sim` hold for
 *   that kind. Changing an existing kind's file needs a `schemaVersion` bump; a new kind adds a file.
 */
export function catalogJsonSchemas(): Record<string, Record<string, unknown>> {
  const generate = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'draft-2020-12' });
  const out: Record<string, Record<string, unknown>> = {
    'device.v2.schema.json': generate(DeviceDefinition),
    'cable.v2.schema.json': generate(CableDefinition),
    'tool.v2.schema.json': generate(ToolDefinition),
    'accessory.v2.schema.json': generate(AccessoryDefinition),
    'table.v2.schema.json': generate(TableDocument),
  };
  for (const name of Object.keys(TABLE_KINDS).sort()) {
    out[`table-row.${name}.schema.json`] = generate(
      TABLE_KINDS[name].row.meta({
        title: `Row of catalogue table ${name}`,
        description: TABLE_KINDS[name].description,
      }),
    );
  }
  for (const name of Object.keys(MODEL_KINDS).sort()) {
    const kind = MODEL_KINDS[name];
    const bags = bagSchemas(kind);
    if (kind.placement === 'entity') {
      out[`device-state.${name}.schema.json`] = generate(
        z.strictObject({ state: bags.state, sim: bags.sim }).meta({
          title: `Device state of model kind ${name}`,
          description: `EntityV2.state (commanded) and EntityV2.sim (sim-owned) of a ${name} device (ADR 0011, ADR 0013). Every key is present; null means absent.`,
        }),
      );
    } else {
      out[`connection-state.${name}.schema.json`] = generate(
        z.strictObject({ state: bags.state, sim: bags.sim }).meta({
          title: `Connection state of model kind ${name}`,
          description: `ConnectionV3.state (commanded) and ConnectionV3.sim (sim-owned) of a ${name} connection (ADR 0015). Every key is present; null means absent.`,
        }),
      );
    }
  }
  return out;
}
