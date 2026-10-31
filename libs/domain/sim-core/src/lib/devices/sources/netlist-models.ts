import type { DeviceNetlistModel, DeviceTopology, ElementSpec } from '../../netlist/models';

/*
 * The netlist models of F2.4's placed sources (plan F2.1's `DeviceNetlistModel`): what the compiler
 * needs, and nothing else. Kept apart from the engine models, and importing only types, so
 * `netlist/models.ts` can register them without an import cycle through the solver.
 */

/**
 * The bench supply (`supply.bench`): one regulated output element from `neg` to `pos`, carrying the
 * commanded state as netlist values (`outputOn` 1 or 0), so a setpoint change is a value change.
 */
export const benchSupplyNetlistModel: DeviceNetlistModel = {
  kind: 'supply.bench',
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
        values: {
          currentLimitA: state['currentLimitA'] as number,
          outputOn: state['outputOn'] === true ? 1 : 0,
          setpointV: state['setpointV'] as number,
        },
      },
    ],
  }),
};

/** The DIN PSU (`supply.dinPsu`): one regulated output element from `neg` to `pos`; it has no controls. */
export const dinPsuNetlistModel: DeviceNetlistModel = {
  kind: 'supply.dinPsu',
  simTopologyKeys: [],
  topology: () => ({
    joins: [],
    elements: [{ part: 'output', kind: 'vsource', source: 'dc', a: 'neg', b: 'pos', values: {} }],
  }),
};

/** One winding of an AC source: a phasor source from the neutral `n` to the line terminal `line`. */
const winding = (line: string): ElementSpec => ({
  part: line,
  kind: 'vsource',
  source: 'ac',
  a: 'n',
  b: line,
  values: {},
});

/**
 * A split-phase AC source (`utility.splitPhase`, `generator.portable`): two windings from the neutral,
 * `l1` and `l2`, each a phasor source behind its half of the impedance. L1, L2 and N are separate
 * nodes; the neutral is the island's reference (the negative end of its first source).
 */
const SPLIT_PHASE: DeviceTopology = { joins: [], elements: [winding('l1'), winding('l2')] };

export const utilitySplitPhaseNetlistModel: DeviceNetlistModel = {
  kind: 'utility.splitPhase',
  simTopologyKeys: [],
  topology: () => SPLIT_PHASE,
};

export const generatorPortableNetlistModel: DeviceNetlistModel = {
  kind: 'generator.portable',
  simTopologyKeys: [],
  topology: () => SPLIT_PHASE,
};

/** A three-phase wye source (`utility.threePhase`): `l1`, `l2` and `l3` from the neutral `n`. */
const THREE_PHASE: DeviceTopology = { joins: [], elements: [winding('l1'), winding('l2'), winding('l3')] };

export const utilityThreePhaseNetlistModel: DeviceNetlistModel = {
  kind: 'utility.threePhase',
  simTopologyKeys: [],
  topology: () => THREE_PHASE,
};
