import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { BUILTIN_CATALOG, CATALOG_VERSION } from './builtin';
import { BUILTIN_ACCESSORY_DOCUMENTS } from './builtin-accessories.generated';
import { BUILTIN_CABLE_DOCUMENTS } from './builtin-cables.generated';
import { BUILTIN_DEVICE_DOCUMENTS } from './builtin-devices.generated';
import { BUILTIN_TABLE_DOCUMENTS } from './builtin-tables.generated';
import { BUILTIN_TOOL_DOCUMENTS } from './builtin-tools.generated';
import type { Catalog } from './catalog';

/*
 * A shipped `(id, version)` resolves in every later catalogue version and keeps its values (ADR 0016,
 * save-format-guardian's review). `fixtures/shipped/<release>.json` freezes what each release shipped:
 * written once at release time by `pnpm catalog:freeze` (tools/freeze-shipped-catalogue.mjs) from the
 * catalogue at the release commit, and never regenerated. Every release `CHANGELOG.md` lists, from
 * 0.3.0 (the first to ship a catalogue) on, must have one, and no other release may. For every shipped
 * document this checks that it still resolves and that its values are unchanged:
 *
 * - entries may only **gain** data, and **only the fields the shipped release's own catalogue format
 *   lacked** are dropped before comparing (ADR 0018 §8, masked by the release's `catalogVersion`, never
 *   globally): a catalogue-1 release (0.3.0) lacked v2's `mounts`, `enclosure`, `conductor` and
 *   `terminals[].methods`, and its `lead` entries lacked the six thermal params F3.6 part 1 and the two
 *   failure params F3.6 part 2 added at entry version 1. A catalogue-2 or later release masks no field,
 *   so 0.4.0's own method specs, drives and §8 fields are locked;
 * - prose may be corrected in place (`title`, a source's `citation`): only people read it, and it is in
 *   no hash; every shipped source keeps its id, kind and covers, and sources may be added;
 * - a shipped table version keeps every row and value (prose masked the same way); colour ids are
 *   checked against the newest colour table, which must hold them all;
 * - shipped tools, cables and accessories (catalogue 2 onwards; saves pin cables by `CableV3.ref` and
 *   accessories by `TerminationV3.accessory.ref`) keep every value but their prose. A catalogue-2 or
 *   later list must carry all three families (possibly empty); a catalogue-1 list holds none, because
 *   catalogue 1 had none.
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
  /** Cable assemblies (catalogue 2 onwards). */
  cables?: Doc[];
  /** Accessories: ferrules and lugs (catalogue 2 onwards). */
  accessories?: Doc[];
}

/** The families a catalogue-2 or later frozen list carries besides devices and tables; catalogue 1 had none. */
const V2_FAMILIES = ['tools', 'cables', 'accessories'] as const;
type V2Family = (typeof V2_FAMILIES)[number];

/** The first release that shipped a catalogue (0.1.0 and 0.2.0 had none). */
const FIRST_CATALOGUE_RELEASE = '0.3.0';

const dir = join(import.meta.dirname, '../../fixtures/shipped');
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.json'))
  .sort();
const releases: Shipped[] = files.map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Shipped);

/**
 * The released versions, from `CHANGELOG.md`'s `## [x.y.z] - YYYY-MM-DD` headings. The changelog is in
 * the repository, so this needs no tags, network or full clone (CI checks out one commit, without
 * tags), and version-keeper rolls `[Unreleased]` into the dated section in the release commit itself:
 * a version becomes required exactly when its release is prepared, never before.
 */
function releasedVersions(changelog: string): string[] {
  return [...changelog.matchAll(/^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}/gm)].map((match) => match[1]);
}

/** `a` − `b` on `major.minor.patch` (a pre-release suffix is ignored). */
function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('-')[0].split('.').map(Number);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

const changelog = readFileSync(join(import.meta.dirname, '../../../../../CHANGELOG.md'), 'utf8');
const mustBeFrozen = releasedVersions(changelog)
  .filter((v) => compareVersions(v, FIRST_CATALOGUE_RELEASE) >= 0)
  .sort(compareVersions);

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

/**
 * A tool's, cable's or accessory's comparable values: prose (`title`) and sources removed, nothing else
 * (all three families are catalogue 2, so no release lacked any of their fields).
 */
const entryValues = (doc: Record<string, unknown>) => without(doc, ['title', 'sources']);

/** Table rows with their prose (`name`, `material`) masked. */
const rowValues = (rows: Record<string, Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, without(row, ['name', 'material'])]));

const sourceKey = ({ id, kind, covers }: Source) => ({ id, kind, covers });

/** What the checks read from a catalogue (the built-in one, or a stand-in in the self-tests). */
type Lookup = Pick<Catalog, 'device' | 'tool' | 'cable' | 'accessory' | 'table' | 'colourIds'>;

/** Every shipped source keeps its id, kind and covers (its citation is prose); new sources may join. */
function sourceProblems(now: readonly Source[], shipped: readonly Source[], name: string): string[] {
  const nowSources = new Map(now.map((s) => [s.id, sourceKey(s)]));
  return shipped
    .filter((source) => !isDeepStrictEqual(nowSources.get(source.id), sourceKey(source)))
    .map((source) => `${name}: source ${source.id} lost or changed its id, kind or covers`);
}

/** The keys whose values differ between two comparable records (for a readable failure). */
const changedKeys = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => !isDeepStrictEqual(a[key], b[key]));

/** One shipped entry against what the catalogue holds now under the same `(id, version)`. */
function entryProblems(
  name: string,
  shipped: Doc,
  current: Doc | undefined,
  values: (doc: Record<string, unknown>) => Record<string, unknown>,
): string[] {
  if (current === undefined) return [`${name}: no longer resolves`];
  const changed = changedKeys(values(current), values(shipped));
  return [
    ...(changed.length > 0 ? [`${name}: values changed (${changed.join(', ')})`] : []),
    ...sourceProblems(current.sources, shipped.sources, name),
  ];
}

/** The family rules: catalogue 2 on carries every family (possibly empty), catalogue 1 holds none. */
function shapeProblems(release: Shipped): string[] {
  return V2_FAMILIES.flatMap((family) => {
    const list = release[family];
    if (release.catalogVersion >= 2 && !Array.isArray(list)) {
      return [`${release.release}: a catalogue-${release.catalogVersion} list needs "${family}" (an array)`];
    }
    if (release.catalogVersion < 2 && list !== undefined && list.length > 0) {
      return [`${release.release}: catalogue 1 had no ${family}, but the list holds some`];
    }
    return [];
  });
}

const familyLookup: Record<V2Family, (catalog: Lookup, doc: Doc) => unknown> = {
  tools: (catalog, doc) => catalog.tool({ id: doc.id, version: doc.version }),
  cables: (catalog, doc) => catalog.cable({ id: doc.id, version: doc.version }),
  accessories: (catalog, doc) => catalog.accessory({ id: doc.id, version: doc.version }),
};

/** Every way `catalog` breaks the frozen list `release` (empty when it keeps it). */
function releaseProblems(release: Shipped, catalog: Lookup): string[] {
  const problems = shapeProblems(release);
  for (const doc of release.devices) {
    const current = catalog.device({ id: doc.id, version: doc.version }) as unknown as Doc | undefined;
    problems.push(
      ...entryProblems(`${release.release} ${doc.id}@${doc.version}`, doc, current, (d) =>
        deviceValues(d, release.catalogVersion),
      ),
    );
  }
  for (const family of V2_FAMILIES) {
    for (const doc of release[family] ?? []) {
      const current = familyLookup[family](catalog, doc) as Doc | undefined;
      problems.push(...entryProblems(`${release.release} ${doc.id}@${doc.version}`, doc, current, entryValues));
    }
  }
  for (const shipped of release.tables) {
    const name = `${release.release} ${shipped.table}@${shipped.version}`;
    const current = catalog.table(shipped.table, shipped.version);
    if (current === undefined) {
      problems.push(`${name}: no longer resolves`);
      continue;
    }
    const changed = changedKeys(rowValues(current.rows as TableDoc['rows']), rowValues(shipped.rows));
    if (changed.length > 0) problems.push(`${name}: rows changed (${changed.join(', ')})`);
    problems.push(...sourceProblems(current.sources as Source[], shipped.sources, name));
    if (shipped.table === 'colours') {
      for (const id of Object.keys(shipped.rows)) {
        if (!catalog.colourIds.includes(id)) problems.push(`${name}: colour id ${id} dropped`);
      }
    }
  }
  return problems;
}

/**
 * A frozen list of the current catalogue, as `pnpm catalog:freeze` writes it: the `content/` files in
 * name order, which the mirrors are (content-mirrors.spec.ts).
 */
const freezeNow = (release: string): Shipped => ({
  release,
  tag: `v${release}`,
  catalogVersion: CATALOG_VERSION,
  devices: structuredClone(BUILTIN_DEVICE_DOCUMENTS) as unknown as Doc[],
  tables: structuredClone(BUILTIN_TABLE_DOCUMENTS) as unknown as TableDoc[],
  tools: structuredClone(BUILTIN_TOOL_DOCUMENTS) as unknown as Doc[],
  cables: structuredClone(BUILTIN_CABLE_DOCUMENTS) as unknown as Doc[],
  accessories: structuredClone(BUILTIN_ACCESSORY_DOCUMENTS) as unknown as Doc[],
});

describe('shipped catalogue documents', () => {
  it('has a frozen list for exactly the releases CHANGELOG.md lists, from 0.3.0 on', () => {
    expect(mustBeFrozen).toContain('0.3.0');
    expect(releases.map((r) => r.release).sort(compareVersions)).toStrictEqual(mustBeFrozen);
  });

  it('names each list after its release and tag, with a catalogue version that never goes back', () => {
    releases.forEach((release, i) => {
      expect(files[i]).toBe(`${release.release}.json`);
      expect(release.tag).toBe(`v${release.release}`);
      expect(release.catalogVersion).toBeLessThanOrEqual(CATALOG_VERSION);
    });
    const ordered = [...releases].sort((a, b) => compareVersions(a.release, b.release));
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i].catalogVersion).toBeGreaterThanOrEqual(ordered[i - 1].catalogVersion);
    }
  });

  it('0.3.0 froze catalogue 1: thirteen devices and no other family', () => {
    const v030 = releases.find((r) => r.release === '0.3.0');
    expect(v030?.catalogVersion).toBe(1);
    expect(v030?.devices).toHaveLength(13);
    expect(v030?.tables).toHaveLength(0);
    for (const family of V2_FAMILIES) expect(v030?.[family] ?? []).toHaveLength(0);
  });

  it.each(releases.map((r) => [r.release, r] as const))(
    '%s: every shipped document still resolves, with its values unchanged',
    (_, release) => {
      expect(releaseProblems(release, BUILTIN_CATALOG)).toStrictEqual([]);
    },
  );

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
      expect(entryValues({ ...structuredClone(tool), title: 'Renamed' })).toStrictEqual(entryValues(tool));
      expect(entryValues({ ...structuredClone(tool), version: tool.version + 1 })).not.toStrictEqual(entryValues(tool));
    });
  });

  describe('cables and accessories are frozen too (self-tests)', () => {
    /** The built-in catalogue, but holding `docs` as its `family`. */
    const catalogWith = (family: 'cables' | 'accessories', docs: readonly Doc[]): Lookup => {
      const find = (ref: { id: string; version: number }) =>
        docs.find((d) => d.id === ref.id && d.version === ref.version) as never;
      return {
        device: (ref) => BUILTIN_CATALOG.device(ref),
        tool: (ref) => BUILTIN_CATALOG.tool(ref),
        cable: (ref) => (family === 'cables' ? find(ref) : BUILTIN_CATALOG.cable(ref)),
        accessory: (ref) => (family === 'accessories' ? find(ref) : BUILTIN_CATALOG.accessory(ref)),
        table: (name, version) => BUILTIN_CATALOG.table(name, version),
        colourIds: BUILTIN_CATALOG.colourIds,
      };
    };
    const frozen = freezeNow('9.9.9');

    it('a list frozen from the current catalogue (what `pnpm catalog:freeze` writes) passes', () => {
      expect(frozen.cables?.length).toBeGreaterThan(0);
      expect(frozen.accessories?.length).toBeGreaterThan(0);
      expect(releaseProblems(frozen, BUILTIN_CATALOG)).toStrictEqual([]);
    });

    describe.each(['cables', 'accessories'] as const)('%s', (family) => {
      const shipped = frozen[family] as Doc[];
      const first = shipped[0];

      it('changing any shipped value fails; correcting its prose passes', () => {
        const fields = Object.keys(first).filter((key) => key !== 'title' && key !== 'sources');
        expect(fields.length).toBeGreaterThan(3);
        for (const field of fields) {
          const changed = shipped.map((d) =>
            d === first ? { ...structuredClone(d), [field]: { changed: field } } : d,
          );
          // A changed id or version no longer resolves; any other field resolves with a changed value.
          const expected =
            field === 'id' || field === 'version'
              ? `9.9.9 ${first.id}@${first.version}: no longer resolves`
              : `9.9.9 ${first.id}@${first.version}: values changed (${field})`;
          expect(releaseProblems(frozen, catalogWith(family, changed)), field).toStrictEqual([expected]);
        }
        const prose = shipped.map((d) => ({
          ...structuredClone(d),
          title: 'Renamed',
          sources: d.sources.map((s) => ({ ...s, citation: 'Reworded.' })),
        }));
        expect(releaseProblems(frozen, catalogWith(family, prose))).toStrictEqual([]);
      });

      it("changing a shipped source's covers fails", () => {
        const changed = shipped.map((d) =>
          d === first
            ? { ...structuredClone(d), sources: d.sources.map((s, i) => (i === 0 ? { ...s, covers: [] } : s)) }
            : d,
        );
        expect(releaseProblems(frozen, catalogWith(family, changed))).toHaveLength(1);
      });

      it('adding a new entry, or a new version of a shipped one, passes', () => {
        const added = [
          ...shipped,
          { ...structuredClone(first), version: first.version + 1, brand: 'Changed' },
          { ...structuredClone(first), id: `${first.id}-new` },
        ];
        expect(releaseProblems(frozen, catalogWith(family, added))).toStrictEqual([]);
      });

      it('removing a shipped entry fails', () => {
        expect(releaseProblems(frozen, catalogWith(family, shipped.slice(1)))).toStrictEqual([
          `9.9.9 ${first.id}@${first.version}: no longer resolves`,
        ]);
      });

      it('a catalogue-2 list without the family fails; a catalogue-1 list may lack it but not hold it', () => {
        expect(releaseProblems({ ...frozen, [family]: undefined }, BUILTIN_CATALOG)).toStrictEqual([
          `9.9.9: a catalogue-${CATALOG_VERSION} list needs "${family}" (an array)`,
        ]);
        const v1: Shipped = { release: '9.9.9', tag: 'v9.9.9', catalogVersion: 1, devices: [], tables: [] };
        expect(releaseProblems(v1, BUILTIN_CATALOG)).toStrictEqual([]);
        expect(releaseProblems({ ...v1, [family]: shipped }, BUILTIN_CATALOG)).toStrictEqual([
          `9.9.9: catalogue 1 had no ${family}, but the list holds some`,
        ]);
      });
    });
  });

  describe('the release list (self-tests)', () => {
    it('reads dated release headings only, never [Unreleased] or link definitions', () => {
      const sample = [
        '## [Unreleased]',
        '### Added',
        '## [0.4.0] - 2026-12-01',
        '## [0.3.0] - 2026-11-11',
        '[0.4.0]: https://example.invalid/compare/v0.3.0...v0.4.0',
      ].join('\n');
      expect(releasedVersions(sample)).toStrictEqual(['0.4.0', '0.3.0']);
    });

    it('orders versions numerically', () => {
      expect(['0.10.0', '0.3.0', '0.4.0', '1.0.0'].sort(compareVersions)).toStrictEqual([
        '0.3.0',
        '0.4.0',
        '0.10.0',
        '1.0.0',
      ]);
    });
  });
});
