import {
  type Catalog,
  catalogOrThrow,
  counterKey,
  MAX_PANEL_SPACES,
  type ModelKindDef,
  textKey,
} from '@controls/catalog';
import { Int } from '@controls/save-format';
import * as z from 'zod';
import { WIRING_TEST_CATALOG, WIRING_TEST_KINDS } from './wiring-catalog';

/*
 * A TEST-ONLY residential catalogue for world v4 (P4 PR 7's load checks, PR 8's commands), on top of
 * the wiring test catalogue (its conductors, tools and boxes): duplex 5-15R and single 5-20R
 * receptacles, appliances with 5-15P, 5-20P and 1-15P plugs, a power strip (outlets and a plug), a
 * lampholder offering an E26 socket through `hostMounts` and a bulb that fits it, a four-space load
 * centre with `directory1` … `directory42`, one- and two-pole plug-on breakers, a GFCI-like receptacle
 * with momentary `test` and `reset` buttons, a three-way switch (a two-option selector), a sealed device
 * with a terminal nothing can reach (`access: 'none'`) and a terminal block whose screw terminals cap
 * two conductors (`multiConductor`). Nothing here is a real product; every number is
 * `game-design: test`. The real entries arrive with P4's content PRs.
 */

const openEntries = {
  owner: 'commanded',
  type: 'number',
  schema: Int.min(0).max(0xffffffff),
  initial: 0,
  values: null,
  description: 'test',
} as const;

const entityKind = (kind: string, terminals: string[], keys: ModelKindDef['keys'] = {}): ModelKindDef => ({
  kind,
  placement: 'entity',
  terminals,
  params: z.strictObject({}),
  keys,
  description: 'test',
});

/** The model kinds: the wiring test kinds and the residential ones. */
export const RESIDENTIAL_TEST_KINDS: Readonly<Record<string, ModelKindDef>> = {
  ...WIRING_TEST_KINDS,
  'test.device': entityKind('test.device', ['a', 'b', 'ground']),
  'test.loadCentre': {
    ...entityKind('test.loadCentre', ['busL1', 'busL2'], {
      openEntries,
      ...Object.fromEntries(Array.from({ length: MAX_PANEL_SPACES }, (_, i) => [`directory${i + 1}`, textKey('t')])),
    }),
    requires: 'enclosure',
  },
  'test.gfci': entityKind('test.gfci', ['a', 'b', 'ground'], { test: counterKey('t'), reset: counterKey('t') }),
  'test.threeWay': entityKind('test.threeWay', ['a', 'b', 'ground'], {
    position: {
      owner: 'commanded',
      type: 'enum',
      schema: z.enum(['t1', 't2']),
      initial: 't1',
      values: ['t1', 't2'],
      description: 't',
    },
  }),
  'test.cap': entityKind('test.cap', ['1', '2']),
};

const at = (x: number, y = 0, z = 0) => ({ x, y, z });
const source = (covers: string[]) => [{ id: 'test', kind: 'game-design', citation: 'game-design: test', covers }];
const terminal = (id: string, access = 'clip') => ({
  id,
  label: id,
  positionMm: at(0),
  methods: [],
  role: null,
  side: null,
  access,
});
const pins = (blades: string[]) => blades.map((pin, i) => ({ pin, terminal: ['a', 'b', 'ground'][i] }));
const HOT_NEUTRAL_GROUND = ['hot', 'neutral', 'ground'];

function device(id: string, overrides: Record<string, unknown> = {}, covers: string[] = []): Record<string, unknown> {
  return {
    id,
    version: 1,
    title: 'Test device',
    brand: 'Testbrand',
    modelName: 'D-1',
    category: 'load',
    sizeMm: { widthMm: 20, heightMm: 20, depthMm: 20 },
    terminals: ['a', 'b', 'ground'].map((t) => terminal(t)),
    mounts: [],
    enclosure: null,
    hostMounts: [],
    outlets: [],
    plug: null,
    supersededBy: null,
    conductor: null,
    model: { kind: 'test.device', params: {} },
    controls: [],
    sources: source(['sizeMm', 'terminals', ...covers]),
    extensions: {},
    ...overrides,
  };
}

const outlet = (id: string, config: string, positionMm = at(0), blades = HOT_NEUTRAL_GROUND) => ({
  id,
  config,
  positionMm,
  contactOhm: 0.002,
  pins: pins(blades),
});
const outletCovers = (ids: string[]) =>
  ids.flatMap((id) => ['config', 'positionMm', 'pins', 'contactOhm'].map((f) => `outlets.${id}.${f}`));
const plug = (config: string, blades = HOT_NEUTRAL_GROUND) => ({
  config,
  cordAwg: 16,
  cordLengthMm: 1000,
  cordExitMm: at(0),
  pins: pins(blades),
});
const plugCovers = ['config', 'cordAwg', 'cordLengthMm', 'cordExitMm', 'pins'].map((f) => `plug.${f}`);

/** A bus column of two stabs 25 mm apart (stab 0 on `busL1`, stab 1 on `busL2`), its devices' +x along −y. */
const column = (id: string, x: number) => ({
  id,
  type: 'busStab',
  positionMm: at(x, 100),
  axis: '-y',
  facing: '+z',
  extentMm: 50,
  contacts: [],
  bus: { pitchMm: 25, stabs: 2, legs: ['busL1', 'busL2'] },
});

/** A plug-on breaker reaching `poles` stabs (line 1 → its own stab, line 2 → the next). */
const breaker = (id: string, poles: 1 | 2) =>
  device(
    id,
    {
      category: 'protection',
      sizeMm: { widthMm: 20, heightMm: 20, depthMm: 20 },
      mounts: [
        {
          type: 'busStab',
          widthMm: 20,
          crossMm: 0,
          alongMm: 0,
          contacts: Array.from({ length: poles }, (_, k) => ({
            id: `line${k + 1}`,
            terminal: ['a', 'b'][k],
            host: 'stab',
            positionOffset: k,
            contactOhm: 0.005,
          })),
        },
      ],
    },
    ['fits.busStab', ...Array.from({ length: poles }, (_, k) => `fits.busStab.contacts.line${k + 1}.contactOhm`)],
  );

/** A screw method that takes 14–10 AWG, two at most, with a `multiConductor` cap. */
const cappedScrew = (smallest: number, largest: number, equalSize: boolean) => ({
  method: 'screw',
  ratedConductors: 2,
  maxConductors: 2,
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
  multiConductor: { awgRange: { smallest, largest }, equalSize },
  combination: null,
});

/** The residential device entries (test-only). */
const DEVICES = [
  device(
    'receptacle.test-duplex-5-15r',
    { outlets: [outlet('top', '5-15R'), outlet('bottom', '5-15R', at(0, -40))] },
    outletCovers(['top', 'bottom']),
  ),
  device('receptacle.test-5-20r', { outlets: [outlet('face', '5-20R')] }, outletCovers(['face'])),
  device('appliance.test-kettle', { plug: plug('5-15P') }, plugCovers),
  device('appliance.test-heater-20', { plug: plug('5-20P') }, plugCovers),
  device('appliance.test-lamp', { plug: plug('1-15P', ['hot', 'neutral']) }, plugCovers),
  device('receptacle.test-strip', { outlets: [outlet('socket-1', '5-15R')], plug: plug('5-15P') }, [
    ...outletCovers(['socket-1']),
    ...plugCovers,
  ]),
  device(
    'lampholder.test',
    {
      hostMounts: [
        {
          id: 'socket',
          type: 'e26',
          positionMm: at(0),
          axis: '+x',
          facing: '+z',
          extentMm: 0,
          contacts: [
            { id: 'shell', terminal: 'a' },
            { id: 'centre', terminal: 'b' },
          ],
          bus: null,
        },
      ],
    },
    ['mounts.socket'],
  ),
  device('bulb.test', { mounts: [{ type: 'e26', widthMm: 20, crossMm: 0, alongMm: 0, contacts: [] }] }, ['fits.e26']),
  device(
    'panel.test-load-centre',
    {
      category: 'enclosure',
      sizeMm: { widthMm: 100, heightMm: 120, depthMm: 40 },
      terminals: ['busL1', 'busL2'].map((t) => terminal(t)),
      enclosure: {
        mounts: [column('left', 0), column('right', 40)],
        entries: [],
        interiorVolumeMm3: 1000000,
        markedVolumeMm3: null,
        material: 'steel',
        spaces: [
          { mount: 'left', index: 0 },
          { mount: 'right', index: 0 },
          { mount: 'left', index: 1 },
          { mount: 'right', index: 1 },
        ],
      },
      model: { kind: 'test.loadCentre', params: {} },
    },
    ['mounts', 'interiorVolumeMm3', 'material', 'spaces'],
  ),
  breaker('breaker.test-plug-on-1p', 1),
  breaker('breaker.test-plug-on-2p', 2),
  device(
    'receptacle.test-gfci',
    {
      outlets: [outlet('top', '5-15R')],
      model: { kind: 'test.gfci', params: {} },
      controls: [
        { id: 'test', label: 'Test', type: 'momentary' },
        { id: 'reset', label: 'Reset', type: 'momentary' },
      ],
    },
    outletCovers(['top']),
  ),
  device('switch.test-3way', {
    category: 'switch',
    model: { kind: 'test.threeWay', params: {} },
    controls: [{ id: 'position', label: 'Position', type: 'selector', options: ['t1', 't2'] }],
  }),
  device('device.test-sealed', { terminals: [terminal('a', 'none'), terminal('b'), terminal('ground')] }),
  device(
    'tb.test-cap',
    {
      category: 'switch',
      terminals: [
        { ...terminal('1', 'land'), methods: [cappedScrew(14, 10, true)] },
        {
          ...terminal('2', 'land'),
          positionMm: at(10),
          methods: [{ ...cappedScrew(14, 14, false), entryMm: at(20, 0, 5) }],
        },
      ],
      model: { kind: 'test.cap', params: {} },
    },
    ['terminals.1.methods.screw', 'terminals.2.methods.screw'],
  ),
];

/** The residential test catalogue: the wiring test catalogue plus {@link DEVICES} (catalogue version as built in). */
export const RESIDENTIAL_TEST_CATALOG: Catalog = catalogOrThrow(
  WIRING_TEST_CATALOG.version,
  {
    devices: [...WIRING_TEST_CATALOG.devices, ...DEVICES],
    cables: WIRING_TEST_CATALOG.cables,
    tools: WIRING_TEST_CATALOG.tools,
    accessories: WIRING_TEST_CATALOG.accessories,
    tables: WIRING_TEST_CATALOG.tables,
  },
  RESIDENTIAL_TEST_KINDS,
);

const ref = (id: string) => ({ id, version: 1 });

/** Refs into {@link RESIDENTIAL_TEST_CATALOG}. */
export const RESIDENTIAL = {
  duplex: ref('receptacle.test-duplex-5-15r'),
  r20: ref('receptacle.test-5-20r'),
  kettle: ref('appliance.test-kettle'),
  heater: ref('appliance.test-heater-20'),
  lamp: ref('appliance.test-lamp'),
  strip: ref('receptacle.test-strip'),
  holder: ref('lampholder.test'),
  bulb: ref('bulb.test'),
  panel: ref('panel.test-load-centre'),
  breaker1p: ref('breaker.test-plug-on-1p'),
  breaker2p: ref('breaker.test-plug-on-2p'),
  gfci: ref('receptacle.test-gfci'),
  threeWay: ref('switch.test-3way'),
  sealed: ref('device.test-sealed'),
  cap: ref('tb.test-cap'),
} as const;
