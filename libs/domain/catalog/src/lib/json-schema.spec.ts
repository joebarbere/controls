import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { catalogJsonSchemas } from './json-schema';
import { MODEL_KINDS } from './model-kinds';
import { TABLE_KINDS } from './tables';

/*
 * The JSON Schema files in libs/domain/catalog/json-schema/ are generated from Zod and checked in. If
 * this test fails they are stale: regenerate them with `pnpm nx test catalog -u` and commit the
 * result. `device-state.<kind>.schema.json` and `connection-state.<kind>.schema.json` are save format
 * (ADR 0013, ADR 0015): an existing kind's file changes only with a `schemaVersion` bump (the lead's
 * connection keys enter saves with world v3).
 */

const outDir = join(import.meta.dirname, '../../json-schema');
const schemas = catalogJsonSchemas();

type Node = Record<string, unknown>;

function walk(node: unknown, visit: (node: Node, path: string) => void, path = '#'): void {
  if (typeof node !== 'object' || node === null) return;
  if (!Array.isArray(node)) visit(node as Node, path);
  for (const [key, child] of Object.entries(node)) walk(child, visit, `${path}/${key}`);
}

describe('exported catalogue JSON Schema', () => {
  it.each(Object.keys(schemas))('%s is up to date', async (file) => {
    await expect(`${JSON.stringify(schemas[file], null, 2)}\n`).toMatchFileSnapshot(join(outDir, file));
  });

  it('there are no stray files in json-schema/', () => {
    expect(readdirSync(outDir).sort()).toStrictEqual(Object.keys(schemas).sort());
  });

  it('has the v2 formats, one row file per table and one state file per model kind', () => {
    const states = Object.values(MODEL_KINDS).map((k) =>
      k.placement === 'entity' ? `device-state.${k.kind}.schema.json` : `connection-state.${k.kind}.schema.json`,
    );
    const formats = ['device', 'cable', 'tool', 'accessory', 'table'].map((f) => `${f}.v2.schema.json`);
    const rows = Object.keys(TABLE_KINDS).map((t) => `table-row.${t}.schema.json`);
    expect(Object.keys(schemas).sort()).toStrictEqual([...formats, ...rows, ...states].sort());
  });

  it('pins the lead bags (ADR 0015): no commanded keys, the ten sim keys', () => {
    const props = schemas['connection-state.lead.schema.json']['properties'] as Record<string, Node>;
    expect(props['state']['properties']).toStrictEqual({});
    expect(Object.keys(props['sim']['properties'] as Node).sort()).toStrictEqual([
      'conductorTempK',
      'endADegradation',
      'endAState',
      'endATempK',
      'endATerminationId',
      'endBDegradation',
      'endBState',
      'endBTempK',
      'endBTerminationId',
      'insulationDamaged',
    ]);
  });

  it('every object property is required and unknown keys are refused', () => {
    for (const [file, schema] of Object.entries(schemas)) {
      walk(schema, (node, path) => {
        if (node['type'] !== 'object' || typeof node['properties'] !== 'object') return;
        const keys = Object.keys(node['properties'] as Node).sort();
        expect([...((node['required'] as string[]) ?? [])].sort(), `${file} ${path}`).toStrictEqual(keys);
        expect(node['additionalProperties'], `${file} ${path}`).toBe(false);
      });
    }
  });

  it('pins the switch bags: a commanded `closed` and no sim keys', () => {
    const props = schemas['device-state.switch.spst.schema.json']['properties'] as Record<string, Node>;
    expect(props['state']['properties']).toStrictEqual({ closed: { type: 'boolean' } });
    expect(props['sim']['properties']).toStrictEqual({});
  });
});
