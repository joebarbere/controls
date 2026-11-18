import type { BreakerParams, FuseParams, GfciBreakerParams, PlugOnBreakerParams } from '@controls/catalog';
import type { DeviceNetlistModel, DeviceTopology, DeviceTopologyInput, ElementSpec } from '../../netlist/models';

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

/*
 * Breakers v2 (P4 D6–D8, ADR 0021 part 2). Every pole is a branch (its current heats the bimetal and
 * reaches the magnetic coil), never a join. The compiler hands each kind its sim topology keys projected
 * to booleans (`tripped`; a GFCI's `testHeldSinceTick` as "held or not"). The handle and a trip open
 * every pole at once (a common trip). The GFCI's and AFCI's neutral runs from the pigtail through the
 * breaker's sensor to the load-neutral terminal, never switched (a branch, so its current is known); a
 * GFCI's held test closes its internal test resistor from the load-side hot to the pigtail (around the
 * neutral sensor), so the residual it draws is a real current. In the wiring view (`wiringGraph`) every
 * pole and the neutral path are line → load paths whatever the handle, a trip or a test.
 */

const pole = (part: string, a: string, b: string, ohms: number): ElementSpec => ({
  part,
  kind: 'resistor',
  source: null,
  a,
  b,
  values: { resistanceOhm: ohms },
});

const isClosed = (state: DeviceTopologyInput['state'], sim: DeviceTopologyInput['sim']): boolean =>
  state['on'] === true && sim['tripped'] !== true;

const plugOn1p = (params: Readonly<Record<string, number>>): DeviceTopology => ({
  joins: [],
  elements: [pole('pole', 'line', 'load', (params as PlugOnBreakerParams).contactResistanceOhm)],
});

/** A single-pole plug-on breaker (`breaker.plugOn1p`): its pole `line` → `load` while closed. */
export const plugOn1pNetlistModel: DeviceNetlistModel = {
  kind: 'breaker.plugOn1p',
  simTopologyKeys: ['tripped'],
  topology: ({ params, state, sim }) => (isClosed(state, sim) ? plugOn1p(params) : OPEN),
  wiring: ({ params }) => plugOn1p(params),
  wiringPath: true,
};

const plugOn2p = (params: Readonly<Record<string, number>>): DeviceTopology => {
  const ohms = (params as PlugOnBreakerParams).contactResistanceOhm;
  return { joins: [], elements: [pole('pole1', 'line1', 'load1', ohms), pole('pole2', 'line2', 'load2', ohms)] };
};

/** A two-pole plug-on breaker (`breaker.plugOn2p`): both poles while closed, neither once tripped (common trip). */
export const plugOn2pNetlistModel: DeviceNetlistModel = {
  kind: 'breaker.plugOn2p',
  simTopologyKeys: ['tripped'],
  topology: ({ params, state, sim }) => (isClosed(state, sim) ? plugOn2p(params) : OPEN),
  wiring: ({ params }) => plugOn2p(params),
  wiringPath: true,
};

/** A GFCI or AFCI breaker's elements: the neutral always, the pole while closed, a GFCI's test resistor while held. */
function sensingBreaker(params: Readonly<Record<string, number>>, closed: boolean, testHeld: boolean): DeviceTopology {
  const ohms = (params as PlugOnBreakerParams).contactResistanceOhm;
  const elements: ElementSpec[] = [pole('neutral', 'pigtail', 'loadNeutral', ohms)];
  if (closed) elements.push(pole('pole', 'line', 'load', ohms));
  if (testHeld) elements.push(pole('test', 'load', 'pigtail', (params as GfciBreakerParams).testResistanceOhm));
  return { joins: [], elements };
}

/**
 * A GFCI breaker (`breaker.gfci1p`): the pole `line` → `load` while closed, the neutral `pigtail` →
 * `loadNeutral` always, and the test resistor `load` → `pigtail` while a test is held.
 */
export const gfci1pNetlistModel: DeviceNetlistModel = {
  kind: 'breaker.gfci1p',
  simTopologyKeys: ['tripped', 'testHeldSinceTick'],
  topology: ({ params, state, sim }) => sensingBreaker(params, isClosed(state, sim), sim['testHeldSinceTick'] === true),
  // The test resistor is never a wiring path: it would join the load-side hot to the neutral.
  wiring: ({ params }) => sensingBreaker(params, true, false),
  wiringPath: true,
};

/** A combination AFCI breaker (`breaker.afci1p`): the pole while closed and the neutral always (no test resistor). */
export const afci1pNetlistModel: DeviceNetlistModel = {
  kind: 'breaker.afci1p',
  simTopologyKeys: ['tripped'],
  topology: ({ params, state, sim }) => sensingBreaker(params, isClosed(state, sim), false),
  wiring: ({ params }) => sensingBreaker(params, true, false),
  wiringPath: true,
};
