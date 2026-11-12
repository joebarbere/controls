import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_CATALOG } from './builtin';

/*
 * A shipped `(id, version)` resolves in every later catalogue version and keeps its values (ADR 0016,
 * save-format-guardian's review). `fixtures/shipped/<release>.json` freezes what each release shipped,
 * taken from its git tag and never regenerated; a release appends its own file (0.4.0 adds its
 * entries, its table versions, its tools and its colour ids). For every shipped document this checks
 * that it still resolves and that its values are unchanged:
 *
 * - entries may only **gain** data, and **only the fields the shipped release's own catalogue format
 *   lacked** are dropped before comparing (ADR 0018 §8, masked by the release's `catalogVersion`, never
 *   globally): a catalogue-1 release (0.3.0) lacked v2's `mounts`, `enclosure`, `conductor` and
 *   `terminals[].methods`, and its `lead` entries lacked the six thermal params F3.6 part 1 and the two failure params F3.6 part 2 added at
 *   entry version 1. A catalogue-2 or later release masks no field, so 0.4.0's own method specs,
 *   drives and §8 fields are locked;
 * - prose may be corrected in place (`title`, a source's `citation`): only people read it, and it is in
 *   no hash; every shipped source keeps its id, kind and covers, and sources may be added;
 * - a shipped table version keeps every row and value (prose masked the same way); colour ids are
 *   checked against the newest colour table, which must hold them all;
 * - a shipped tool (from catalogue 2) keeps every value the same way.
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
  /** Tool entries (catalogue 2 onwards; a catalogue-1 release shipped none). */
  tools?: Doc[];
}

const dir = join(import.meta.dirname, '../../fixtures/shipped');
const releases: Shipped[] = readdirSync(dir)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Shipped);

/** Fields catalogue format v2 added to a device entry: a catalogue-1 release's entries lacked them. */
const V2_DEVICE_FIELDS = ['mounts', 'enclosure', 'conductor'];

/**
 * The thermal params F3.6 part 1 added to the `lead` kind at entry version 1 (D2, ADR 0018 §8), and the
 * two failure params F3.6 part 2 added (the melting point and the insulation rating, ADR 0018
 * implementation notes, F3.6 part 2): a catalogue-1 release's lead entries lacked exactly these. Any
 * other param stays strictly compared.
 */
const V2_LEAD_PARAMS = [
  'linearAlphaMaxK',
  'densityKgM3',
  'specificHeatJPerKgK',
  'insulationThicknessMm',
  'insulationConductivityWPerMK',
  'surfaceEmissivity',
  'meltingPointK',
  'insulationRatedTempK',
];

/** A copy of `record` without `keys`. */
const without = (record: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));

/**
 * The comparable values of a device entry, as a release of catalogue format `catalogVersion` shipped
 * it: prose and sources removed, and only the fields that format lacked.
 */
function deviceValues(doc: Record<string, unknown>, catalogVersion: number): Record<string, unknown> {
  const v1 = catalogVersion < 2;
  const lead = (doc['model'] as { kind?: unknown } | undefined)?.kind === 'lead';
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'title' || key === 'sources' || (v1 && V2_DEVICE_FIELDS.includes(key))) continue;
    if (v1 && key === 'terminals') {
      out[key] = (value as Record<string, unknown>[]).map((terminal) => without(terminal, ['methods']));
    } else if (v1 && lead && key === 'model') {
      const model = value as Record<string, unknown>;
      out[key] = { ...model, params: without(model['params'] as Record<string, unknown>, V2_LEAD_PARAMS) };
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** A tool's comparable values: prose (`title`) and sources removed, nothing else (tools are catalogue 2). */
const toolValues = (doc: Record<string, unknown>) => without(doc, ['title', 'sources']);

/** Table rows with their prose (`name`, `material`) masked. */
const rowValues = (rows: Record<string, Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, without(row, ['name', 'material'])]));

const sourceKey = ({ id, kind, covers }: Source) => ({ id, kind, covers });

/** Every shipped source keeps its id, kind and covers (its citation is prose); new sources may join. */
function expectSourcesKept(now: readonly Source[], shipped: readonly Source[], name: string): void {
  const nowSources = new Map(now.map((s) => [s.id, sourceKey(s)]));
  for (const source of shipped)
    expect(nowSources.get(source.id), `${name} ${source.id}`).toStrictEqual(sourceKey(source));
}

describe('shipped catalogue documents', () => {
  it('has a frozen list for every release that shipped a catalogue (0.3.0 onwards)', () => {
    expect(releases.map((r) => r.release)).toContain('0.3.0');
    const v030 = releases.find((r) => r.release === '0.3.0');
    expect(v030?.catalogVersion).toBe(1);
    expect(v030?.devices).toHaveLength(13);
    expect(v030?.tools ?? []).toHaveLength(0);
  });

  const devices = releases.flatMap((r) =>
    r.devices.map((doc) => [`${r.release} ${doc.id}@${doc.version}`, doc, r.catalogVersion] as const),
  );

  it.each(devices)('%s still resolves, with its values unchanged', (name, shipped, catalogVersion) => {
    const current = BUILTIN_CATALOG.device({ id: shipped.id, version: shipped.version });
    expect(current).toBeDefined();
    const now = current as unknown as Doc;
    expect(deviceValues(now, catalogVersion)).toStrictEqual(deviceValues(shipped, catalogVersion));
    expectSourcesKept(now.sources, shipped.sources, name);
  });

  const tools = releases.flatMap((r) =>
    (r.tools ?? []).map((doc) => [`${r.release} ${doc.id}@${doc.version}`, doc] as const),
  );

  it('every shipped tool still resolves, with its values unchanged', () => {
    for (const [name, shipped] of tools) {
      const current = BUILTIN_CATALOG.tool({ id: shipped.id, version: shipped.version }) as unknown as Doc | undefined;
      expect(current, name).toBeDefined();
      expect(toolValues(current as Doc), name).toStrictEqual(toolValues(shipped));
      expectSourcesKept((current as Doc).sources, shipped.sources, name);
    }
  });

  const tables = releases.flatMap((r) => r.tables.map((t) => [`${r.release} ${t.table}@${t.version}`, t] as const));

  it('every shipped table version still resolves, with every row and value unchanged', () => {
    for (const [name, shipped] of tables) {
      const current = BUILTIN_CATALOG.table(shipped.table, shipped.version);
      expect(current, name).toBeDefined();
      expect(rowValues(current?.rows ?? {}), name).toStrictEqual(rowValues(shipped.rows));
      expectSourcesKept(current?.sources ?? [], shipped.sources, name);
      if (shipped.table === 'colours') {
        for (const id of Object.keys(shipped.rows)) expect(BUILTIN_CATALOG.colourIds, name).toContain(id);
      }
    }
  });

  describe('the comparison masks only what the release lacked (self-tests)', () => {
    const v030 = releases.find((r) => r.release === '0.3.0') as Shipped;
    const shippedLead = v030.devices.find((d) => (d['model'] as { kind: string }).kind === 'lead') as Doc;
    type Model = { kind: string; params: Record<string, number> };
    const withParams = (doc: Doc, change: (params: Record<string, number>) => void): Doc => {
      const copy = structuredClone(doc) as Doc & { model: Model };
      change(copy.model.params);
      return copy;
    };
    const same = (a: Doc, b: Doc, catalogVersion: number) =>
      JSON.stringify(deviceValues(a, catalogVersion)) === JSON.stringify(deviceValues(b, catalogVersion));

    it('a changed existing lead param fails', () => {
      for (const param of Object.keys((shippedLead['model'] as Model).params)) {
        expect(
          same(
            withParams(shippedLead, (p) => (p[param] += 1)),
            shippedLead,
            1,
          ),
          param,
        ).toBe(false);
      }
    });

    it('adding one of the eight thermal and failure params to a catalogue-1 lead passes', () => {
      for (const param of V2_LEAD_PARAMS) {
        expect(
          same(
            withParams(shippedLead, (p) => (p[param] = 1)),
            shippedLead,
            1,
          ),
          param,
        ).toBe(true);
      }
    });

    it('adding any other param fails, on a lead and on any other entry', () => {
      expect(
        same(
          withParams(shippedLead, (p) => (p['gaugeAwg'] = 18)),
          shippedLead,
          1,
        ),
      ).toBe(false);
      const other = v030.devices.find((d) => (d['model'] as Model).kind !== 'lead') as Doc;
      expect(
        same(
          withParams(other, (p) => (p['linearAlphaMaxK'] = 473.15)),
          other,
          1,
        ),
      ).toBe(false);
    });

    it('a catalogue-1 release masks the v2 fields and prose only', () => {
      const shipped = v030.devices[0];
      const regained = { ...structuredClone(shipped), title: 'Renamed', mounts: [], enclosure: null, conductor: null };
      expect(same(regained, shipped, 1)).toBe(true);
      expect(same({ ...structuredClone(shipped), version: shipped.version + 1 }, shipped, 1)).toBe(false);
    });

    it('a catalogue-2 release masks no field: a changed method, §8 or drives field fails', () => {
      const breaker = BUILTIN_CATALOG.device({ id: 'breaker.saltmere-1p-15a', version: 1 }) as unknown as Doc;
      const shipped = structuredClone(breaker) as Doc & { terminals: { methods: Record<string, unknown>[] }[] };
      expect(same(shipped, shipped, 2)).toBe(true);
      const changes: ((m: Record<string, unknown>) => void)[] = [
        (m) => (m['torqueNm'] = (m['torqueNm'] as number) + 0.1),
        (m) => (m['contactOhm'] = (m['contactOhm'] as number) * 2),
        (m) => (m['heatPathWPerK'] = 0.03),
        (m) => (m['hotSpotHeatCapacityJPerK'] = 2),
        (m) => (m['clampDepthMm'] = 5),
        (m) => (m['drives'] = []),
      ];
      for (const change of changes) {
        const changed = structuredClone(shipped);
        change(changed.terminals[0].methods[0]);
        expect(same(changed, shipped, 2)).toBe(false);
      }
      const lead = BUILTIN_CATALOG.device({ id: 'lead.quillfern-test-1m', version: 1 }) as unknown as Doc;
      const leadChanged = withParams(lead, (p) => (p['surfaceEmissivity'] = 0.5));
      expect(same(leadChanged, lead, 2)).toBe(false);
      expect(same({ ...structuredClone(shipped), mounts: [] }, shipped, 2)).toBe(false);
    });

    it('a tool compares every value but its prose', () => {
      const tool = BUILTIN_CATALOG.tools[0] as unknown as Doc;
      expect(toolValues({ ...structuredClone(tool), title: 'Renamed' })).toStrictEqual(toolValues(tool));
      expect(toolValues({ ...structuredClone(tool), version: tool.version + 1 })).not.toStrictEqual(toolValues(tool));
    });
  });
});
