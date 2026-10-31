import type { BatteryParams, LampIncandescentParams, LeadParams } from '@controls/catalog';
import { leadResistanceOhm } from '@controls/catalog';
import { LEAD_CONDUCTOR_TEMPERATURE_K } from '../constants';
import {
  benchSupplyNetlistModel,
  dinPsuNetlistModel,
  generatorPortableNetlistModel,
  utilitySplitPhaseNetlistModel,
  utilityThreePhaseNetlistModel,
} from '../devices/sources/netlist-models';
import type { ElementKind, SourceDomain, StateBag } from './types';

/*
 * What the netlist compiler needs to know about each model kind (plan F2.1), and nothing more: which
 * terminals a device joins ideally, which elements it holds between which terminals, and when. The
 * electrical behaviour of each element (stamps, R(T), EMF against state of charge) belongs to the
 * device models of F2.4 and F2.5.
 *
 * A model reads only the catalogue entry's parameters, the entity's commanded `state` bag and, for the
 * keys it lists in `simTopologyKeys`, sim-owned state handed in by the engine (a fuse that blew, a
 * breaker that tripped). It never reads the world's inert `sim` bag directly (ADR 0011 §1): the
 * compiler passes it the engine's values.
 */

/** One element inside a device, between two of its terminals. */
export interface ElementSpec {
  /** Unique within the device; branches of one entity are ordered by it (code units). */
  readonly part: string;
  readonly kind: ElementKind;
  readonly source: SourceDomain | null;
  /** Terminal ids of the device. For a `vsource`, `a` is the negative end. */
  readonly a: string;
  readonly b: string;
  /** Values derived from params and commanded state; never in the topology hash. */
  readonly values: Readonly<Record<string, number>>;
}

/** A device's topology at one moment. */
export interface DeviceTopology {
  /** Groups of terminals joined ideally (each at least two). A closed switch is `[['a', 'b']]`. */
  readonly joins: readonly (readonly string[])[];
  readonly elements: readonly ElementSpec[];
}

export interface DeviceTopologyInput {
  /** The catalogue entry's `model.params`, already validated against the kind's schema. */
  readonly params: Readonly<Record<string, number>>;
  /** The entity's commanded state bag. */
  readonly state: StateBag;
  /** The engine's sim-owned state for this entity (only `simTopologyKeys` may be read). */
  readonly sim: StateBag;
}

/** The netlist model of a placed device kind. */
export interface DeviceNetlistModel {
  readonly kind: string;
  /**
   * Sim-owned keys that change the topology (a fuse's `blown`, a breaker's `tripped`). The
   * incremental compiler recompiles a device when one of them changes. Empty for the P2 bench kinds.
   */
  readonly simTopologyKeys: readonly string[];
  /** Pure. Terminal ids must be the kind's; parts unique. */
  topology(input: DeviceTopologyInput): DeviceTopology;
}

/** The netlist model of a connection kind (a test lead; wires from P3): one element, `a` to `b`. */
export interface ConnectionNetlistModel {
  readonly kind: string;
  /** Pure, from the catalogue entry's params. Exactly one branch per connection (ADR 0011 §7). */
  element(params: Readonly<Record<string, number>>): {
    readonly kind: ElementKind;
    readonly values: Readonly<Record<string, number>>;
  };
}

const NO_JOINS: readonly (readonly string[])[] = [];

/**
 * A battery: one cell, a DC source from `neg` to `pos` behind its internal resistance. Its EMF follows
 * the state of charge at solve time (F2.4's engine model); the values carry the full-charge EMF for
 * `DC_DEFAULT_VALUES`, the value of a new battery when no engine model runs.
 */
const battery: DeviceNetlistModel = {
  kind: 'battery',
  simTopologyKeys: [],
  topology: ({ params }) => {
    const p = params as BatteryParams;
    return {
      joins: NO_JOINS,
      elements: [
        {
          part: 'cell',
          kind: 'vsource',
          source: 'dc',
          a: 'neg',
          b: 'pos',
          values: {
            internalResistanceOhm: p.internalResistanceOhm,
            openCircuitVoltageFullV: p.openCircuitVoltageFullV,
          },
        },
      ],
    };
  },
};

/** An incandescent lamp: its filament, a resistance between `a` and `b` whose value F2.5's R(T) gives. */
const lampIncandescent: DeviceNetlistModel = {
  kind: 'lamp.incandescent',
  simTopologyKeys: [],
  topology: ({ params }) => {
    const p = params as LampIncandescentParams;
    return {
      joins: NO_JOINS,
      elements: [
        {
          part: 'filament',
          kind: 'resistor',
          source: null,
          a: 'a',
          b: 'b',
          values: { ratedPowerW: p.ratedPowerW, ratedVoltageV: p.ratedVoltageV },
        },
      ],
    };
  },
};

const SPST_CLOSED: DeviceTopology = { joins: [['a', 'b']], elements: [] };
const SPST_OPEN: DeviceTopology = { joins: NO_JOINS, elements: [] };

/**
 * An ideal SPST switch: closed joins its terminals into one node with no branch; open drops it, so
 * the terminals are separate nodes. Its current is the current of the leads at either side.
 */
const switchSpst: DeviceNetlistModel = {
  kind: 'switch.spst',
  simTopologyKeys: [],
  topology: ({ state }) => (state['closed'] === true ? SPST_CLOSED : SPST_OPEN),
};

/**
 * A test lead: a resistance from resistivity × length ÷ area at the bench temperature, plus the clip
 * contact resistance at each end (`leadResistanceOhm`, ADR 0013; never from conductor tables).
 */
const lead: ConnectionNetlistModel = {
  kind: 'lead',
  element: (params) => ({
    kind: 'resistor',
    values: { resistanceOhm: leadResistanceOhm(params as LeadParams, LEAD_CONDUCTOR_TEMPERATURE_K.value) },
  }),
};

/** The device netlist models, by model kind. A test checks every placed kind in `MODEL_KINDS` has one. */
export const DEVICE_NETLIST_MODELS: Readonly<Record<string, DeviceNetlistModel>> = Object.freeze({
  battery,
  'generator.portable': generatorPortableNetlistModel,
  'lamp.incandescent': lampIncandescent,
  'supply.bench': benchSupplyNetlistModel,
  'supply.dinPsu': dinPsuNetlistModel,
  'switch.spst': switchSpst,
  'utility.splitPhase': utilitySplitPhaseNetlistModel,
  'utility.threePhase': utilityThreePhaseNetlistModel,
});

/** The connection netlist models, by model kind. A test checks every connection kind in `MODEL_KINDS` has one. */
export const CONNECTION_NETLIST_MODELS: Readonly<Record<string, ConnectionNetlistModel>> = Object.freeze({ lead });

/** The models a compiler uses: the built-in ones by default, synthetic ones in tests. */
export interface NetlistModels {
  readonly devices: Readonly<Record<string, DeviceNetlistModel>>;
  readonly connections: Readonly<Record<string, ConnectionNetlistModel>>;
}

export const BUILTIN_NETLIST_MODELS: NetlistModels = Object.freeze({
  devices: DEVICE_NETLIST_MODELS,
  connections: CONNECTION_NETLIST_MODELS,
});

/** `table[kind]` for own properties only (`toString` is not a kind). */
export function ownModel<T>(table: Readonly<Record<string, T>>, kind: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, kind) ? table[kind] : undefined;
}
