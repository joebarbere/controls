import type { DeviceNetlistModel, DeviceTopology, ElementSpec } from '../../netlist/models';

/*
 * The netlist models of P4 F4.1 part 1's lighting kinds (D10, D11). Kept apart from the engine models,
 * as the sources' and loads' are, so `netlist/models.ts` can register them without an import cycle.
 *
 * - **Wall switches** join terminals ideally, as `switch.spst` does (P2: a switch's current is the
 *   current of the conductors either side of it, and a closed contact's few milliohms are left out).
 *   Their position is commanded state, so a flip is a topology change the engine recompiles at the
 *   command's tick. In the wiring view (`wiringGraph`) a switch is closed in every position: the
 *   inspector asks what is wired to what, not what is switched on.
 * - **The dimmer** (`dimmer.wall`) is one series element `line` → `load` while it is on, valued by its
 *   engine model at each solve (a lossless reactance, `dimmer.ts`); off, it is open. Its level travels
 *   as a netlist value, so moving the slider never changes the topology (ADR 0019).
 * - **The lampholder** (`lampholder.e26`) holds nothing: its brass and silver screws are themselves the
 *   socket's centre contact and screw shell (the entry's `e26` host mount names them), so a bulb's two
 *   contact branches land straight on them.
 * - **The LED driver** (`light.led`, `light.ledFixture`) is two parallel elements between its line
 *   terminals, a conductance and a susceptance, both valued by its engine model (`led.ts`).
 *
 * The `ground` terminal of every kind here joins nothing inside the device: a yoke, strap or housing
 * reaches a metal box or the EGC only through what is landed on it or mounted (D3).
 */

const NONE: DeviceTopology = { joins: [], elements: [] };

const join = (...groups: (readonly string[])[]): DeviceTopology => ({ joins: groups, elements: [] });

const WALL_1P_CLOSED = join(['a', 'b']);
const WALL_3WAY_T1 = join(['common', 't1']);
const WALL_3WAY_T2 = join(['common', 't2']);
const WALL_3WAY_WIRING = join(['common', 't1', 't2']);
const WALL_4WAY_STRAIGHT = join(['a1', 'b1'], ['a2', 'b2']);
const WALL_4WAY_CROSSED = join(['a1', 'b2'], ['a2', 'b1']);
const WALL_4WAY_WIRING = join(['a1', 'a2', 'b1', 'b2']);

/** A single-pole wall switch: closed joins `a` and `b`. */
export const switchWall1pNetlistModel: DeviceNetlistModel = {
  kind: 'switch.wall1p',
  simTopologyKeys: [],
  topology: ({ state }) => (state['closed'] === true ? WALL_1P_CLOSED : NONE),
  wiring: () => WALL_1P_CLOSED,
};

/** A 3-way wall switch: `common` joined to the traveller its `position` names (`t1` unless `t2`). */
export const switchWall3wayNetlistModel: DeviceNetlistModel = {
  kind: 'switch.wall3way',
  simTopologyKeys: [],
  topology: ({ state }) => (state['position'] === 't2' ? WALL_3WAY_T2 : WALL_3WAY_T1),
  wiring: () => WALL_3WAY_WIRING,
};

/** A 4-way wall switch: its traveller pairs passed straight (`a1`–`b1`, `a2`–`b2`) or crossed. */
export const switchWall4wayNetlistModel: DeviceNetlistModel = {
  kind: 'switch.wall4way',
  simTopologyKeys: [],
  topology: ({ state }) => (state['position'] === 'crossed' ? WALL_4WAY_CROSSED : WALL_4WAY_STRAIGHT),
  wiring: () => WALL_4WAY_WIRING,
};

/** The dimmer's series element, `line` → `load`, carrying its commanded level. */
const dimmerElement = (level: number): DeviceTopology => ({
  joins: [],
  elements: [{ part: 'phaseControl', kind: 'resistor', source: null, a: 'line', b: 'load', values: { level } }],
});

/** A forward-phase-cut wall dimmer: its series element while on (commanded `on`); open when off. */
export const dimmerWallNetlistModel: DeviceNetlistModel = {
  kind: 'dimmer.wall',
  simTopologyKeys: [],
  topology: ({ state }) => (state['on'] === true ? dimmerElement(levelOf(state['level'])) : NONE),
  // The wiring view: on, a conductive path from line to load (a switching device treated as closed).
  wiring: ({ state }) => dimmerElement(levelOf(state['level'])),
  wiringPath: true,
};

/** A commanded level as a number in [0, 1] (the bag check guarantees it; a hand-built bag may lack it). */
function levelOf(value: unknown): number {
  return typeof value === 'number' ? Math.min(1, Math.max(0, value)) : 1;
}

/** A keyless E26 lampholder: no joins and no elements (its screws are its socket's contacts). */
export const lampholderE26NetlistModel: DeviceNetlistModel = {
  kind: 'lampholder.e26',
  simTopologyKeys: [],
  topology: () => NONE,
};

const PULL_CHAIN_CLOSED = join(['centre', 'hot']);

/**
 * A pull-chain E26 lampholder (`lampholder.e26PullChain`): its switch joins the brass `hot` screw to the
 * sealed `centre` node the socket's centre contact lands on while `closed`; the shell is the `neutral`
 * screw, unswitched. Closed in the wiring view.
 */
export const lampholderE26PullChainNetlistModel: DeviceNetlistModel = {
  kind: 'lampholder.e26PullChain',
  simTopologyKeys: [],
  topology: ({ state }) => (state['closed'] === true ? PULL_CHAIN_CLOSED : NONE),
  wiring: () => PULL_CHAIN_CLOSED,
};

/** The LED driver's two parallel elements between `line` and `neutral`, in part order. */
function ledTopology(line: string, neutral: string): DeviceTopology {
  const element = (part: string): ElementSpec => ({
    part,
    kind: 'resistor',
    source: null,
    a: line,
    b: neutral,
    values: {},
  });
  return { joins: [], elements: [element('conductance'), element('susceptance')] };
}

const LED_BULB = ledTopology('a', 'b');
const LED_FIXTURE = ledTopology('hot', 'neutral');

/** An LED lamp (`light.led`): its driver between the foot `a` and the shell `b`. */
export const lightLedNetlistModel: DeviceNetlistModel = {
  kind: 'light.led',
  simTopologyKeys: [],
  topology: () => LED_BULB,
};

/** An LED fixture (`light.ledFixture`): its driver between `hot` and `neutral`. */
export const lightLedFixtureNetlistModel: DeviceNetlistModel = {
  kind: 'light.ledFixture',
  simTopologyKeys: [],
  topology: () => LED_FIXTURE,
};
