import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandArgJsonSchemas } from './command-args-schema';
import { createWorldRegistry } from './session';
import { sha256, toHex } from './sha256';

/*
 * Every logged command's arguments are save format (ADR 0007, ADR 0011 §12, ADR 0013). The JSON
 * Schema files in libs/domain/world-model/json-schema/command-args/ freeze them: if this test fails,
 * an argument shape changed. That needs a `schemaVersion` bump and a replay-log migration unless only
 * a `.meta()` hint changed; then regenerate with `pnpm nx test world-model -u` and commit the files.
 */

const outDir = join(import.meta.dirname, '../../json-schema/command-args');
const utf8 = (text: string) => new TextEncoder().encode(text);

/** Form-hint keywords (`.meta()`): never acceptance, so stripped before an acceptance pin. */
const HINT_KEYWORDS = new Set(['title', 'description', 'x-controls-ref', 'x-controls-options']);

/** A copy of a JSON Schema without hint keywords (property and `$defs` names are kept). */
function stripHints(node: unknown, names = false): unknown {
  if (Array.isArray(node)) return node.map((item) => stripHints(item));
  if (typeof node !== 'object' || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!names && HINT_KEYWORDS.has(key)) continue;
    out[key] = stripHints(value, !names && (key === 'properties' || key === '$defs'));
  }
  return out;
}

/** The world v4 commands (P4 PR 8): frozen files, not yet in a release. */
const WORLD_V4_FILES = [
  'device.press.args.schema.json',
  'panel.directory.args.schema.json',
  'plug.insert.args.schema.json',
  'plug.remove.args.schema.json',
  'wire.mark.args.schema.json',
];

/** SHA-256 of each P3 schema's hint-stripped JSON (as of v0.4.0; `JSON.stringify` in the generated key order). */
const P3_ACCEPTANCE_PINS: Record<string, string> = {
  'cable.add.args.schema.json': 'a69e0112bd5321e9d943337c257f0d97e5541f40e70635fa6496cb81b87bb7c8',
  'cable.delete.args.schema.json': '458f4b5c8b5bef8164806f8c9947358afe305159644e89e14d0d6e27df6886e5',
  'cable.label.args.schema.json': '992cfa5cab76263f281c9f8b91799d2b02f060b77a2ba205fa9a47c6627cafe9',
  'cable.reroute.args.schema.json': 'bab2e3d6a9b748225d9c1371bfe7f779746679ae3aa73c63a612a661a92180eb',
  'cable.strip.args.schema.json': '49562b222c46d999611eb152e871dfe5934da43a24ba84467b31ac755958a887',
  'device.operate.args.schema.json': '850f2cb2e9e464f62ada1a543ab1b4a93844685dbd425d58c604668946418ede',
  'edit.redo.args.schema.json': '25c7d85c859a6f78f6f4e83edf2d3073645b7c71d2832348387882a6833b1834',
  'edit.undo.args.schema.json': '25c7d85c859a6f78f6f4e83edf2d3073645b7c71d2832348387882a6833b1834',
  'enclosure.openEntry.args.schema.json': '4142d925401e42a7ed98bce8298efc27025a38fe014e9b528cb5ef3ad5d61658',
  'entity.delete.args.schema.json': '458f4b5c8b5bef8164806f8c9947358afe305159644e89e14d0d6e27df6886e5',
  'entity.label.args.schema.json': '992cfa5cab76263f281c9f8b91799d2b02f060b77a2ba205fa9a47c6627cafe9',
  'entity.move.args.schema.json': 'd83047ed44b315286626afcabfa470fb3b2e1433550e8625b1d1bc917aba0071',
  'entity.place.args.schema.json': 'be050116375a3778c0f9262de1d352d3c07817c0a4259b5aee2907ae7625f600',
  'entity.rotate.args.schema.json': '45ad67da0244a6b785bb7e6fd6264dd8ddcc0857a35cb0078a506b9993056e55',
  'lead.connect.args.schema.json': '0fd2015569c9228c7f358df166c2efb988a043ee2baa2d6742eac9a6cc80e181',
  'lead.disconnect.args.schema.json': '458f4b5c8b5bef8164806f8c9947358afe305159644e89e14d0d6e27df6886e5',
  'raceway.cut.args.schema.json': '244294a336de0ce9adfdca62091395584e82c031002caf3df22f38e2cdcd567a',
  'sim.resume.args.schema.json': '25c7d85c859a6f78f6f4e83edf2d3073645b7c71d2832348387882a6833b1834',
  'sim.setSpeed.args.schema.json': 'a07678cb389f64c733c9fe141b598d8c91c343d8337387ee772ec6ecd1aa42ca',
  'sim.step.args.schema.json': '21d9b1e68874da59e498bac7696aaedff3eec0456f2eadcda5c9c477a5d444b9',
  'toolbelt.select.args.schema.json': '47541d8c452e2816fc0e7f3c16833ec96af6153de242bb533c9f67be3b295d8c',
  'view.focus.args.schema.json': '9eb5a7b1bc02f8538ba6127e4278de89187efc0437c5022538aacd5dc5091c37',
  'view.mode.args.schema.json': '9debc1768b84e859c62623ca3211cd0e2ab62890cb811c635bb3b869d51d753e',
  'view.overlay.args.schema.json': 'ec5725558393510bb945b98b827db746a3ddf57d9f0dc4a4ca4ad7467390e7fc',
  'view.resetLayout.args.schema.json': '25c7d85c859a6f78f6f4e83edf2d3073645b7c71d2832348387882a6833b1834',
  'wire.add.args.schema.json': 'ead4a7ad65002c69e84e569cd1337434bc6a568d0f7f4da28aa709d523e58cb0',
  'wire.delete.args.schema.json': '458f4b5c8b5bef8164806f8c9947358afe305159644e89e14d0d6e27df6886e5',
  'wire.label.args.schema.json': '992cfa5cab76263f281c9f8b91799d2b02f060b77a2ba205fa9a47c6627cafe9',
  'wire.land.args.schema.json': '6e7fecb2e18eece38b48a787c5ba203c7fe38357582929ab7c501b1d18683166',
  'wire.pull.args.schema.json': '84ed9cf1f4996539545dae11a5d4f71993a749a0ea7a9a5c14e36e9f86de1397',
  'wire.reroute.args.schema.json': 'bab2e3d6a9b748225d9c1371bfe7f779746679ae3aa73c63a612a661a92180eb',
  'wire.unland.args.schema.json': 'c3cb204987e8f49691e06a9f18f092e7b4d1d9440f65c19a96c899eeb4da3613',
};
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
    expect(ids).toStrictEqual([...logged].sort());
    // The sim time commands are registered (F2.3a), so the registry's list covers them.
    expect(logged).toEqual(expect.arrayContaining(['sim.resume', 'sim.setSpeed', 'sim.step']));
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

  it('lead.connect and lead.disconnect are byte for byte what v0.3.0 shipped (P3 phase acceptance: test leads stay)', () => {
    // SHA-256 of the files at the v0.3.0 tag (unchanged since P2's #42). A world v3 change that
    // regenerated them with -u would fail here, not only in review.
    const pinned: Record<string, string> = {
      'lead.connect.args.schema.json': '21be55f69dc715075b02cf55de56904f12a80fb09e37e2bb82025c7cdb662736',
      'lead.disconnect.args.schema.json': '9a4a11c89b7d034e2f3eab67182517af089553549b5edcc39cc20d77c8004254',
    };
    for (const [file, hash] of Object.entries(pinned)) {
      expect(toHex(sha256(new Uint8Array(readFileSync(join(outDir, file))))), file).toBe(hash);
      expect(`${JSON.stringify(schemas[file], null, 2)}\n`, file).toBe(readFileSync(join(outDir, file), 'utf8'));
    }
  });

  it('every P3 argument schema accepts exactly what v0.4.0 shipped (hint-stripped SHA-256 pins, ADR 0019)', () => {
    // A `.meta()` hint (title, description, x-controls-*) may change without a bump, so the pins hash
    // a hint-stripped copy; any acceptance change fails here. World v4's five new schemas
    // join this list when v0.5.0 ships.
    const actual = Object.fromEntries(
      Object.keys(P3_ACCEPTANCE_PINS).map((file) => [
        file,
        toHex(sha256(utf8(JSON.stringify(stripHints(schemas[file]))))),
      ]),
    );
    expect(actual).toStrictEqual(P3_ACCEPTANCE_PINS);
    // Every logged P3 command is pinned; the world v4 ones are the only others.
    expect(Object.keys(schemas).filter((f) => !(f in P3_ACCEPTANCE_PINS))).toStrictEqual(WORLD_V4_FILES);
  });

  it('pins sim.step’s bound and sim.setSpeed’s speeds', () => {
    const step = (schemas['sim.step.args.schema.json']['properties'] as Record<string, Node>)['ticks'];
    expect(step).toMatchObject({ type: 'integer', minimum: 1, maximum: 600_000, default: 1_000 });
    const speed = (schemas['sim.setSpeed.args.schema.json']['properties'] as Record<string, Node>)['speed'];
    expect(speed['enum']).toStrictEqual([0, 1, 10, 60]);
  });
});
