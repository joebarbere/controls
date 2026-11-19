import { type Catalog, catalogOrThrow } from '@controls/catalog';
import { WIRING_TEST_CATALOG, WIRING_TEST_KINDS } from './wiring-catalog';

/*
 * TEST-ONLY entries of the real load-centre kinds (P4 PR 14a, ADR 0019's P4 PR 14 amendment):
 * `enclosure.loadCentre`, `bond.jumper`, `bond.groundBar` and `feed.mainLugs`, with a main breaker
 * (`breaker.plugOn2p` on `mainFeed`) and branch breakers (`breaker.plugOn1p`, `breaker.plugOn2p` on the
 * stabs). Shared by world-model's specs, save-format's v4 fixture check and sim-core's goldens until
 * PR 14 ships the real entries. Nothing here is a product; every value is `game-design: test` unless
 * its comment says otherwise.
 *
 * The load centre (`LOAD_CENTRE`, 20 spaces): every mount runs along +x with its front facing +z, so a
 * device placed with no rotation sits in the mount's frame.
 *
 * - two bus columns, `left` at y = 0 and `right` at y = 100, ten stabs each 25 mm apart (x = 0 … 225),
 *   legs `[busL1, busL2]`: each column alternates legs row by row, so row r is L1 for even r;
 * - spaces alternate columns row by row: space 2r + 1 is `left` stab r, space 2r + 2 `right` stab r, so
 *   spaces 1 and 2 are on L1, 3 and 4 on L2 (ADR 0019 deviation 6);
 * - `main` (`mainFeed`, at x = 300): host contacts `l1` → `busL1` and `l2` → `busL2`;
 * - `mbj` (at x = 400): `neutral` → `neutral` and `chassis` → `chassis`;
 * - `groundBar` (`groundBarKit`, at x = 450): `chassis` → `chassis`;
 * - terminals `busL1`, `busL2`, `chassis` (clip, no methods), `neutral` and `n1` … `n20` (land, role
 *   `grounded`, one screw each).
 *
 * The main breaker's magnetic band (2000–3000 A) is test data chosen above the fault currents of
 * sim-core's goldens, so only the branch breaker opens there; it is not a published 100 A curve.
 */

const at = (x: number, y = 0, z = 0) => ({ x, y, z });

/** A screw terminal method (the wiring test catalogue's: 14–10 AWG, R₀ 0.3 mΩ). */
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
  entryMm: at(10, 0, 5),
  exitAxis: '+z',
  clampType: 'bindingScrew',
  clampDepthMm: 10,
  contactOhm: 0.0003,
  heatPathWPerK: 0.026,
  hotSpotHeatCapacityJPerK: 1.1,
  multiConductor: null,
  combination: null,
};

type Role = 'grounded' | 'egc' | null;
interface TerminalDoc {
  readonly id: string;
  readonly label: string;
  readonly positionMm: { x: number; y: number; z: number };
  readonly methods: readonly unknown[];
  readonly role: Role;
  readonly side: null;
  readonly access: string;
}
const clip = (id: string, x = 0): TerminalDoc => ({
  id,
  label: id,
  positionMm: at(x),
  methods: [],
  role: null,
  side: null,
  access: 'clip',
});
const sealed = (id: string, x = 0): TerminalDoc => ({ ...clip(id, x), access: 'none' });
/** A breaker's line terminal: reached through its stab, but clip-reachable so a spec can feed it with a lead too. */
const line = clip;
const landed = (id: string, x = 0, role: Role = null): TerminalDoc => ({
  ...clip(id, x),
  methods: [screw],
  role,
  access: 'land',
});

const source = (covers: string[]) => [
  { id: 'test', kind: 'game-design', citation: 'game-design: test only (P4 PR 14a), never a product', covers },
];

function entry(
  id: string,
  kind: string,
  terminals: readonly TerminalDoc[],
  overrides: Record<string, unknown>,
  covers: string[],
  params: Record<string, number> = {},
): Record<string, unknown> {
  return {
    id,
    version: 1,
    title: 'Test load-centre part',
    brand: 'Testbrand',
    modelName: 'LC-1',
    category: 'protection',
    sizeMm: { widthMm: 20, heightMm: 40, depthMm: 20 },
    terminals,
    mounts: [],
    enclosure: null,
    hostMounts: [],
    outlets: [],
    plug: null,
    supersededBy: null,
    conductor: null,
    model: { kind, params },
    controls: [],
    ...overrides,
    sources: source([
      'sizeMm',
      'terminals',
      ...terminals.filter((t) => t.methods.length > 0).map((t) => `terminals.${t.id}.methods.screw`),
      ...Object.keys(params).map((p) => `model.params.${p}`),
      ...covers,
    ]),
    extensions: {},
  };
}

/** Load-centre spaces (20) and neutral-bar terminals (`n1` … `n20`) of {@link LOAD_CENTRE}. */
export const LOAD_CENTRE_SPACES = 20;
/** Stabs per bus column. */
export const LOAD_CENTRE_ROWS = 10;
/** The bus stab pitch (mm). */
export const STAB_PITCH_MM = 25;
/** The right column's offset across the bus (mm). */
export const RIGHT_COLUMN_Y = 100;
/** Where the single mounts sit along x (mm), in the load centre's frame. */
export const MAIN_X = 300;
export const MBJ_X = 400;
export const GROUND_BAR_X = 450;

/** Contact and pole resistances of the test entries (Ω). */
export const LC_STAB_OHM = 0.005;
export const LC_FEED_OHM = 0.0005;
export const LC_BOND_OHM = 0.002;
export const LC_BRANCH_POLE_OHM = 0.005;
export const LC_MAIN_POLE_OHM = 0.001;

const column = (id: string, y: number) => ({
  id,
  type: 'busStab',
  positionMm: at(0, y),
  axis: '+x',
  facing: '+z',
  extentMm: (LOAD_CENTRE_ROWS - 1) * STAB_PITCH_MM + 25,
  contacts: [],
  bus: { pitchMm: STAB_PITCH_MM, stabs: LOAD_CENTRE_ROWS, legs: ['busL1', 'busL2'] },
});
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
const knockout = (id: string, x: number) => ({
  id,
  type: 'knockout',
  tradeSize: '1/2',
  maxCables: 1,
  internalClamp: false,
  positionMm: at(x, 600, 50),
  axis: '+y',
});

const fit = (type: string, contacts: Record<string, unknown>[], widthMm = 20) => ({
  type,
  widthMm,
  crossMm: 0,
  alongMm: 0,
  contacts,
});
const contact = (id: string, terminal: string, host: string, contactOhm: number, positionOffset = 0) => ({
  id,
  terminal,
  host,
  positionOffset,
  contactOhm,
});
const contactCovers = (type: string, ids: string[]) => [
  `fits.${type}`,
  ...ids.map((id) => `fits.${type}.contacts.${id}.contactOhm`),
];

/** A plug-on breaker's parameters (the pre-audit's vetted 15–20 A values; the bands of other ratings are test data). */
function plugOn(ratedA: number, pickupMinA: number, pickupMaxA: number, poleOhm: number): Record<string, number> {
  return {
    ratedCurrentA: ratedA,
    thermalTimeConstantS: 60,
    ultimateTripRatio: 1.25,
    magneticPickupMinA: pickupMinA,
    magneticPickupMaxA: pickupMaxA,
    openingTimeMinMs: 8,
    openingTimeMaxMs: 20,
    contactResistanceOhm: poleOhm,
  };
}

const ref = (id: string) => ({ id, version: 1 });

/** Refs into {@link LOAD_CENTRE_DOCUMENTS}. */
export const LOAD_CENTRE_REFS = {
  loadCentre: ref('panel.test-lc-20'),
  main: ref('breaker.test-lc-main-2p-100a'),
  mainLugs: ref('feed.test-lc-main-lugs'),
  mbj: ref('bond.test-lc-mbj-screw'),
  groundBar: ref('bond.test-lc-ground-bar-10'),
  branch20: ref('breaker.test-lc-1p-20a'),
  branch2p30: ref('breaker.test-lc-2p-30a'),
} as const;

const N_TERMINALS = Array.from({ length: LOAD_CENTRE_SPACES }, (_, i) => landed(`n${i + 1}`, 10 * i, 'grounded'));
const G_TERMINALS = Array.from({ length: 10 }, (_, i) => landed(`g${i + 1}`, 10 * i, 'egc'));
const HANDLE = [{ id: 'on', label: 'Handle on', type: 'toggle' }];

/** The TEST-ONLY load-centre entries (see the file comment). */
export const LOAD_CENTRE_DOCUMENTS: readonly Record<string, unknown>[] = [
  entry(
    LOAD_CENTRE_REFS.loadCentre.id,
    'enclosure.loadCentre',
    [clip('busL1'), clip('busL2'), clip('chassis'), landed('neutral', 0, 'grounded'), ...N_TERMINALS],
    {
      category: 'enclosure',
      sizeMm: { widthMm: 500, heightMm: 600, depthMm: 100 },
      enclosure: {
        mounts: [
          column('left', 0),
          column('right', RIGHT_COLUMN_Y),
          single('main', 'mainFeed', MAIN_X, [
            { id: 'l1', terminal: 'busL1' },
            { id: 'l2', terminal: 'busL2' },
          ]),
          single('mbj', 'mbj', MBJ_X, [
            { id: 'neutral', terminal: 'neutral' },
            { id: 'chassis', terminal: 'chassis' },
          ]),
          single('groundBar', 'groundBarKit', GROUND_BAR_X, [{ id: 'chassis', terminal: 'chassis' }]),
        ],
        entries: [knockout('ko1', 100), knockout('ko2', 200)],
        interiorVolumeMm3: 30_000_000,
        markedVolumeMm3: null,
        material: 'steel',
        spaces: Array.from({ length: LOAD_CENTRE_SPACES }, (_, i) => ({
          mount: i % 2 === 0 ? 'left' : 'right',
          index: Math.floor(i / 2),
        })),
      },
      controls: [{ id: 'coverOn', label: 'Dead front', type: 'toggle' }],
    },
    ['mounts', 'entries', 'interiorVolumeMm3', 'material', 'spaces'],
  ),
  entry(
    LOAD_CENTRE_REFS.main.id,
    'breaker.plugOn2p',
    [landed('line1'), landed('line2', 20), sealed('load1'), sealed('load2', 20)],
    {
      mounts: [
        fit(
          'mainFeed',
          [contact('load1', 'load1', 'l1', LC_FEED_OHM), contact('load2', 'load2', 'l2', LC_FEED_OHM)],
          40,
        ),
      ],
      controls: HANDLE,
    },
    contactCovers('mainFeed', ['load1', 'load2']),
    plugOn(100, 2000, 3000, LC_MAIN_POLE_OHM),
  ),
  entry(
    LOAD_CENTRE_REFS.mainLugs.id,
    'feed.mainLugs',
    [landed('l1'), landed('l2', 20)],
    { mounts: [fit('mainFeed', [contact('l1', 'l1', 'l1', LC_FEED_OHM), contact('l2', 'l2', 'l2', LC_FEED_OHM)], 40)] },
    contactCovers('mainFeed', ['l1', 'l2']),
  ),
  entry(
    LOAD_CENTRE_REFS.mbj.id,
    'bond.jumper',
    [sealed('body')],
    {
      // Both contacts land on the one `body` terminal: the bond is their two resistances in series.
      mounts: [
        fit('mbj', [
          contact('chassis', 'body', 'chassis', LC_BOND_OHM),
          contact('neutral', 'body', 'neutral', LC_BOND_OHM),
        ]),
      ],
    },
    contactCovers('mbj', ['chassis', 'neutral']),
  ),
  entry(
    LOAD_CENTRE_REFS.groundBar.id,
    'bond.groundBar',
    [clip('bar'), ...G_TERMINALS],
    { mounts: [fit('groundBarKit', [contact('chassis', 'bar', 'chassis', LC_BOND_OHM)])] },
    contactCovers('groundBarKit', ['chassis']),
  ),
  entry(
    LOAD_CENTRE_REFS.branch20.id,
    'breaker.plugOn1p',
    [line('line'), landed('load', 10)],
    { mounts: [fit('busStab', [contact('line1', 'line', 'stab', LC_STAB_OHM)])], controls: HANDLE },
    contactCovers('busStab', ['line1']),
    plugOn(20, 240, 400, LC_BRANCH_POLE_OHM),
  ),
  entry(
    LOAD_CENTRE_REFS.branch2p30.id,
    'breaker.plugOn2p',
    [line('line1'), line('line2', 5), landed('load1', 10), landed('load2', 15)],
    {
      mounts: [
        fit('busStab', [
          contact('line1', 'line1', 'stab', LC_STAB_OHM),
          contact('line2', 'line2', 'stab', LC_STAB_OHM, 1),
        ]),
      ],
      controls: HANDLE,
    },
    contactCovers('busStab', ['line1', 'line2']),
    plugOn(30, 300, 500, LC_BRANCH_POLE_OHM),
  ),
];

/** The wiring test catalogue plus {@link LOAD_CENTRE_DOCUMENTS}, over the real kinds. */
export const LOAD_CENTRE_TEST_CATALOG: Catalog = catalogOrThrow(
  WIRING_TEST_CATALOG.version,
  {
    devices: [...WIRING_TEST_CATALOG.devices, ...LOAD_CENTRE_DOCUMENTS],
    cables: WIRING_TEST_CATALOG.cables,
    tools: WIRING_TEST_CATALOG.tools,
    accessories: WIRING_TEST_CATALOG.accessories,
    tables: WIRING_TEST_CATALOG.tables,
  },
  WIRING_TEST_KINDS,
);

/** The position (load-centre frame, the load centre at the origin unrotated) of a breaker in space `space` (1-based). */
export function spacePositionMm(space: number): { x: number; y: number; z: number } {
  const row = Math.floor((space - 1) / 2);
  return at(row * STAB_PITCH_MM, (space - 1) % 2 === 0 ? 0 : RIGHT_COLUMN_Y);
}

/** The bus mount of space `space` (1-based). */
export function spaceMount(space: number): 'left' | 'right' {
  return (space - 1) % 2 === 0 ? 'left' : 'right';
}
