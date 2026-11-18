import type { BreakerParams, FuseParams } from '@controls/catalog';
import type { DeviceNetlistModel, DeviceTopology } from '../../netlist/models';

/*
 * The netlist models of F2.5's protective devices. Both compile to a **branch**, never a join, while
 * closed: their current is what heats them (the simulation caveats' "ideal joins carry no current").
 * Open (a fuse blown, a breaker off or tripped), they have no element at all, so their terminals are
 * separate nodes. Their sim topology keys (`blown`, `tripped`) come from the engine's live state.
 */

const OPEN: DeviceTopology = { joins: [], elements: [] };

const fuseLink = (params: Readonly<Record<string, number>>): DeviceTopology => ({
  joins: [],
  elements: [
    {
      part: 'link',
      kind: 'resistor',
      source: null,
      a: 'a',
      b: 'b',
      values: { resistanceOhm: (params as FuseParams).resistanceOhm },
    },
  ],
});

/**
 * A fuse (`fuse`): its link, a resistance from `a` to `b`, until it has blown. In the wiring view
 * (engine 8, `wiringGraph`) the link is always there: a protective device is a line → load path.
 */
export const fuseNetlistModel: DeviceNetlistModel = {
  kind: 'fuse',
  simTopologyKeys: ['blown'],
  topology: ({ params, sim }) => (sim['blown'] === true ? OPEN : fuseLink(params)),
  wiring: ({ params }) => fuseLink(params),
  wiringPath: true,
};

const breakerPole = (params: Readonly<Record<string, number>>): DeviceTopology => ({
  joins: [],
  elements: [
    {
      part: 'pole',
      kind: 'resistor',
      source: null,
      a: 'line',
      b: 'load',
      values: { resistanceOhm: (params as BreakerParams).contactResistanceOhm },
    },
  ],
});

/**
 * A thermal-magnetic breaker (`breaker.thermalMagnetic`): its pole, the contact resistance from `line`
 * to `load`, while the handle is on (commanded `on`) and it hasn't tripped (sim `tripped`).
 */
export const breakerNetlistModel: DeviceNetlistModel = {
  kind: 'breaker.thermalMagnetic',
  simTopologyKeys: ['tripped'],
  topology: ({ params, state, sim }) => (state['on'] !== true || sim['tripped'] === true ? OPEN : breakerPole(params)),
  // The wiring view (engine 8): the pole is a line → load path whatever the handle or a trip.
  wiring: ({ params }) => breakerPole(params),
  wiringPath: true,
};
