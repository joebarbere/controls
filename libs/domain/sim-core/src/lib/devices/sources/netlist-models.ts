import type { DeviceNetlistModel } from '../../netlist/models';

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
