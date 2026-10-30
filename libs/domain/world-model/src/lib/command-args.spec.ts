import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { commandArgJsonSchemas } from './command-args-schema';
import { createWorldRegistry } from './session';

/*
 * Every logged command's arguments are save format (ADR 0007, ADR 0011 §12, ADR 0013). The JSON
 * Schema files in libs/domain/world-model/json-schema/command-args/ freeze them: if this test fails,
 * an argument shape changed. That needs a `schemaVersion` bump and a replay-log migration unless only
 * a `.meta()` hint changed; then regenerate with `pnpm nx test world-model -u` and commit the files.
 */

const outDir = join(import.meta.dirname, '../../json-schema/command-args');
const schemas = commandArgJsonSchemas();

type Node = Record<string, unknown>;

function walk(node: unknown, visit: (node: Node, path: string) => void, path = '#'): void {
  if (typeof node !== 'object' || node === null) return;
  if (!Array.isArray(node)) visit(node as Node, path);
  for (const [key, child] of Object.entries(node)) walk(child, visit, `${path}/${key}`);
}

describe('exported command argument JSON Schema', () => {
  it.each(Object.keys(schemas))('%s is up to date', async (file) => {
    await expect(`${JSON.stringify(schemas[file], null, 2)}\n`).toMatchFileSnapshot(join(outDir, file));
  });

  it('there are no stray files', () => {
    expect(readdirSync(outDir).sort()).toStrictEqual(Object.keys(schemas).sort());
  });

  it('covers every logged command of the world registry and the sim time commands, and no unlogged one', () => {
    const logged = createWorldRegistry()
      .list()
      .filter((def) => def.logged !== false)
      .map((def) => def.id);
    const ids = Object.keys(schemas).map((file) => file.replace(/\.args\.schema\.json$/, ''));
    expect(ids).toStrictEqual([...logged, 'sim.resume', 'sim.setSpeed', 'sim.step'].sort());
    expect(ids).toContain('lead.connect');
    expect(ids).toContain('lead.disconnect');
    expect(ids).toContain('device.operate');
    expect(ids).not.toContain('palette.open');
  });

  it('every object property is required (as logged) and unknown keys are refused', () => {
    for (const [file, schema] of Object.entries(schemas)) {
      walk(schema, (node, path) => {
        if (node['type'] !== 'object' || typeof node['properties'] !== 'object') return;
        const keys = Object.keys(node['properties'] as Node).sort();
        expect([...((node['required'] as string[]) ?? [])].sort(), `${file} ${path}`).toStrictEqual(keys);
        expect(node['additionalProperties'], `${file} ${path}`).toBe(false);
      });
    }
  });

  it('pins sim.step’s bound and sim.setSpeed’s speeds', () => {
    const step = (schemas['sim.step.args.schema.json']['properties'] as Record<string, Node>)['ticks'];
    expect(step).toMatchObject({ type: 'integer', minimum: 1, maximum: 600_000, default: 1_000 });
    const speed = (schemas['sim.setSpeed.args.schema.json']['properties'] as Record<string, Node>)['speed'];
    expect(speed['enum']).toStrictEqual([0, 1, 10, 60]);
  });
});
