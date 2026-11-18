import { BUILTIN_CATALOG, type Catalog, catalogOrThrow, type ModelKindDef } from '@controls/catalog';
import type { CommandBus } from '@controls/commands';
import { createWorld, FiniteNumber, type World } from '@controls/save-format';
import { createWorldBus, createWorldRegistry } from '@controls/world-model';
import * as z from 'zod';
import type { SimDeviceModel } from '../lib/engine/device-model';
import type { SimEngineOptions } from '../lib/engine/engine';
import { AC_STAMP_RESISTOR } from '../lib/mna/ac-values';
import type { DeviceNetlistModel, NetlistModels } from '../lib/netlist/models';
import { TEST_DOCUMENTS } from './bench';
import { ENGINE_DOCUMENTS, ENGINE_MODEL_KINDS, ENGINE_TEST_MODELS, engineTestOptions } from './engine';

export { ROD, ROD_OHM, SERVICE, SERVICE_PARAMS } from './engine';

/*
 * A TEST-ONLY residential catalogue for engine 8 part 1 (P4 PR 9): what the netlist compiler reads from
 * mounts, plugs and earth links, on synthetic host and device kinds, and the two real kinds this PR
 * adds (`service.splitPhase`, `electrode.groundRod`) on test entries. Nothing here is a real product;
 * every number is `game-design: test` unless its comment says otherwise. The real entries (the
 * service, load centres, plug-on breakers, receptacles, appliances, the ground rod) arrive with P4's
 * content PRs (12–15).
 *
 * - `test.panel` (`PANEL`): a host offering, through `hostMounts`, a bus column of four stabs 25 mm
 *   apart at x = 0, 25, 50, 75 (legs busL1, busL2, busL1, busL2), an `mbj` mount (host contacts
 *   `neutral` → its `neutral` bar, `chassis` → its can) and a `groundBarKit` mount (`chassis`). Its bars
 *   and can are separate terminals with no element between them, so only what is mounted joins them.
 * - `test.plugOn1p` / `test.plugOn2p` (`BREAKER_1P`, `BREAKER_2P`): a pole `line` → `load` of 5 mΩ
 *   (two for the 2-pole), reaching the bus through 5 mΩ stab contacts (`line1`, and `line2` one stab on).
 * - `test.bond` (`MBJ`, `GROUND_BAR`): a screw or a bar, its two contact points joined ideally, bonding
 *   what its mount's host contacts reach (2 mΩ each).
 * - `test.receptacle` (`RECEPTACLE`): screw terminals `hot`, `neutral`, `ground` joined ideally to the
 *   face's slots, one 5-15R outlet `face` (3 mΩ per pin contact).
 * - `test.appliance` (`APPLIANCE_12R`, `LAMP_PLUG`): a 5-15P (or two-blade 1-15P) appliance whose element
 *   is 12 Ω between its hot and neutral pins.
 * - `SERVICE` (`service.splitPhase`, in the engine test catalogue, `engine.ts`): 25 kVA, 2 %, X/R 2, 120/240 V, a 30 m drop of 33.631 mm² aluminium
 *   lines and a 21.15 mm² neutral (2 AWG and 4 AWG areas, NBS Handbook 100's AWG geometry), aluminium
 *   at 2.8264e-8 Ω·m and α 0.00403 /K at 20 °C (61 % IACS conductivity, the published 1350 alloy
 *   figure), utility grounding 5 Ω (the plan's vetted game-design value inside 1–25 Ω).
 * - `ROD` (`electrode.groundRod`, likewise): 39.90 Ω, the pre-audit's 8 ft × 5/8 in rod at 100 Ω·m by Dwight's
 *   formula with the radius (recomputed in `service.spec.ts`).
 */

export const PANEL = { id: 'panel.test-residential', version: 1 };
export const BREAKER_1P = { id: 'breaker.test-plug-on-1p', version: 1 };
export const BREAKER_2P = { id: 'breaker.test-plug-on-2p', version: 1 };
export const MBJ = { id: 'bond.test-mbj', version: 1 };
export const GROUND_BAR = { id: 'bond.test-ground-bar', version: 1 };
export const RECEPTACLE = { id: 'receptacle.test-5-15r', version: 1 };
export const APPLIANCE_12R = { id: 'appliance.test-12r', version: 1 };
export const LAMP_PLUG = { id: 'appliance.test-1-15p-12r', version: 1 };
/** Contact resistances of the test entries (Ω). */
export const STAB_OHM = 0.005;
export const POLE_OHM = 0.005;
export const BOND_OHM = 0.002;
export const PIN_OHM = 0.003;
export const APPLIANCE_OHM = 12;

const entityKind = (kind: string, terminals: string[], params: z.ZodType = z.strictObject({})): ModelKindDef => ({
  kind,
  placement: 'entity',
  terminals,
  params: params as ModelKindDef['params'],
  keys: {},
  description: 'test',
});

/** The engine test kinds plus the residential test kinds (the real `service.splitPhase` and `electrode.groundRod` included). */
export const RESIDENTIAL_TEST_KINDS: Readonly<Record<string, ModelKindDef>> = {
  ...ENGINE_MODEL_KINDS,
  'test.panel': entityKind('test.panel', ['busL1', 'busL2', 'chassis', 'neutral']),
  'test.plugOn1p': entityKind('test.plugOn1p', ['line', 'load']),
  'test.plugOn2p': entityKind('test.plugOn2p', ['line1', 'line2', 'load1', 'load2']),
  'test.bond': entityKind('test.bond', ['a', 'b']),
  'test.receptacle': entityKind('test.receptacle', ['ground', 'hot', 'neutral', 'sGround', 'sHot', 'sNeutral']),
  'test.appliance': entityKind(
    'test.appliance',
    ['pGround', 'pHot', 'pNeutral'],
    z.strictObject({ ohms: FiniteNumber.positive() }),
  ),
};

const at = (x: number, y = 0, z = 0) => ({ x, y, z });
const terminal = (id: string, access: 'clip' | 'none' = 'clip') => ({
  id,
  label: id,
  positionMm: at(0),
  methods: [],
  role: null,
  side: null,
  access,
});
const source = (covers: string[]) => [{ id: 'test', kind: 'game-design', citation: 'game-design: test', covers }];

function device(
  ref: { id: string; version: number },
  kind: string,
  terminals: readonly ReturnType<typeof terminal>[],
  overrides: Record<string, unknown> = {},
  covers: string[] = [],
  params: Record<string, number> = {},
): Record<string, unknown> {
  return {
    ...ref,
    title: 'Test residential device',
    brand: 'Testbrand',
    modelName: 'R-1',
    category: 'load',
    sizeMm: { widthMm: 20, heightMm: 20, depthMm: 20 },
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
    sources: source(['sizeMm', 'terminals', ...Object.keys(params).map((p) => `model.params.${p}`), ...covers]),
    extensions: {},
    ...overrides,
  };
}

const hostMount = (id: string, type: string, x: number, contacts: { id: string; terminal: string }[], bus = null) => ({
  id,
  type,
  positionMm: at(x, 0, 0),
  axis: '+x',
  facing: '+z',
  extentMm: type === 'busStab' ? 100 : 0,
  contacts,
  bus,
});

const fit = (type: string, contacts: Record<string, unknown>[], widthMm = 20) => ({
  type,
  widthMm,
  crossMm: 0,
  alongMm: 0,
  contacts,
});
const contact = (id: string, terminalId: string, host: string, contactOhm: number, positionOffset = 0) => ({
  id,
  terminal: terminalId,
  host,
  positionOffset,
  contactOhm,
});
const contactCovers = (type: string, ids: string[]) => [
  `fits.${type}`,
  ...ids.map((id) => `fits.${type}.contacts.${id}.contactOhm`),
];

const RESIDENTIAL_DOCUMENTS: readonly unknown[] = [
  device(
    PANEL,
    'test.panel',
    ['busL1', 'busL2', 'chassis', 'neutral'].map((t) => terminal(t)),
    {
      category: 'protection',
      sizeMm: { widthMm: 300, heightMm: 300, depthMm: 20 },
      hostMounts: [
        {
          ...hostMount('bus', 'busStab', 0, []),
          bus: { pitchMm: 25, stabs: 4, legs: ['busL1', 'busL2'] },
        },
        hostMount('mbj', 'mbj', 200, [
          { id: 'chassis', terminal: 'chassis' },
          { id: 'neutral', terminal: 'neutral' },
        ]),
        hostMount('gbar', 'groundBarKit', 250, [{ id: 'chassis', terminal: 'chassis' }]),
      ],
    },
    ['mounts.bus', 'mounts.mbj', 'mounts.gbar'],
  ),
  device(
    BREAKER_1P,
    'test.plugOn1p',
    ['line', 'load'].map((t) => terminal(t)),
    { category: 'protection', mounts: [fit('busStab', [contact('line1', 'line', 'stab', STAB_OHM)])] },
    contactCovers('busStab', ['line1']),
  ),
  device(
    BREAKER_2P,
    'test.plugOn2p',
    ['line1', 'line2', 'load1', 'load2'].map((t) => terminal(t)),
    {
      category: 'protection',
      mounts: [
        fit('busStab', [contact('line1', 'line1', 'stab', STAB_OHM), contact('line2', 'line2', 'stab', STAB_OHM, 1)]),
      ],
    },
    contactCovers('busStab', ['line1', 'line2']),
  ),
  device(
    MBJ,
    'test.bond',
    ['a', 'b'].map((t) => terminal(t)),
    {
      mounts: [
        fit('mbj', [contact('neutral', 'a', 'neutral', BOND_OHM), contact('chassis', 'b', 'chassis', BOND_OHM)]),
      ],
    },
    contactCovers('mbj', ['neutral', 'chassis']),
  ),
  device(
    GROUND_BAR,
    'test.bond',
    ['a', 'b'].map((t) => terminal(t)),
    { mounts: [fit('groundBarKit', [contact('chassis', 'a', 'chassis', BOND_OHM)])] },
    contactCovers('groundBarKit', ['chassis']),
  ),
  device(
    RECEPTACLE,
    'test.receptacle',
    ['ground', 'hot', 'neutral', 'sGround', 'sHot', 'sNeutral'].map((t) => terminal(t)),
    {
      outlets: [
        {
          id: 'face',
          config: '5-15R',
          positionMm: at(0),
          contactOhm: PIN_OHM,
          pins: [
            { pin: 'hot', terminal: 'sHot' },
            { pin: 'neutral', terminal: 'sNeutral' },
            { pin: 'ground', terminal: 'sGround' },
          ],
        },
      ],
    },
    ['outlets.face.config', 'outlets.face.positionMm', 'outlets.face.pins', 'outlets.face.contactOhm'],
  ),
  ...[
    [APPLIANCE_12R, '5-15P'],
    [LAMP_PLUG, '1-15P'],
  ].map(([ref, config]) =>
    device(
      ref as { id: string; version: number },
      'test.appliance',
      ['pGround', 'pHot', 'pNeutral'].map((t) => terminal(t, 'none')),
      {
        plug: {
          config,
          cordAwg: 16,
          cordLengthMm: 2000,
          cordExitMm: at(0),
          pins:
            config === '1-15P'
              ? [
                  { pin: 'hot', terminal: 'pHot' },
                  { pin: 'neutral', terminal: 'pNeutral' },
                ]
              : [
                  { pin: 'hot', terminal: 'pHot' },
                  { pin: 'neutral', terminal: 'pNeutral' },
                  { pin: 'ground', terminal: 'pGround' },
                ],
        },
      },
      ['plug.config', 'plug.cordAwg', 'plug.cordLengthMm', 'plug.cordExitMm', 'plug.pins'],
      { ohms: APPLIANCE_OHM },
    ),
  ),
];

/** The engine test catalogue plus the residential test entries. */
export const RESIDENTIAL_TEST_CATALOG: Catalog = catalogOrThrow(
  BUILTIN_CATALOG.version,
  {
    devices: [...BUILTIN_CATALOG.devices, ...TEST_DOCUMENTS, ...ENGINE_DOCUMENTS, ...RESIDENTIAL_DOCUMENTS],
    tables: BUILTIN_CATALOG.tables,
  },
  RESIDENTIAL_TEST_KINDS,
);

const pole = (part: string, a: string, b: string) => ({
  part,
  kind: 'resistor' as const,
  source: null,
  a,
  b,
  values: { resistanceOhm: POLE_OHM },
});

/** The residential test kinds' netlist models (the engine test models and the built-in ones beside them). */
export const RESIDENTIAL_TEST_MODELS: NetlistModels = {
  devices: {
    ...ENGINE_TEST_MODELS.devices,
    'test.panel': { kind: 'test.panel', simTopologyKeys: [], topology: () => ({ joins: [], elements: [] }) },
    'test.plugOn1p': {
      kind: 'test.plugOn1p',
      simTopologyKeys: [],
      topology: () => ({ joins: [], elements: [pole('pole', 'line', 'load')] }),
      wiringPath: true,
    },
    'test.plugOn2p': {
      kind: 'test.plugOn2p',
      simTopologyKeys: [],
      topology: () => ({ joins: [], elements: [pole('pole1', 'line1', 'load1'), pole('pole2', 'line2', 'load2')] }),
      wiringPath: true,
    },
    'test.bond': { kind: 'test.bond', simTopologyKeys: [], topology: () => ({ joins: [['a', 'b']], elements: [] }) },
    'test.receptacle': {
      kind: 'test.receptacle',
      simTopologyKeys: [],
      topology: () => ({
        joins: [
          ['ground', 'sGround'],
          ['hot', 'sHot'],
          ['neutral', 'sNeutral'],
        ],
        elements: [],
      }),
    },
    'test.appliance': {
      kind: 'test.appliance',
      simTopologyKeys: [],
      topology: ({ params }) => ({
        joins: [],
        elements: [
          {
            part: 'element',
            kind: 'resistor',
            source: null,
            a: 'pHot',
            b: 'pNeutral',
            values: { resistanceOhm: params['ohms'] },
          },
        ],
      }),
    },
  } satisfies Record<string, DeviceNetlistModel>,
  connections: ENGINE_TEST_MODELS.connections,
};

/** Fixed resistances for the residential test kinds on DC and AC (their netlist `resistanceOhm`). */
const fixed = (kind: string): SimDeviceModel => ({
  kind,
  output: null,
  bank: () => ({
    bag: () => ({}),
    dcValue: (_i, b, values) => {
      values.resistor(b.index, b.values['resistanceOhm']);
      return true;
    },
    acValue: (_i, b, values) => {
      values.stamps[b.index] = AC_STAMP_RESISTOR;
      values.ohms[b.index] = b.values['resistanceOhm'];
      return true;
    },
  }),
});

/** Engine options over the residential test catalogue and models. */
export function residentialTestOptions(): Required<SimEngineOptions> {
  const options = engineTestOptions();
  return {
    ...options,
    catalog: RESIDENTIAL_TEST_CATALOG,
    netlistModels: RESIDENTIAL_TEST_MODELS,
    deviceModels: {
      ...options.deviceModels,
      'test.plugOn1p': fixed('test.plugOn1p'),
      'test.plugOn2p': fixed('test.plugOn2p'),
      'test.appliance': fixed('test.appliance'),
    },
  };
}

/** A world bus over an empty world on the residential test catalogue. */
export function residentialBus(seed = 11, world: World = createWorld({ seed })): CommandBus<World> {
  return createWorldBus(world, createWorldRegistry({ catalog: RESIDENTIAL_TEST_CATALOG }));
}
