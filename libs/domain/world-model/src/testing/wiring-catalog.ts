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
 * A TEST-ONLY catalogue for world v3's load check (P3 PR 7): the built-in devices plus a synthetic
 * conductor kind, a 1-gang box and a DIN panel (enclosure kinds), a 14/2-with-ground cable assembly, a
 * drill bit and a ferrule. Nothing here is a real product and every number is `game-design: test`;
 * the real conductors, cables, enclosures and tools arrive with F3.1, F3.4 and F3.5.
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

const conductor = (id: string, insulated: boolean) => ({
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
    awg: 14,
    stranding: 'solid',
    strandCount: 1,
    material: copper,
    insulation: insulated ? thhn : null,
    insulationThicknessMm: insulated ? 0.4 : null,
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
  alRated: false,
  entryMm: { x: 10, y: 0, z: 5 },
  exitAxis: '+z',
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
  torque: null,
  boreDiameterMm: 19,
  sources: source(['capabilities', 'boreDiameterMm']),
  extensions: {},
};

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
      box,
      panel,
    ],
    cables: [cable],
    tools: [bit],
    accessories: [ferrule, lug],
    tables: BUILTIN_CATALOG.tables,
  },
  WIRING_TEST_KINDS,
);
