import { BUILTIN_CATALOG, type Catalog, catalogOrThrow, type ModelKindDef, type StateKeyDef } from '@controls/catalog';
import type { CommandBus } from '@controls/commands';
import { createWorld, FiniteNumber, type World } from '@controls/save-format';
import { createWorldBus, createWorldRegistry } from '@controls/world-model';
import { z } from 'zod';
import { BUILTIN_DEVICE_MODELS, GENERATOR_STUB_NAMEPLATE } from '../lib/devices';
import type { LayerContext, SimDevice, SimDeviceBank, SimDeviceModel } from '../lib/engine/device-model';
import type { SimEngineOptions } from '../lib/engine/engine';
import type { DeviceNetlistModel, NetlistModels } from '../lib/netlist/models';
import { BATTERY, end, LEAD, origin, SPST, TEST_DOCUMENTS, TEST_MODEL_KINDS, TEST_MODELS } from './bench';

/*
 * Synthetic device models for the engine loop's specs and `sim bench` (F2.3a). P2's real models (the
 * battery's state of charge, F2.4; the lamp's filament, the fuse's I²t, F2.5) aren't the engine's to
 * write, but every hook they will use must already be proven: so these kinds exercise them. **None of
 * their numbers is a real device's** (game-design: test), and none of them is ever in a player build:
 * `src/testing/` is excluded from the lib build.
 *
 * - `test.thermalLoad`: a resistor whose R rises with its temperature, heated by I²R and cooled
 *   towards ambient (the continuous layer, a DC value hook, a null-initial sim key, a seeded per-device
 *   tolerance and an output record);
 * - `test.i2tFuse`: a link that melts when ∫I²dt reaches its rating (the protection layer, a sim
 *   topology key and an event, re-solved in the same step);
 * - `test.flip`: a resistance that jumps with the current through it, so the outer loop can't settle
 *   (the iteration hook and `nonConverged`);
 * - `test.orderA` and `test.orderB`: no elements; each layer call is journalled (the layer order);
 * - `test.droop`: a resistance that rises with its own current, R = R0 (1 + k |I|): a contraction the
 *   outer loop settles by its tolerance stop (the warm start from the solution record);
 * - `test.opaque`: a resistance with no engine model and no default value, so an island holding it is
 *   `unmodelled` (what the lamp was before F2.5's filament model);
 * - `test.leaky`: **deliberately wrong**, a step counter kept only in its bank and not in its bag, so
 *   the save-and-load property must fail on it (never in `engineTestOptions`, only `leakyTestOptions`);
 * - `test.reactor`: an inductor of `henries` on AC (a lagging current, so phasors with a phase), a
 *   small resistance on DC;
 * - `test.acTwin`: two ideal AC sources (120 V and 121 V at 0°) across the same terminals, a loop of
 *   zero-ohm sources (a singular AC island);
 * - `test.acSource` (from `bench.ts`): a 120 V RMS phasor source at 0° behind 0.1 Ω (AC islands);
 * - `test.twinSupply`: two ideal sources (12 V and 13 V) between the same terminals, a loop of zero-ohm
 *   sources (the singular island);
 * - `test.resistor`: a fixed resistance of `ohms` (F2.4's source goldens: a load that doesn't move);
 * - `test.rheostat`: a resistance the test sets with `device.operate {control: 'ohms'}` (commanded, a
 *   value change), for sweeping a supply's load through its CV/CC crossover.
 *
 * The built-in engine models (F2.4's battery and supplies) run beside them in `engineTestOptions`.
 */

export const THERMAL_LOAD = { id: 'load.test-thermal', version: 1 };
export const I2T_FUSE = { id: 'fuse.test-i2t', version: 1 };
export const FLIP = { id: 'load.test-flip', version: 1 };
export const ORDER_A = { id: 'probe.test-order-a', version: 1 };
export const ORDER_B = { id: 'probe.test-order-b', version: 1 };
export const TWIN_SUPPLY = { id: 'supply.test-twin', version: 1 };
export const DROOP = { id: 'load.test-droop', version: 1 };
export const REACTOR = { id: 'load.test-reactor', version: 1 };
export const AC_TWIN = { id: 'source.test-ac-twin', version: 1 };
export const LEAKY = { id: 'load.test-leaky', version: 1 };
/** A 120 V 60 W incandescent lamp (the real lamp model on a test entry): the lamp on an AC island. */
export const LAMP_120V = { id: 'lamp.test-120v-60w', version: 1 };
/** A resistance no model can value (no engine model, no default): an island holding it is unmodelled. */
export const OPAQUE = { id: 'load.test-opaque', version: 1 };
/** Fixed test resistors (`test.resistor`), by resistance. */
export const RESISTOR_2_4 = { id: 'load.test-resistor-2r4', version: 1 };
export const RESISTOR_12 = { id: 'load.test-resistor-12r', version: 1 };
export const RESISTOR_100 = { id: 'load.test-resistor-100r', version: 1 };
export const RHEOSTAT = { id: 'load.test-rheostat', version: 1 };
/** The portable generator stub at its nameplate (`GENERATOR_STUB_NAMEPLATE`; not in the built-in catalogue). */
export const GENERATOR = { id: 'generator.test-portable', version: 1 };
/** A near-zero lead (1 mm of 1000 mm² copper, no contact resistance): a bolted connection for fault goldens. */
export const BUSBAR = { id: 'lead.test-busbar', version: 1 };

const key = (def: Omit<StateKeyDef, 'values'>): StateKeyDef => ({ ...def, values: null });
const twoTerminals = ['a', 'b'];

const ENGINE_MODEL_KINDS: Readonly<Record<string, ModelKindDef>> = {
  ...TEST_MODEL_KINDS,
  'test.thermalLoad': {
    kind: 'test.thermalLoad',
    placement: 'entity',
    terminals: twoTerminals,
    params: z.strictObject({
      coldResistanceOhm: FiniteNumber.positive(),
      alphaPerK: FiniteNumber.min(0),
      heatCapacityJPerK: FiniteNumber.positive(),
      lossWPerK: FiniteNumber.positive(),
      ambientK: FiniteNumber.positive(),
    }),
    keys: {
      tempK: key({
        owner: 'sim',
        type: 'number',
        schema: FiniteNumber.positive().nullable(),
        initial: null,
        description: 'Temperature (test); null until the engine first netlists it',
      }),
    },
    description: 'A test load whose resistance rises with its temperature.',
  },
  'test.i2tFuse': {
    kind: 'test.i2tFuse',
    placement: 'entity',
    terminals: twoTerminals,
    params: z.strictObject({ resistanceOhm: FiniteNumber.positive(), meltA2s: FiniteNumber.positive() }),
    keys: {
      blown: key({ owner: 'sim', type: 'boolean', schema: z.boolean(), initial: false, description: 'Blown (test)' }),
      heatA2s: key({
        owner: 'sim',
        type: 'number',
        schema: FiniteNumber.min(0),
        initial: 0,
        description: '∫I²dt (test)',
      }),
    },
    description: 'A test fuse that melts when ∫I²dt reaches its rating.',
  },
  'test.flip': {
    kind: 'test.flip',
    placement: 'entity',
    terminals: twoTerminals,
    params: z.strictObject({
      lowOhm: FiniteNumber.positive(),
      highOhm: FiniteNumber.positive(),
      thresholdA: FiniteNumber.positive(),
    }),
    keys: {},
    description: 'A test resistance that jumps with its own current (it never settles).',
  },
  'test.droop': {
    kind: 'test.droop',
    placement: 'entity',
    terminals: twoTerminals,
    params: z.strictObject({ coldOhm: FiniteNumber.positive(), perAmp: FiniteNumber.min(0) }),
    keys: {},
    description: 'A test resistance that rises with its own current (it settles).',
  },
  'test.acTwin': {
    kind: 'test.acTwin',
    placement: 'entity',
    terminals: ['l', 'n'],
    params: z.strictObject({}),
    keys: {},
    description: 'Two ideal AC test sources in parallel (always singular).',
  },
  'test.reactor': {
    kind: 'test.reactor',
    placement: 'entity',
    terminals: twoTerminals,
    params: z.strictObject({ henries: FiniteNumber.positive(), dcOhm: FiniteNumber.positive() }),
    keys: {},
    description: 'A test inductor (AC) with a small DC resistance.',
  },
  'test.resistor': {
    kind: 'test.resistor',
    placement: 'entity',
    terminals: twoTerminals,
    params: z.strictObject({ ohms: FiniteNumber.positive() }),
    keys: {},
    description: 'A fixed test resistance.',
  },
  'test.rheostat': {
    kind: 'test.rheostat',
    placement: 'entity',
    terminals: twoTerminals,
    params: z.strictObject({}),
    keys: {
      ohms: key({
        owner: 'commanded',
        type: 'number',
        schema: FiniteNumber.positive(),
        initial: 10,
        description: 'Resistance (test), set with device.operate',
      }),
    },
    description: 'A test resistance set by a command.',
  },
  'test.leaky': {
    kind: 'test.leaky',
    placement: 'entity',
    terminals: twoTerminals,
    params: z.strictObject({}),
    keys: {},
    description: 'A deliberately wrong test model: state kept outside its bag.',
  },
  'test.opaque': {
    kind: 'test.opaque',
    placement: 'entity',
    terminals: twoTerminals,
    params: z.strictObject({}),
    keys: {},
    description: 'A test resistance nothing can value: its island is unmodelled.',
  },
  'test.twinSupply': {
    kind: 'test.twinSupply',
    placement: 'entity',
    terminals: ['neg', 'pos'],
    params: z.strictObject({}),
    keys: {},
    description: 'Two ideal test sources in parallel (always singular).',
  },
  'test.orderA': {
    kind: 'test.orderA',
    placement: 'entity',
    terminals: ['t'],
    params: z.strictObject({}),
    keys: {
      steps: key({
        owner: 'sim',
        type: 'number',
        schema: FiniteNumber.min(0),
        initial: 0,
        description: 'Steps (test)',
      }),
    },
    description: 'A test probe of the layer order.',
  },
  'test.orderB': {
    kind: 'test.orderB',
    placement: 'entity',
    terminals: ['t'],
    params: z.strictObject({}),
    keys: {
      steps: key({
        owner: 'sim',
        type: 'number',
        schema: FiniteNumber.min(0),
        initial: 0,
        description: 'Steps (test)',
      }),
    },
    description: 'A test probe of the layer order.',
  },
};

const size = { widthMm: 10, heightMm: 10, depthMm: 10 };
const terminal = (id: string, x: number) => ({ id, label: id, positionMm: { x, y: 0, z: 0 } });
const base = { brand: 'Testbrand', modelName: 'T-2', controls: [], extensions: {} };
const sources = (params: string[]) => [
  {
    id: 'test',
    kind: 'game-design',
    citation: 'game-design: test only, never a real device',
    covers: ['sizeMm', 'terminals', ...params.map((p) => `model.params.${p}`)],
  },
];
function entry(
  ref: { id: string; version: number },
  title: string,
  kind: string,
  params: Record<string, number>,
  terminals = twoTerminals,
) {
  return {
    ...base,
    ...ref,
    title,
    category: 'load',
    sizeMm: size,
    terminals: terminals.map((t, i) => terminal(t, 10 * i)),
    model: { kind, params },
    sources: sources(Object.keys(params)),
  };
}

/** The thermal load's parameters: 2 Ω cold, +0.4 %/K, 0.5 J/K, 0.05 W/K to a 293.15 K ambient (test). */
export const THERMAL_PARAMS = {
  coldResistanceOhm: 2,
  alphaPerK: 0.004,
  heatCapacityJPerK: 0.5,
  lossWPerK: 0.05,
  ambientK: 293.15,
};

const nameplate = Object.fromEntries(
  Object.entries(GENERATOR_STUB_NAMEPLATE).map(([name, constant]) => [name, constant.value]),
);

const ENGINE_DOCUMENTS: readonly unknown[] = [
  {
    ...entry(GENERATOR, 'Test portable generator (stub)', 'generator.portable', nameplate, ['l1', 'l2', 'n']),
    category: 'source',
  },
  {
    ...base,
    ...BUSBAR,
    title: 'Test busbar link',
    category: 'lead',
    sizeMm: null,
    terminals: [],
    model: {
      kind: 'lead',
      params: {
        lengthMm: 1,
        conductorAreaM2: 1e-3,
        resistivityOhmM: 1.724137931034483e-8,
        temperatureCoefficientPerK: 0.00393,
        referenceTemperatureK: 293.15,
        contactResistanceOhm: 0,
      },
    },
    sources: sources([
      'lengthMm',
      'conductorAreaM2',
      'resistivityOhmM',
      'temperatureCoefficientPerK',
      'referenceTemperatureK',
      'contactResistanceOhm',
    ]).map((s) => ({ ...s, covers: s.covers.filter((c) => c !== 'sizeMm' && c !== 'terminals') })),
  },
  entry(THERMAL_LOAD, 'Test thermal load', 'test.thermalLoad', THERMAL_PARAMS),
  entry(I2T_FUSE, 'Test I²t fuse', 'test.i2tFuse', { resistanceOhm: 0.01, meltA2s: 4 }),
  entry(FLIP, 'Test flip load', 'test.flip', { lowOhm: 0.1, highOhm: 100, thresholdA: 1 }),
  entry(TWIN_SUPPLY, 'Test twin supply', 'test.twinSupply', {}, ['neg', 'pos']),
  entry(DROOP, 'Test droop load', 'test.droop', { coldOhm: 2, perAmp: 0.1 }),
  entry(LEAKY, 'Test leaky load', 'test.leaky', {}),
  entry(OPAQUE, 'Test opaque load', 'test.opaque', {}),
  entry(LAMP_120V, 'Test 120 V 60 W lamp', 'lamp.incandescent', {
    ratedVoltageV: 120,
    ratedPowerW: 60,
    filamentRatedTempK: 2850,
    thermalTimeConstantMs: 100,
  }),
  entry(RESISTOR_2_4, 'Test 2.4 Ω resistor', 'test.resistor', { ohms: 2.4 }),
  entry(RESISTOR_12, 'Test 12 Ω resistor', 'test.resistor', { ohms: 12 }),
  entry(RESISTOR_100, 'Test 100 Ω resistor', 'test.resistor', { ohms: 100 }),
  {
    ...entry(RHEOSTAT, 'Test rheostat', 'test.rheostat', {}),
    controls: [{ id: 'ohms', label: 'Resistance', type: 'setpoint', unit: 'Ω', min: 1e-4, max: 1e7, step: 0.001 }],
  },
  entry(REACTOR, 'Test reactor', 'test.reactor', { henries: 0.05, dcOhm: 0.5 }),
  entry(AC_TWIN, 'Test AC twin source', 'test.acTwin', {}, ['n', 'l']),
  entry(ORDER_A, 'Test order probe A', 'test.orderA', {}, ['t']),
  entry(ORDER_B, 'Test order probe B', 'test.orderB', {}, ['t']),
];

/** The built-in catalogue, `bench.ts`'s test entries and the engine's. */
export const ENGINE_TEST_CATALOG: Catalog = catalogOrThrow(
  BUILTIN_CATALOG.version,
  [...BUILTIN_CATALOG.devices, ...TEST_DOCUMENTS, ...ENGINE_DOCUMENTS],
  ENGINE_MODEL_KINDS,
);

const resistorBetween =
  (part: string): DeviceNetlistModel['topology'] =>
  () => ({
    joins: [],
    elements: [{ part, kind: 'resistor', source: null, a: 'a', b: 'b', values: {} }],
  });
const noElements: DeviceNetlistModel['topology'] = () => ({ joins: [], elements: [] });

export const ENGINE_TEST_MODELS: NetlistModels = {
  devices: {
    ...TEST_MODELS.devices,
    'test.thermalLoad': { kind: 'test.thermalLoad', simTopologyKeys: [], topology: resistorBetween('element') },
    'test.i2tFuse': {
      kind: 'test.i2tFuse',
      simTopologyKeys: ['blown'],
      topology: (input) => (input.sim['blown'] === true ? { joins: [], elements: [] } : resistorBetween('link')(input)),
    },
    'test.flip': { kind: 'test.flip', simTopologyKeys: [], topology: resistorBetween('element') },
    'test.droop': { kind: 'test.droop', simTopologyKeys: [], topology: resistorBetween('element') },
    'test.leaky': { kind: 'test.leaky', simTopologyKeys: [], topology: resistorBetween('element') },
    'test.opaque': { kind: 'test.opaque', simTopologyKeys: [], topology: resistorBetween('element') },
    'test.resistor': { kind: 'test.resistor', simTopologyKeys: [], topology: resistorBetween('element') },
    'test.rheostat': {
      kind: 'test.rheostat',
      simTopologyKeys: [],
      topology: ({ state }) => ({
        joins: [],
        elements: [
          {
            part: 'element',
            kind: 'resistor',
            source: null,
            a: 'a',
            b: 'b',
            values: { ohms: state['ohms'] as number },
          },
        ],
      }),
    },
    'test.reactor': { kind: 'test.reactor', simTopologyKeys: [], topology: resistorBetween('element') },
    'test.acTwin': {
      kind: 'test.acTwin',
      simTopologyKeys: [],
      topology: () => ({
        joins: [],
        elements: ['cellA', 'cellB'].map((part) => ({
          part,
          kind: 'vsource' as const,
          source: 'ac' as const,
          a: 'n',
          b: 'l',
          values: {},
        })),
      }),
    },
    'test.twinSupply': {
      kind: 'test.twinSupply',
      simTopologyKeys: [],
      topology: () => ({
        joins: [],
        elements: ['cellA', 'cellB'].map((part) => ({
          part,
          kind: 'vsource' as const,
          source: 'dc' as const,
          a: 'neg',
          b: 'pos',
          values: {},
        })),
      }),
    },
    'test.orderA': { kind: 'test.orderA', simTopologyKeys: [], topology: noElements },
    'test.orderB': { kind: 'test.orderB', simTopologyKeys: [], topology: noElements },
  },
  connections: TEST_MODELS.connections,
};

/** ±5 % on the cold resistance, drawn from the device's seeded stream (a per-device tolerance). */
export const THERMAL_TOLERANCE = 0.05;

const thermalLoad: SimDeviceModel = {
  kind: 'test.thermalLoad',
  output: {
    kind: 'test.thermalLoad',
    recordBytes: 16,
    fields: [
      { name: 'powerW', type: 'f64', offset: 0, unit: 'W', values: null },
      { name: 'tempK', type: 'f64', offset: 8, unit: 'K', values: null },
    ],
  },
  bank(devices: readonly SimDevice[]): SimDeviceBank {
    const n = devices.length;
    const temp = new Float64Array(n);
    const r0 = new Float64Array(n);
    const branch = new Int32Array(n);
    const p = devices.map((d) => d.params as typeof THERMAL_PARAMS);
    devices.forEach((d, i) => {
      const t = d.bag['tempK'];
      temp[i] = typeof t === 'number' ? t : p[i].ambientK; // a null-initial key: set on entering the netlist
      r0[i] = p[i].coldResistanceOhm * (1 + THERMAL_TOLERANCE * (2 * d.stream().nextFloat() - 1));
      branch[i] = d.branches[0];
    });
    const resistance = (i: number) => Math.max(r0[i] * (1 + p[i].alphaPerK * (temp[i] - p[i].ambientK)), 0.01 * r0[i]);
    // I²R from the solution and the bag's temperature: never cached between steps (a record must
    // follow from the exported state).
    const power = (i: number, ctx: LayerContext) => {
      const island = ctx.netlist.branches[branch[i]].island;
      if (!ctx.islandReadable(island)) return 0;
      // |I|² from the phasor (im is 0 on a DC island): the RMS power I²R either way.
      const re = ctx.solution.branches[2 * branch[i]];
      const im = ctx.solution.branches[2 * branch[i] + 1];
      return (re * re + im * im) * resistance(i);
    };
    return {
      bag: (i) => ({ tempK: temp[i] }),
      dcValue: (i, b, values) => {
        values.resistor(b.index, resistance(i));
        return true;
      },
      acValue: (i, b, values) => {
        values.resistor(b.index, resistance(i));
        return true;
      },
      continuous: (ctx) => {
        for (let i = 0; i < n; i++) {
          temp[i] += (ctx.dtS * (power(i, ctx) - p[i].lossWPerK * (temp[i] - p[i].ambientK))) / p[i].heatCapacityJPerK;
        }
      },
      writeRecord: (i, view, offset, ctx) => {
        view.setFloat64(offset, power(i, ctx), true);
        view.setFloat64(offset + 8, temp[i], true);
      },
    };
  },
};

const i2tFuse: SimDeviceModel = {
  kind: 'test.i2tFuse',
  output: {
    kind: 'test.i2tFuse',
    recordBytes: 16,
    fields: [
      { name: 'meltFraction', type: 'f64', offset: 0, unit: null, values: null },
      { name: 'state', type: 'u8', offset: 8, unit: null, values: ['intact', 'blown'] },
    ],
  },
  bank(devices) {
    const n = devices.length;
    const blown = new Uint8Array(n);
    const heat = new Float64Array(n);
    const melt = new Float64Array(n);
    const ohms = new Float64Array(n);
    const branch = new Int32Array(n);
    const entities = new Int32Array(n);
    devices.forEach((d, i) => {
      blown[i] = d.bag['blown'] === true ? 1 : 0;
      heat[i] = d.bag['heatA2s'] as number;
      melt[i] = d.params['meltA2s'];
      ohms[i] = d.params['resistanceOhm'];
      branch[i] = blown[i] === 1 ? -1 : d.branches[0];
      entities[i] = d.entity;
    });
    return {
      bag: (i) => ({ blown: blown[i] === 1, heatA2s: heat[i] }),
      dcValue: (i, b, values) => {
        values.resistor(b.index, ohms[i]);
        return true;
      },
      acValue: (i, b, values) => {
        values.resistor(b.index, ohms[i]);
        return true;
      },
      protection: (ctx) => {
        let changed = false;
        for (let i = 0; i < n; i++) {
          if (blown[i] === 1 || !ctx.islandReadable(ctx.netlist.branches[branch[i]].island)) continue;
          const re = ctx.solution.branches[2 * branch[i]];
          const im = ctx.solution.branches[2 * branch[i] + 1];
          heat[i] += (re * re + im * im) * ctx.dtS;
          if (heat[i] >= melt[i]) {
            blown[i] = 1;
            ctx.emit('blown', entities[i]);
            changed = true;
          }
        }
        return changed;
      },
      writeRecord: (i, view, offset) => {
        view.setFloat64(offset, Math.min(heat[i] / melt[i], 1), true);
        view.setUint8(offset + 8, blown[i]);
      },
    };
  },
};

const flip: SimDeviceModel = {
  kind: 'test.flip',
  output: null,
  bank(devices) {
    const params = devices.map((d) => d.params);
    return {
      bag: () => ({}),
      dcValue: (i, b, values) => {
        values.resistor(b.index, params[i]['lowOhm']);
        return true;
      },
      iterate: (i, b, iterate, values) => {
        const amps = iterate === null ? 0 : Math.abs(iterate.branches[2 * b.index]);
        values.resistor(b.index, amps > params[i]['thresholdA'] ? params[i]['highOhm'] : params[i]['lowOhm']);
      },
    };
  },
};

const droop: SimDeviceModel = {
  kind: 'test.droop',
  output: null,
  bank(devices) {
    const params = devices.map((d) => d.params);
    const r = (i: number, amps: number) => params[i]['coldOhm'] * (1 + params[i]['perAmp'] * Math.abs(amps));
    return {
      bag: () => ({}),
      dcValue: (i, b, values) => {
        values.resistor(b.index, r(i, 0));
        return true;
      },
      iterate: (i, b, iterate, values) =>
        values.resistor(b.index, r(i, iterate === null ? 0 : iterate.branches[2 * b.index])),
    };
  },
};

const acTwin: SimDeviceModel = {
  kind: 'test.acTwin',
  output: null,
  bank: () => ({
    bag: () => ({}),
    acValue: (_i, b, values) => {
      values.vsourcePolar(b.index, b.element.kind === 'entity' && b.element.part === 'cellA' ? 120 : 121, 0, 0);
      return true;
    },
  }),
};

const reactor: SimDeviceModel = {
  kind: 'test.reactor',
  output: null,
  bank(devices) {
    const params = devices.map((d) => d.params);
    return {
      bag: () => ({}),
      dcValue: (i, b, values) => {
        values.resistor(b.index, params[i]['dcOhm']);
        return true;
      },
      acValue: (i, b, values) => {
        values.inductor(b.index, params[i]['henries']);
        return true;
      },
    };
  },
};

const resistor: SimDeviceModel = {
  kind: 'test.resistor',
  output: null,
  bank(devices) {
    const ohms = devices.map((d) => d.params['ohms']);
    return {
      bag: () => ({}),
      dcValue: (i, b, values) => {
        values.resistor(b.index, ohms[i]);
        return true;
      },
      acValue: (i, b, values) => {
        values.resistor(b.index, ohms[i]);
        return true;
      },
    };
  },
};

const rheostat: SimDeviceModel = {
  kind: 'test.rheostat',
  output: null,
  bank: () => ({
    bag: () => ({}),
    dcValue: (_i, b, values) => {
      values.resistor(b.index, b.values['ohms']);
      return true;
    },
    // The same resistance at 60 Hz (F2.5 part 2: a breaker's load on a utility service).
    acValue: (_i, b, values) => {
      values.resistor(b.index, b.values['ohms']);
      return true;
    },
  }),
};

/** Deliberately wrong: `steps` lives only in the bank, so a rebuild or a load forgets it. */
const leaky: SimDeviceModel = {
  kind: 'test.leaky',
  output: null,
  bank(devices) {
    const steps = new Float64Array(devices.length);
    return {
      bag: () => ({}),
      dcValue: (i, b, values) => {
        values.resistor(b.index, 1 + 0.01 * steps[i]);
        return true;
      },
      continuous: () => {
        for (let i = 0; i < steps.length; i++) steps[i]++;
      },
    };
  },
};

/** The test AC source: its nominal RMS EMF at 0° behind 0.1 Ω (test values, never a real supply's). */
export const AC_SOURCE_OHMS = 0.1;
const acSource: SimDeviceModel = {
  kind: 'test.acSource',
  output: null,
  bank(devices) {
    const volts = devices.map((d) => d.params['nominalVoltageV']);
    return {
      bag: () => ({}),
      acValue: (i, b, values) => {
        values.vsourcePolar(b.index, volts[i], 0, AC_SOURCE_OHMS);
        return true;
      },
    };
  },
};

const twinSupply: SimDeviceModel = {
  kind: 'test.twinSupply',
  output: null,
  bank: () => ({
    bag: () => ({}),
    dcValue: (_i, b, values) => {
      values.vsource(b.index, b.element.kind === 'entity' && b.element.part === 'cellA' ? 12 : 13, 0);
      return true;
    },
  }),
};

/** A layer-order probe: each layer call appends `<kind>:<layer>@<tick>` to `journal`. */
function orderProbe(kind: string, journal: string[]): SimDeviceModel {
  return {
    kind,
    output: null,
    bank(devices) {
      const steps = new Float64Array(devices.map((d) => d.bag['steps'] as number));
      return {
        bag: (i) => ({ steps: steps[i] }),
        discrete: (ctx) => {
          journal.push(`${kind}:discrete@${ctx.tick}`);
          return false;
        },
        continuous: (ctx) => {
          journal.push(`${kind}:continuous@${ctx.tick}`);
          for (let i = 0; i < steps.length; i++) steps[i]++;
        },
        protection: (ctx) => {
          journal.push(`${kind}:protection@${ctx.tick}`);
          return false;
        },
      };
    },
  };
}

/** Engine options over the test catalogue and models; the order probes journal into `journal`. */
export function engineTestOptions(journal: string[] = []): Required<SimEngineOptions> {
  return {
    catalog: ENGINE_TEST_CATALOG,
    netlistModels: ENGINE_TEST_MODELS,
    deviceModels: {
      ...BUILTIN_DEVICE_MODELS,
      'test.resistor': resistor,
      'test.rheostat': rheostat,
      'test.thermalLoad': thermalLoad,
      'test.i2tFuse': i2tFuse,
      'test.flip': flip,
      'test.twinSupply': twinSupply,
      'test.acSource': acSource,
      'test.reactor': reactor,
      'test.acTwin': acTwin,
      'test.droop': droop,
      'test.orderA': orderProbe('test.orderA', journal),
      'test.orderB': orderProbe('test.orderB', journal),
    },
  };
}

/** A world bus over an empty world (seed `seed`) on the engine test catalogue. */
export function engineBus(seed = 11, world: World = createWorld({ seed })): CommandBus<World> {
  return createWorldBus(world, createWorldRegistry({ catalog: ENGINE_TEST_CATALOG }));
}

/**
 * The engine bench's commands, as `[id, args]`: a battery (1), an SPST switch (2), a thermal load (3)
 * and an I²t fuse (4) in one loop, battery + → switch → fuse → load → battery −, then the switch
 * closed. About 5 A flows; the fuse melts after about 0.15 s (4 A²s), and the load heats until it does.
 */
export const ENGINE_BENCH: readonly (readonly [string, object])[] = [
  ['entity.place', { ref: BATTERY, positionMm: origin }],
  ['entity.place', { ref: SPST, positionMm: origin }],
  ['entity.place', { ref: THERMAL_LOAD, positionMm: origin }],
  ['entity.place', { ref: I2T_FUSE, positionMm: origin }],
  ['lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'a') }],
  ['lead.connect', { ref: LEAD, a: end(2, 'b'), b: end(4, 'a') }],
  ['lead.connect', { ref: LEAD, a: end(4, 'b'), b: end(3, 'a') }],
  ['lead.connect', { ref: LEAD, a: end(3, 'b'), b: end(1, 'neg') }],
  ['device.operate', { id: 2, control: 'closed', value: true }],
];

/** {@link engineTestOptions} plus the deliberately leaky model: the save-and-load property must fail on it. */
export function leakyTestOptions(): Required<SimEngineOptions> {
  const options = engineTestOptions();
  return { ...options, deviceModels: { ...options.deviceModels, 'test.leaky': leaky } };
}
