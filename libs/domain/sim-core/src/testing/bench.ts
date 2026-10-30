import {
  BUILTIN_CATALOG,
  type Catalog,
  catalogOrThrow,
  MODEL_KINDS,
  type ModelKindDef,
  type StateKeyDef,
} from '@controls/catalog';
import type { CommandBus } from '@controls/commands';
import { createWorld, FiniteNumber, type World } from '@controls/save-format';
import { createWorldBus, createWorldRegistry } from '@controls/world-model';
import { z } from 'zod';
import { BUILTIN_NETLIST_MODELS, type DeviceNetlistModel, type NetlistModels } from '../lib/netlist/models';

/*
 * Test benches for the netlist specs: the built-in catalogue's refs, and a catalogue extended with
 * synthetic model kinds that P2's catalogue doesn't have yet but the netlist must already serve: a
 * fuse that blows (a sim topology event), an AC source (AC and mixed islands) and a supply with a
 * commanded setpoint (a value-only change). Specs only; excluded from the lib build.
 */

export const BATTERY = { id: 'battery.ferrovane-12v-7ah', version: 1 };
export const SPST = { id: 'switch.tessaline-spst-toggle', version: 1 };
export const LAMP = { id: 'lamp.lumivane-12v-5w', version: 1 };
export const LEAD = { id: 'lead.quillfern-test-1m', version: 1 };
export const CRATE = { id: 'prop.crate', version: 1 };
/** A ref no catalogue knows (a missing mod's device). */
export const UNKNOWN = { id: 'mod.example-relay', version: 1 };

export const FUSE = { id: 'fuse.test-1a', version: 1 };
export const AC_SOURCE = { id: 'source.test-ac-120v', version: 1 };
export const SUPPLY = { id: 'supply.test-bench', version: 1 };
export const LEAD_2M = { id: 'lead.test-2m', version: 1 };

export const origin = { x: 0, y: 0, z: 0 };
export const end = (entity: number, terminal: string) => ({ entity, terminal });

const key = (def: Omit<StateKeyDef, 'values'>): StateKeyDef => ({ ...def, values: null });

/** Synthetic model kinds, beside the real ones. */
export const TEST_MODEL_KINDS: Readonly<Record<string, ModelKindDef>> = {
  ...MODEL_KINDS,
  'test.fuse': {
    kind: 'test.fuse',
    placement: 'entity',
    terminals: ['a', 'b'],
    params: z.strictObject({}),
    keys: {
      blown: key({ owner: 'sim', type: 'boolean', schema: z.boolean(), initial: false, description: 'Blown (test)' }),
    },
    description: 'A test fuse: a link between a and b until it blows.',
  },
  'test.acSource': {
    kind: 'test.acSource',
    placement: 'entity',
    terminals: ['l', 'n'],
    params: z.strictObject({ nominalVoltageV: FiniteNumber.positive() }),
    keys: {},
    description: 'A test AC source between n and l.',
  },
  'test.supply': {
    kind: 'test.supply',
    placement: 'entity',
    terminals: ['neg', 'pos'],
    params: z.strictObject({}),
    keys: {
      setpointV: key({
        owner: 'commanded',
        type: 'number',
        schema: FiniteNumber.min(0).max(30),
        initial: 12,
        description: 'Voltage setpoint (test)',
      }),
    },
    description: 'A test DC supply with a commanded setpoint.',
  },
};

const size = { widthMm: 10, heightMm: 10, depthMm: 10 };
const terminal = (id: string, x: number) => ({ id, label: id, positionMm: { x, y: 0, z: 0 } });
const testSource = (covers: string[]) => [{ id: 'test', kind: 'game-design', citation: 'game-design: test', covers }];
const base = { brand: 'Testbrand', modelName: 'T-1', controls: [], extensions: {} };

const TEST_DOCUMENTS: readonly unknown[] = [
  {
    ...base,
    ...FUSE,
    title: 'Test fuse',
    category: 'load',
    sizeMm: size,
    terminals: [terminal('a', 0), terminal('b', 10)],
    model: { kind: 'test.fuse', params: {} },
    sources: testSource(['sizeMm', 'terminals']),
  },
  {
    ...base,
    ...AC_SOURCE,
    title: 'Test AC source',
    category: 'source',
    sizeMm: size,
    terminals: [terminal('n', 0), terminal('l', 10)],
    model: { kind: 'test.acSource', params: { nominalVoltageV: 120 } },
    sources: testSource(['sizeMm', 'terminals', 'model.params.nominalVoltageV']),
  },
  {
    ...base,
    ...SUPPLY,
    title: 'Test supply',
    category: 'source',
    sizeMm: size,
    terminals: [terminal('neg', 0), terminal('pos', 10)],
    model: { kind: 'test.supply', params: {} },
    controls: [{ id: 'setpointV', label: 'Setpoint', type: 'setpoint', unit: 'V', min: 0, max: 30, step: 0.1 }],
    sources: testSource(['sizeMm', 'terminals']),
  },
  {
    ...base,
    ...LEAD_2M,
    title: 'Test 2 m lead',
    category: 'lead',
    sizeMm: null,
    terminals: [],
    model: {
      kind: 'lead',
      params: {
        lengthMm: 2000,
        conductorAreaM2: 8.2305e-7,
        resistivityOhmM: 1.724137931034483e-8,
        temperatureCoefficientPerK: 0.00393,
        referenceTemperatureK: 293.15,
        contactResistanceOhm: 0.01,
      },
    },
    sources: testSource([
      'model.params.lengthMm',
      'model.params.conductorAreaM2',
      'model.params.resistivityOhmM',
      'model.params.temperatureCoefficientPerK',
      'model.params.referenceTemperatureK',
      'model.params.contactResistanceOhm',
    ]),
  },
];

/** The built-in catalogue plus the synthetic entries. */
export const TEST_CATALOG: Catalog = catalogOrThrow(
  BUILTIN_CATALOG.version,
  [...BUILTIN_CATALOG.devices, ...TEST_DOCUMENTS],
  TEST_MODEL_KINDS,
);

const testFuse: DeviceNetlistModel = {
  kind: 'test.fuse',
  simTopologyKeys: ['blown'],
  topology: ({ sim }) =>
    sim['blown'] === true
      ? { joins: [], elements: [] }
      : { joins: [], elements: [{ part: 'link', kind: 'resistor', source: null, a: 'a', b: 'b', values: {} }] },
};

const testAcSource: DeviceNetlistModel = {
  kind: 'test.acSource',
  simTopologyKeys: [],
  topology: ({ params }) => ({
    joins: [],
    elements: [{ part: 'winding', kind: 'vsource', source: 'ac', a: 'n', b: 'l', values: { ...params } }],
  }),
};

const testSupply: DeviceNetlistModel = {
  kind: 'test.supply',
  simTopologyKeys: [],
  topology: ({ state }) => ({
    joins: [],
    elements: [
      {
        part: 'output',
        kind: 'vsource',
        source: 'dc',
        a: 'neg',
        b: 'pos',
        values: { setpointV: state['setpointV'] as number },
      },
    ],
  }),
};

/** The built-in netlist models plus the synthetic kinds'. */
export const TEST_MODELS: NetlistModels = {
  devices: {
    ...BUILTIN_NETLIST_MODELS.devices,
    'test.fuse': testFuse,
    'test.acSource': testAcSource,
    'test.supply': testSupply,
  },
  connections: BUILTIN_NETLIST_MODELS.connections,
};

/** A world bus over an empty world whose commands resolve against `catalog`. */
export function benchBus(catalog: Catalog = BUILTIN_CATALOG, seed = 7): CommandBus<World> {
  return createWorldBus(createWorld({ seed }), createWorldRegistry({ catalog }));
}

/** Executes a command and fails the test if it is refused. */
export function run(bus: CommandBus<World>, id: string, args: object = {}): void {
  const result = bus.exec(id, args);
  if (!result.ok) throw new Error(`${id} ${JSON.stringify(args)} failed: ${JSON.stringify(result.error)}`);
}

/**
 * The bench demo: a battery (1), an SPST switch (2) and a lamp (3), with leads battery + → switch a
 * (1), switch b → lamp a (2) and lamp b → battery − (3). The switch is closed when `closed`.
 */
export function benchLamp(closed: boolean): World {
  const bus = benchBus();
  for (const ref of [BATTERY, SPST, LAMP]) run(bus, 'entity.place', { ref, positionMm: origin });
  run(bus, 'lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') });
  run(bus, 'lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(3, 'a') });
  run(bus, 'lead.connect', { ref: LEAD, a: end(3, 'b'), b: end(1, 'neg') });
  if (closed) run(bus, 'device.operate', { id: 2, control: 'closed', value: true });
  return bus.state;
}
