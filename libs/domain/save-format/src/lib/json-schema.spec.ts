import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { jsonSchemas } from './json-schema';

/*
 * The JSON Schema files in libs/domain/save-format/json-schema/ are generated from Zod and checked in
 * for docs, mods and external tools. If this test fails, the files are stale: regenerate them with
 * `pnpm nx test save-format -u` and commit the result. In CI a missing file fails too.
 */

const outDir = join(import.meta.dirname, '../../json-schema');
const schemas = jsonSchemas();

type Node = Record<string, unknown>;

/** Visits every JSON Schema node. */
function walk(node: unknown, visit: (node: Node, path: string) => void, path = '#'): void {
  if (typeof node !== 'object' || node === null) return;
  if (!Array.isArray(node)) visit(node as Node, path);
  for (const [key, child] of Object.entries(node)) walk(child, visit, `${path}/${key}`);
}

describe('exported JSON Schema', () => {
  it.each(Object.keys(schemas))('%s is up to date', async (file) => {
    await expect(`${JSON.stringify(schemas[file], null, 2)}\n`).toMatchFileSnapshot(join(outDir, file));
  });

  it('there are no stray files in json-schema/', () => {
    expect(readdirSync(outDir).sort()).toStrictEqual(Object.keys(schemas).sort());
  });

  it('every object property is required and unknown keys are refused (no undefined-vs-missing ambiguity)', () => {
    for (const [file, schema] of Object.entries(schemas)) {
      walk(schema, (node, path) => {
        if (node['type'] !== 'object' || typeof node['properties'] !== 'object') return;
        const keys = Object.keys(node['properties'] as Node).sort();
        expect([...((node['required'] as string[]) ?? [])].sort(), `${file} ${path}`).toStrictEqual(keys);
        expect(node['additionalProperties'], `${file} ${path}`).toBe(false);
      });
    }
  });

  it('each versioned document pins its version as a constant', () => {
    const versionOf = (file: string, key: string) => ((schemas[file]['properties'] as Node)[key] as Node)['const'];
    expect(versionOf('manifest.v1.schema.json', 'schemaVersion')).toBe(1);
    expect(versionOf('world.v1.schema.json', 'schemaVersion')).toBe(1);
    expect(versionOf('replay-log.v1.schema.json', 'schemaVersion')).toBe(1);
    expect(versionOf('settings.v1.schema.json', 'settingsVersion')).toBe(1);
    expect(versionOf('settings.v2.schema.json', 'settingsVersion')).toBe(2);
  });
});
