import {
  BUILTIN_CATALOG,
  type Catalog,
  catalogOrThrow,
  CONNECTION_SIM_KEYS,
  MODEL_KINDS,
  type ModelKindDef,
} from '@controls/catalog';
import { Int } from '@controls/save-format';
import * as z from 'zod';

/*
 * A TEST-ONLY catalogue for world v3's load check (P3 PR 7) and the wiring commands (P3 PR 8): the
 * built-in devices plus a synthetic conductor kind (14 AWG solid, 14 AWG stranded, 10 AWG solid and a
 * bare 14), a 1-gang box and a DIN panel (enclosure kinds), a DIN terminal block with spring-cage and
 * screw methods, a 14/2-with-ground cable assembly, a hand-tool set (cutter, stripper, screwdriver,
 * torque driver, hex nut driver, crimper, label maker, fish tape, knockout punch, drill bit), a ferrule and a ring
 * lug. Nothing here is a real product and every number is `game-design: test`; the real conductors,
 * cables, enclosures and tools arrive with F3.1, F3.4 and F3.5.
 */

const openEntries = {
  owner: 'commanded',
  type: 'number',
  schema: Int.min(0).max(0xffffffff),
  initial: 0,
  values: null,
  description: 'test',
} as const;

export const WIRING_TEST_KINDS: Readonly<Record<string, ModelKindDef>> = {
  ...MODEL_KINDS,
  'test.conductor': {
    kind: 'test.conductor',
    placement: 'connection',
    requires: 'conductor',
    terminals: [],
    params: z.strictObject({}),
    keys: CONNECTION_SIM_KEYS,
    description: 'test',
  },
  'test.box': {
    kind: 'test.box',
    placement: 'entity',
    requires: 'enclosure',
    terminals: ['ground'],
    params: z.strictObject({}),
    keys: { openEntries },
    description: 'test',
  },
  'test.block': {
    kind: 'test.block',
    placement: 'entity',
    terminals: ['1', '2'],
    params: z.strictObject({}),
    keys: {},
    description: 'test',
  },
  'test.panel': {
    kind: 'test.panel',
    placement: 'entity',
    requires: 'enclosure',
    terminals: [],
    params: z.strictObject({}),
    keys: { openEntries },
    description: 'test',
  },
};

const source = (covers: string[]) => [{ id: 'test', kind: 'game-design', citation: 'game-design: test', covers }];
const copper = { table: 'materials', version: 1, key: 'copperAnnealed' };
const thhn = { table: 'insulation', version: 1, key: 'thhnThwn2' };

const conductor = (id: string, insulated: boolean, awg = 14, stranding: 'solid' | 'stranded' = 'solid') => ({
  id,
  version: 1,
  title: 'Test conductor',
  brand: 'Testbrand',
  modelName: 'C-1',
  category: 'conductor',
  sizeMm: null,
  terminals: [],
  mounts: [],
  enclosure: null,
  conductor: {
    awg,
    stranding,
    strandCount: stranding === 'solid' ? 1 : 7,
    material: copper,
    insulation: insulated ? thhn : null,
    insulationThicknessMm: insulated ? 0.4 : null,
    jacketThicknessMm: insulated ? 0.1 : null,
    colours: insulated
      ? [
          { base: 'black', stripe: null },
          { base: 'white', stripe: null },
          { base: 'green', stripe: 'yellow' },
        ]
      : [{ base: 'bare', stripe: null }],
  },
  model: { kind: 'test.conductor', params: {} },
  controls: [],
  sources: source(['conductor']),
  extensions: {},
});

const screw = {
  method: 'screw',
  ratedConductors: 1,
  maxConductors: 2,
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
  combination: null,
};

/** ADR 0018 §8's spring-cage fields (test values: R₀ 0.3 mΩ, within BSS 128's 1.5 mΩ). */
const cageClamp = {
  clampType: 'springCage',
  clampDepthMm: 9,
  contactOhm: 0.0003,
  heatPathWPerK: 0.02,
  hotSpotHeatCapacityJPerK: 0.5,
  combination: null,
};

const box = {
  id: 'box.test-1gang',
  version: 1,
  title: 'Test box',
  brand: 'Testbrand',
  modelName: 'B-1',
  category: 'enclosure',
  sizeMm: { widthMm: 50, heightMm: 75, depthMm: 60 },
  terminals: [{ id: 'ground', label: 'GND', positionMm: { x: 10, y: 0, z: 5 }, methods: [screw] }],
  mounts: [{ type: 'studFlange', widthMm: 50 }],
  enclosure: {
    mounts: [
      { id: 'yoke', type: 'deviceYoke', positionMm: { x: 25, y: 37, z: 60 }, axis: '+x', facing: '+z', extentMm: 0 },
    ],
    entries: [
      {
        id: 'top',
        type: 'clamp',
        tradeSize: null,
        maxCables: 2,
        internalClamp: true,
        positionMm: { x: 25, y: 75, z: 30 },
        axis: '-y',
      },
      {
        id: 'ko1',
        type: 'knockout',
        tradeSize: '1/2',
        maxCables: 1,
        internalClamp: false,
        positionMm: { x: 25, y: 0, z: 30 },
        axis: '+y',
      },
    ],
    interiorVolumeMm3: 295000,
  },
  conductor: null,
  model: { kind: 'test.box', params: {} },
  controls: [],
  sources: source([
    'sizeMm',
    'terminals',
    'terminals.ground.methods.screw',
    'fits.studFlange',
    'mounts',
    'entries',
    'interiorVolumeMm3',
  ]),
  extensions: {},
};

/** A DIN terminal block: terminal 1 spring-cage only, terminal 2 screw first, then spring-cage, then twist-on (its combination check). */
const block = {
  id: 'tb.test-2',
  version: 1,
  title: 'Test terminal block',
  brand: 'Testbrand',
  modelName: 'T-2',
  category: 'switch',
  sizeMm: { widthMm: 20, heightMm: 60, depthMm: 45 },
  terminals: [
    {
      id: '1',
      label: '1',
      positionMm: { x: 5, y: 60, z: 30 },
      methods: [
        {
          method: 'springCage',
          ratedConductors: 1,
          maxConductors: 1,
          awgRange: { smallest: 24, largest: 12 },
          stranding: ['solid', 'strandedFerrule'],
          stripLengthMm: { nominal: 10, tolerance: 1 },
          torqueNm: null,
          drives: [],
          alRated: false,
          entryMm: { x: 5, y: 60, z: 30 },
          exitAxis: '+y',
          ...cageClamp,
        },
      ],
    },
    {
      id: '2',
      label: '2',
      positionMm: { x: 15, y: 60, z: 30 },
      methods: [
        {
          method: 'screw',
          ratedConductors: 1,
          maxConductors: 2,
          awgRange: { smallest: 22, largest: 10 },
          stranding: ['solid', 'stranded', 'strandedFerrule'],
          stripLengthMm: { nominal: 8, tolerance: 1 },
          torqueNm: 0.8,
          drives: ['slotted', 'phillips'],
          alRated: false,
          entryMm: { x: 15, y: 60, z: 30 },
          exitAxis: '+y',
          // A binding screw, so a bare stranded conductor splays (ADR 0018 §4.3).
          clampType: 'bindingScrew',
          clampDepthMm: 8,
          contactOhm: 0.0003,
          heatPathWPerK: 0.026,
          hotSpotHeatCapacityJPerK: 1.1,
          combination: null,
        },
        {
          method: 'springCage',
          ratedConductors: 1,
          maxConductors: 1,
          awgRange: { smallest: 24, largest: 12 },
          stranding: ['solid', 'strandedFerrule'],
          stripLengthMm: { nominal: 10, tolerance: 1 },
          torqueNm: null,
          drives: [],
          alRated: false,
          entryMm: { x: 15, y: 60, z: 40 },
          exitAxis: '+y',
          ...cageClamp,
        },
        {
          method: 'twistOn',
          ratedConductors: 3,
          maxConductors: 3,
          awgRange: { smallest: 18, largest: 12 },
          stranding: ['solid', 'stranded'],
          stripLengthMm: { nominal: 13, tolerance: 2 },
          torqueNm: null,
          drives: [],
          alRated: false,
          entryMm: { x: 15, y: 60, z: 44 },
          exitAxis: '+y',
          clampType: 'twistOn',
          clampDepthMm: 13,
          contactOhm: 0.0005,
          heatPathWPerK: 0.01,
          hotSpotHeatCapacityJPerK: 2,
          // Two or three of 18 to 12 AWG, at least two 18s (1 646 094 µm²) and at most 5 000 000 µm² in
          // all: two 14s fit (4 161 820), a third doesn't (6 242 730). Test values, not a product.
          combination: {
            minConductors: 2,
            maxConductors: 3,
            awg: { smallest: 18, largest: 12 },
            totalAreaUm2: { min: 1646094, max: 5000000 },
          },
        },
      ],
    },
  ],
  mounts: [
    { type: 'din35', widthMm: 20 },
    { type: 'backplate', widthMm: 20 },
  ],
  enclosure: null,
  conductor: null,
  model: { kind: 'test.block', params: {} },
  controls: [],
  sources: source(['sizeMm', 'terminals', 'terminals.*.methods', 'fits.din35', 'fits.backplate']),
  extensions: {},
};

/** A yoke-mounted wiring device stand-in (F3.5's yoke snapping): the block's body, fitting a device yoke. */
const yokeDevice = {
  ...block,
  id: 'tb.test-yoke',
  mounts: [{ type: 'deviceYoke', widthMm: 20 }],
  sources: source(['sizeMm', 'terminals', 'terminals.*.methods', 'fits.deviceYoke']),
};

const panel = {
  id: 'panel.test-din',
  version: 1,
  title: 'Test DIN panel',
  brand: 'Testbrand',
  modelName: 'P-1',
  category: 'enclosure',
  sizeMm: { widthMm: 600, heightMm: 400, depthMm: 150 },
  terminals: [],
  mounts: [],
  enclosure: {
    mounts: [
      { id: 'rail-1', type: 'din35', positionMm: { x: 50, y: 300, z: 100 }, axis: '+x', facing: '+z', extentMm: 500 },
      // An area mount (a backplate patch), a square of side extentMm (ADR 0015 implementation note 7).
      { id: 'plate', type: 'backplate', positionMm: { x: 50, y: 20, z: 50 }, axis: '+x', facing: '+z', extentMm: 200 },
    ],
    entries: [],
    interiorVolumeMm3: null,
  },
  conductor: null,
  model: { kind: 'test.panel', params: {} },
  controls: [],
  sources: source(['sizeMm', 'mounts']),
  extensions: {},
};

const cable = {
  id: 'cable.test-14-2',
  version: 1,
  title: 'Test cable 14/2 with ground',
  brand: 'Testbrand',
  modelName: 'K-1',
  conductors: [
    {
      index: 0,
      conductor: { id: 'conductor.test-14', version: 1 },
      role: 'ungrounded',
      insulated: true,
      colour: { base: 'black', stripe: null },
    },
    {
      index: 1,
      conductor: { id: 'conductor.test-14', version: 1 },
      role: 'grounded',
      insulated: true,
      colour: { base: 'white', stripe: null },
    },
    {
      index: 2,
      conductor: { id: 'conductor.test-14-bare', version: 1 },
      role: 'egc',
      insulated: false,
      colour: { base: 'bare', stripe: null },
    },
  ],
  jacket: {
    material: { table: 'insulation', version: 1, key: 'nmbJacket' },
    colour: 'white',
    thicknessMm: 0.6,
    widthMm: 9.6,
    heightMm: 5.1,
  },
  sources: source(['conductors', 'jacket']),
  extensions: {},
};

const bit = {
  id: 'tool.test-bit-19',
  version: 1,
  title: 'Test 19 mm bit',
  brand: 'Testbrand',
  modelName: 'D-19',
  kind: 'drill',
  capabilities: [{ step: 'bore', maxAwg: null }],
  holes: [],
  dies: [],
  drives: [],
  torque: null,
  boreDiameterMm: 19,
  sources: source(['capabilities', 'boreDiameterMm']),
  extensions: {},
};

const tool = (id: string, kind: string, capabilities: object[], extra: Record<string, unknown> = {}) => {
  const fields = { holes: [], dies: [], drives: [], torque: null, boreDiameterMm: null, ...extra };
  const covers = ['capabilities', ...Object.keys(extra)];
  return {
    id,
    version: 1,
    title: `Test ${kind}`,
    brand: 'Testbrand',
    modelName: 'X-1',
    kind,
    capabilities,
    ...fields,
    sources: source(covers),
    extensions: {},
  };
};
const can = (step: string, maxAwg: number | null = null) => ({ step, maxAwg });

const tools = [
  tool('tool.test-cutter', 'cutter', [can('cut', 4)]),
  tool('tool.test-stripper', 'stripper', [can('strip', 10), can('cut', 12), can('stripJacket', 10)], {
    holes: [
      { id: 'h10s', awg: 10, stranding: 'solid' },
      { id: 'h12s', awg: 12, stranding: 'solid' },
      { id: 'h14s', awg: 14, stranding: 'solid' },
      { id: 'h14st', awg: 14, stranding: 'stranded' },
      { id: 'h16st', awg: 16, stranding: 'stranded' },
    ],
  }),
  tool('tool.test-screwdriver', 'screwdriver', [can('drive')], { drives: ['slotted', 'phillips'] }),
  tool('tool.test-torque', 'torqueDriver', [can('drive'), can('torque')], {
    torque: { minNm: 0.5, maxNm: 6, accuracyFraction: 0.06 },
    drives: ['slotted', 'phillips'],
  }),
  tool('tool.test-crimper', 'crimper', [can('crimp', 10)], {
    dies: [
      { id: 'sq-14', label: '16-14', awgRange: { smallest: 16, largest: 14 } },
      { id: 'sq-10', label: '12-10', awgRange: { smallest: 12, largest: 10 } },
    ],
  }),
  tool('tool.test-nutdriver', 'nutDriver', [can('drive')], { drives: ['hex'] }),
  tool('tool.test-labeller', 'labelMaker', [can('label')]),
  tool('tool.test-fishtape', 'fishTape', [can('pull', 10)]),
  tool('tool.test-punch', 'knockoutPunch', [can('openEntry')]),
];

const ferrule = {
  id: 'ferrule.test-14',
  version: 1,
  title: 'Test ferrule',
  brand: 'Testbrand',
  modelName: 'F-1',
  kind: 'ferrule',
  awgRange: { smallest: 14, largest: 14 },
  stranding: ['stranded'],
  dies: ['sq-14'],
  barrelLengthMm: 8,
  studDiameterMm: null,
  sources: source(['awgRange', 'stranding', 'dies', 'barrelLengthMm']),
  extensions: {},
};

const lug = {
  ...ferrule,
  id: 'lug.test-ring-14',
  kind: 'ringLug',
  studDiameterMm: 4,
  sources: source(['awgRange', 'stranding', 'dies', 'barrelLengthMm', 'studDiameterMm']),
};

/** The test catalogue (catalogue version 2, like the built-in one). */
export const WIRING_TEST_CATALOG: Catalog = catalogOrThrow(
  BUILTIN_CATALOG.version,
  {
    devices: [
      ...BUILTIN_CATALOG.devices,
      conductor('conductor.test-14', true),
      conductor('conductor.test-14-bare', false),
      conductor('conductor.test-14-str', true, 14, 'stranded'),
      conductor('conductor.test-10', true, 10),
      box,
      block,
      yokeDevice,
      panel,
    ],
    cables: [cable],
    tools: [bit, ...tools],
    accessories: [ferrule, lug],
    tables: BUILTIN_CATALOG.tables,
  },
  WIRING_TEST_KINDS,
);
