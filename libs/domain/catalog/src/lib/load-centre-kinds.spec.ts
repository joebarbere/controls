import { BUILTIN_CATALOG } from './builtin';
import { parseCatalog } from './catalog';
import { MODEL_KINDS } from './model-kinds';

/*
 * The load centre's kinds (P4 PR 14a, ADR 0019's P4 PR 14 amendment): `enclosure.loadCentre`,
 * `bond.jumper`, `bond.groundBar` and `feed.mainLugs`, their fixed terminals, families and terminal
 * rules, on TEST-ONLY entries (`game-design: test`; the real ones are PR 14's).
 */

const at = (x: number) => ({ x, y: 0, z: 0 });
const screw = {
  method: 'screw',
  ratedConductors: 1,
  maxConductors: 1,
  awgRange: { smallest: 14, largest: 10 },
  stranding: ['solid', 'stranded'],
  stripLengthMm: { nominal: 13, tolerance: 2 },
  torqueNm: 1.4,
  drives: ['slotted', 'phillips'],
  alRated: false,
  entryMm: { x: 10, y: 0, z: 5 },
  exitAxis: '+z',
  clampType: 'bindingScrew',
  clampDepthMm: 10,
  contactOhm: 0.0003,
  heatPathWPerK: 0.026,
  hotSpotHeatCapacityJPerK: 1.1,
  multiConductor: null,
  combination: null,
};
type T = { id: string; access: string; role: string | null; methods: unknown[] };
const clip = (id: string): T => ({ id, access: 'clip', role: null, methods: [] });
const land = (id: string, role: string | null): T => ({ id, access: 'land', role, methods: [screw] });
const terminalDoc = (t: T) => ({ label: t.id, positionMm: at(0), side: null, ...t });
const methodCovers = (ts: T[]) => ts.filter((t) => t.methods.length > 0).map((t) => `terminals.${t.id}.methods.screw`);

function entry(
  id: string,
  kind: string,
  terminals: T[],
  overrides: Record<string, unknown> = {},
  covers: string[] = [],
) {
  return {
    id,
    version: 1,
    title: 'Test',
    brand: 'Testbrand',
    modelName: 'T-1',
    category: 'protection',
    sizeMm: { widthMm: 20, heightMm: 20, depthMm: 20 },
    terminals: terminals.map(terminalDoc),
    mounts: [],
    enclosure: null,
    hostMounts: [],
    outlets: [],
    plug: null,
    supersededBy: null,
    conductor: null,
    model: { kind, params: {} },
    controls: [],
    ...overrides,
    sources: [
      {
        id: 'test',
        kind: 'game-design',
        citation: 'game-design: test',
        covers: ['sizeMm', 'terminals', ...methodCovers(terminals), ...covers],
      },
    ],
    extensions: {},
  };
}

const ns = (n: number) => Array.from({ length: n }, (_, i) => land(`n${i + 1}`, 'grounded'));
const LC_TERMINALS = (): T[] => [clip('busL1'), clip('busL2'), clip('chassis'), land('neutral', 'grounded'), ...ns(2)];

function loadCentre(terminals: T[] = LC_TERMINALS()) {
  const single = (id: string, type: string, x: number, contacts: { id: string; terminal: string }[]) => ({
    id,
    type,
    positionMm: at(x),
    axis: '+x',
    facing: '+z',
    extentMm: 0,
    contacts,
    bus: null,
  });
  return entry(
    'panel.test-lc',
    'enclosure.loadCentre',
    terminals,
    {
      category: 'enclosure',
      enclosure: {
        mounts: [
          {
            id: 'left',
            type: 'busStab',
            positionMm: at(0),
            axis: '+x',
            facing: '+z',
            extentMm: 50,
            contacts: [],
            bus: { pitchMm: 25, stabs: 2, legs: ['busL1', 'busL2'] },
          },
          single('main', 'mainFeed', 100, [
            { id: 'l1', terminal: 'busL1' },
            { id: 'l2', terminal: 'busL2' },
          ]),
          single('mbj', 'mbj', 200, [
            { id: 'neutral', terminal: 'neutral' },
            { id: 'chassis', terminal: 'chassis' },
          ]),
          single('groundBar', 'groundBarKit', 300, [{ id: 'chassis', terminal: 'chassis' }]),
        ],
        entries: [],
        interiorVolumeMm3: 1_000_000,
        markedVolumeMm3: null,
        material: 'steel',
        spaces: [
          { mount: 'left', index: 0 },
          { mount: 'left', index: 1 },
        ],
      },
      controls: [{ id: 'coverOn', label: 'Dead front', type: 'toggle' }],
    },
    ['mounts', 'interiorVolumeMm3', 'material', 'spaces'],
  );
}

const fit = (type: string, contacts: { id: string; terminal: string; host: string }[]) => ({
  type,
  widthMm: 20,
  crossMm: 0,
  alongMm: 0,
  contacts: contacts.map((c) => ({ ...c, positionOffset: 0, contactOhm: 0.002 })),
});
const fitCovers = (type: string, ids: string[]) => [
  `fits.${type}`,
  ...ids.map((id) => `fits.${type}.contacts.${id}.contactOhm`),
];

const jumper = () =>
  entry(
    'bond.test-mbj',
    'bond.jumper',
    [{ ...clip('body'), access: 'none' }],
    {
      mounts: [
        fit('mbj', [
          { id: 'chassis', terminal: 'body', host: 'chassis' },
          { id: 'neutral', terminal: 'body', host: 'neutral' },
        ]),
      ],
    },
    fitCovers('mbj', ['chassis', 'neutral']),
  );
const groundBar = (terminals: T[] = [clip('bar'), land('g1', 'egc'), land('g2', 'egc')]) =>
  entry(
    'bond.test-ground-bar',
    'bond.groundBar',
    terminals,
    { mounts: [fit('groundBarKit', [{ id: 'chassis', terminal: 'bar', host: 'chassis' }])] },
    fitCovers('groundBarKit', ['chassis']),
  );
const mainLugs = () =>
  entry(
    'feed.test-main-lugs',
    'feed.mainLugs',
    [land('l1', null), land('l2', null)],
    {
      mounts: [
        fit('mainFeed', [
          { id: 'l1', terminal: 'l1', host: 'l1' },
          { id: 'l2', terminal: 'l2', host: 'l2' },
        ]),
      ],
    },
    fitCovers('mainFeed', ['l1', 'l2']),
  );

const messages = (devices: unknown[]): string[] => {
  const result = parseCatalog(3, { devices, tables: BUILTIN_CATALOG.tables });
  return result.ok ? [] : result.issues.map((i) => `${i.path}: ${i.message}`);
};

describe('the load centre kinds (P4 PR 14a)', () => {
  it('fix their terminals, families and rules as ADR 0019’s P4 PR 14 amendment has them', () => {
    const summary = (kind: string) => {
      const k = MODEL_KINDS[kind];
      return {
        terminals: k.terminals,
        families: k.terminalFamilies ?? [],
        rules: k.terminalRules ?? {},
        keys: Object.keys(k.keys).length,
      };
    };
    expect(summary('enclosure.loadCentre')).toStrictEqual({
      terminals: ['busL1', 'busL2', 'chassis', 'neutral'],
      families: [{ prefix: 'n', min: 1, max: 64, rule: { access: 'land', role: 'grounded' } }],
      rules: {
        busL1: { access: 'clip' },
        busL2: { access: 'clip' },
        chassis: { access: 'clip' },
        neutral: { access: 'land', role: 'grounded' },
      },
      keys: 44,
    });
    expect(MODEL_KINDS['enclosure.loadCentre'].requires).toBe('enclosure');
    expect(summary('bond.jumper')).toStrictEqual({ terminals: ['body'], families: [], rules: {}, keys: 0 });
    expect(summary('bond.groundBar')).toStrictEqual({
      terminals: ['bar'],
      families: [{ prefix: 'g', min: 1, max: 32, rule: { access: 'land', role: 'egc' } }],
      rules: {},
      keys: 0,
    });
    expect(summary('feed.mainLugs')).toStrictEqual({ terminals: ['l1', 'l2'], families: [], rules: {}, keys: 0 });
  });

  it('accept valid entries, the jumper’s two contacts on one terminal included', () => {
    expect(messages([loadCentre(), jumper(), groundBar(), mainLugs()])).toStrictEqual([]);
  });

  it('refuse a bar terminal of the wrong access or role, and a family out of its range', () => {
    const swap = (id: string, t: T) => LC_TERMINALS().map((x) => (x.id === id ? t : x));
    expect(messages([loadCentre(swap('n1', land('n1', null)))]).join()).toContain(
      'enclosure.loadCentre\'s n1 has the role "grounded"',
    );
    expect(messages([loadCentre(swap('neutral', clip('neutral')))]).join()).toContain(
      'enclosure.loadCentre\'s neutral must be "land"',
    );
    expect(messages([loadCentre(swap('busL1', land('busL1', null)))]).join()).toContain(
      'enclosure.loadCentre\'s busL1 must be "clip"',
    );
    expect(messages([loadCentre(swap('chassis', { ...clip('chassis'), access: 'none' }))]).join()).toContain(
      'chassis must be "clip"',
    );
    // No neutral-bar terminal at all, or more than 64.
    expect(messages([loadCentre(LC_TERMINALS().filter((t) => !/^n\d/.test(t.id)))]).join()).toContain(
      'n1 … nn with n from 1 to 64',
    );
    const many = [...LC_TERMINALS().filter((t) => !/^n\d/.test(t.id)), ...ns(65)];
    expect(messages([loadCentre(many)]).join()).toContain('n1 … nn with n from 1 to 64');
    expect(messages([loadCentre([...LC_TERMINALS().filter((t) => !/^n\d/.test(t.id)), ...ns(64)])])).toStrictEqual([]);
    // A ground bar's g terminals land EGCs.
    expect(messages([groundBar([clip('bar'), land('g1', 'grounded')])]).join()).toContain(
      'bond.groundBar\'s g1 has the role "egc"',
    );
    expect(messages([groundBar([clip('bar')])]).join()).toContain('g1 … gn with n from 1 to 32');
  });

  it('terminalIds: the entry’s ids (families included), sorted by code unit and frozen, one array per entry', () => {
    const result = parseCatalog(3, { devices: [loadCentre(), groundBar()], tables: BUILTIN_CATALOG.tables });
    if (!result.ok) throw new Error('catalogue');
    const ref = { id: 'panel.test-lc', version: 1 };
    const ids = result.catalog.terminalIds(ref);
    expect(ids).toStrictEqual(['busL1', 'busL2', 'chassis', 'n1', 'n2', 'neutral']);
    expect(Object.isFrozen(ids)).toBe(true);
    expect(result.catalog.terminalIds(ref)).toBe(ids);
    expect(result.catalog.terminalIds({ id: 'panel.test-lc', version: 2 })).toBeUndefined();
    expect(BUILTIN_CATALOG.terminalIds({ id: 'switch.tessaline-spst-toggle', version: 1 })).toStrictEqual(['a', 'b']);
  });
});
