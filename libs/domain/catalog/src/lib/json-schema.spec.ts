import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { catalogJsonSchemas } from './json-schema';
import { MODEL_KINDS } from './model-kinds';

/*
 * The JSON Schema files in libs/domain/catalog/json-schema/ are generated from Zod and checked in. If
 * this test fails they are stale: regenerate them with `pnpm nx test catalog -u` and commit the
 * result. `device-state.<kind>.schema.json` is save format (ADR 0013): an existing kind's file changes
 * only with a `schemaVersion` bump.
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

  it('has the entry format and one device-state file per placed model kind', () => {
    const placed = Object.values(MODEL_KINDS)
      .filter((k) => k.placement === 'entity')
      .map((k) => `device-state.${k.kind}.schema.json`);
    expect(Object.keys(schemas).sort()).toStrictEqual(['device.v1.schema.json', ...placed].sort());
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
