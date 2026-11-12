import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_CATALOG } from './builtin';

/*
 * A shipped `(id, version)` resolves in every later catalogue version and keeps its values (ADR 0016,
 * save-format-guardian's review). `fixtures/shipped/<release>.json` freezes what each release shipped,
 * taken from its git tag and never regenerated; a release appends its own file (0.4.0 adds its
 * entries, its table versions and its colour ids). For every shipped document this checks that it
 * still resolves and that its values are unchanged:
 *
 * - entries may only **gain** data: the fields a later format added are dropped before comparing
 *   (catalogue v2: `mounts`, `enclosure`, `conductor`, `terminals[].methods`), and so are sources the
 *   entry gained;
 * - prose may be corrected in place (`title`, a source's `citation`): only people read it, and it is in
 *   no hash; every shipped source keeps its id, kind and covers;
 * - a shipped table version keeps every row and value (prose masked the same way); colour ids are
 *   checked against the newest colour table, which must hold them all.
 */

interface Source {
  id: string;
  kind: string;
  citation: string;
  covers: string[];
}
type Doc = Record<string, unknown> & { id: string; version: number; sources: Source[] };
interface TableDoc {
  table: string;
  version: number;
  title: string;
  rows: Record<string, Record<string, unknown>>;
  sources: Source[];
}
interface Shipped {
  release: string;
  tag: string;
  catalogVersion: number;
  devices: Doc[];
  tables: TableDoc[];
}

const dir = join(import.meta.dirname, '../../fixtures/shipped');
const releases: Shipped[] = readdirSync(dir)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Shipped);

/** Fields catalogue format v2 added to a device entry: a shipped v1 entry may gain them. */
const V2_DEVICE_FIELDS = ['mounts', 'enclosure', 'conductor'];

/** A copy of `record` without `keys`. */
const without = (record: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));

/** The comparable values of a device entry: added fields, prose and gained sources removed. */
function deviceValues(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (V2_DEVICE_FIELDS.includes(key) || key === 'title' || key === 'sources') continue;
    out[key] =
      key === 'terminals'
        ? (value as Record<string, unknown>[]).map((terminal) => without(terminal, ['methods']))
        : value;
  }
  return out;
}

/** Table rows with their prose (`name`, `material`) masked. */
const rowValues = (rows: Record<string, Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, without(row, ['name', 'material'])]));

const sourceKey = ({ id, kind, covers }: Source) => ({ id, kind, covers });

describe('shipped catalogue documents', () => {
  it('has a frozen list for every release that shipped a catalogue (0.3.0 onwards)', () => {
    expect(releases.map((r) => r.release)).toContain('0.3.0');
    const v030 = releases.find((r) => r.release === '0.3.0');
    expect(v030?.catalogVersion).toBe(1);
    expect(v030?.devices).toHaveLength(13);
  });

  const devices = releases.flatMap((r) =>
    r.devices.map((doc) => [`${r.release} ${doc.id}@${doc.version}`, doc] as const),
  );

  it.each(devices)('%s still resolves, with its values unchanged', (_name, shipped) => {
    const current = BUILTIN_CATALOG.device({ id: shipped.id, version: shipped.version });
    expect(current).toBeDefined();
    const now = current as unknown as Doc;
    expect(deviceValues(now)).toStrictEqual(deviceValues(shipped));
    // Every shipped source keeps its id, kind and covers (its citation is prose); new sources may join.
    const nowSources = new Map(now.sources.map((s) => [s.id, sourceKey(s)]));
    for (const source of shipped.sources) expect(nowSources.get(source.id), source.id).toStrictEqual(sourceKey(source));
  });

  const tables = releases.flatMap((r) => r.tables.map((t) => [`${r.release} ${t.table}@${t.version}`, t] as const));

  it('every shipped table version still resolves, with every row and value unchanged', () => {
    for (const [name, shipped] of tables) {
      const current = BUILTIN_CATALOG.table(shipped.table, shipped.version);
      expect(current, name).toBeDefined();
      expect(rowValues(current?.rows ?? {}), name).toStrictEqual(rowValues(shipped.rows));
      const nowSources = new Map((current?.sources ?? []).map((s) => [s.id, sourceKey(s)]));
      for (const source of shipped.sources) expect(nowSources.get(source.id), name).toStrictEqual(sourceKey(source));
      if (shipped.table === 'colours') {
        for (const id of Object.keys(shipped.rows)) expect(BUILTIN_CATALOG.colourIds, name).toContain(id);
      }
    }
  });

  it('the comparison ignores only added fields and prose: a changed value would fail', () => {
    const shipped = devices[0][1];
    const changed = structuredClone(shipped) as Doc & { model: { params: Record<string, number> } };
    const [param] = Object.keys(changed.model.params);
    if (param !== undefined) changed.model.params[param] += 1;
    else changed.version += 1;
    expect(deviceValues(changed)).not.toStrictEqual(deviceValues(shipped));
    const retitled = { ...structuredClone(shipped), title: 'Renamed', mounts: [] };
    expect(deviceValues(retitled)).toStrictEqual(deviceValues(shipped));
  });
});
