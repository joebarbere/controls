import { LEAD_SIM_BAG_V3 } from '@controls/save-format';

/*
 * A TEST-ONLY wired world v3 document over `WIRING_TEST_CATALOG` (`wiring-catalog.ts`): what the load
 * check and the world v3 guards of the existing commands are tested against (P3 PR 7).
 */

export const Z = { yaw: 0, pitch: 0, roll: 0 };
export const at = (x: number, y: number, z: number) => ({ x, y, z });
export const SPLIT = { id: 'utility.larkmoor-split-phase-25kva', version: 1 };
export const BREAKER = { id: 'breaker.saltmere-1p-15a', version: 1 };
export const BATTERY = { id: 'battery.ferrovane-12v-7ah', version: 1 };
export const BOX = { id: 'box.test-1gang', version: 1 };
export const PANEL = { id: 'panel.test-din', version: 1 };
export const WIRE = { id: 'conductor.test-14', version: 1 };
export const BARE = { id: 'conductor.test-14-bare', version: 1 };
export const LEAD = { id: 'lead.quillfern-test-1m', version: 1 };
export const CABLE = { id: 'cable.test-14-2', version: 1 };
export const BIT = { id: 'tool.test-bit-19', version: 1 };
export const FERRULE = { id: 'ferrule.test-14', version: 1 };
export const LUG = { id: 'lug.test-ring-14', version: 1 };
export const STRANDED = { id: 'conductor.test-14-str', version: 1 };
export const WIRE_10 = { id: 'conductor.test-10', version: 1 };
export const BLOCK = { id: 'tb.test-2', version: 1 };
export const CUTTER = { id: 'tool.test-cutter', version: 1 };
export const STRIPPER = { id: 'tool.test-stripper', version: 1 };
export const SCREWDRIVER = { id: 'tool.test-screwdriver', version: 1 };
export const TORQUE = { id: 'tool.test-torque', version: 1 };
export const CRIMPER = { id: 'tool.test-crimper', version: 1 };
export const LABELLER = { id: 'tool.test-labeller', version: 1 };
export const FISH_TAPE = { id: 'tool.test-fishtape', version: 1 };
export const PUNCH = { id: 'tool.test-punch', version: 1 };
export const NUT_DRIVER = { id: 'tool.test-nutdriver', version: 1 };

export type Doc = Record<string, unknown> & {
  entities: Record<string, unknown>[];
  connections: Record<string, unknown>[];
  cables: Record<string, unknown>[];
};

export const entity = (id: number, ref: object, position: object, overrides: Record<string, unknown> = {}) => ({
  id,
  ref,
  transform: { positionMm: position, orientationMdeg: Z },
  state: {},
  sim: {},
  mountedOn: null,
  label: null,
  extensions: {},
  ...overrides,
});
export const termination = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  method: 'screw',
  auto: false,
  stripLengthMm: 13,
  nickedStrandFraction: 0,
  torqueNm: 4,
  accessory: null,
  ...overrides,
});
export const free = (position: object) => ({
  kind: 'free',
  positionMm: position,
  entity: null,
  fixture: null,
  tool: null,
});
export const connection = (id: number, overrides: Record<string, unknown>) => ({
  id,
  ref: WIRE,
  a: null,
  b: null,
  cable: null,
  route: null,
  lengthMm: 3000,
  colour: { base: 'black', stripe: null },
  label: null,
  state: {},
  sim: { ...LEAD_SIM_BAG_V3 },
  extensions: {},
  ...overrides,
});

/**
 * A split-phase stand-in (1), a 1-gang box with `ko1` open (2), a DIN panel (3) with a breaker on its
 * rail (4) and a battery (5); a conductor from L1 to the breaker's line screw; a 14/2 cable from a free
 * end into the box, its black landed on L2; a test lead from the battery.
 */
export function wiredWorldDoc(): Doc {
  return {
    schemaVersion: 3,
    seed: 1,
    tick: 0,
    nextEntityId: 6,
    nextConnectionId: 6,
    nextCableId: 2,
    nextTerminationId: 4,
    regionId: 'nec',
    difficulty: 'apprentice',
    assisted: false,
    fixtures: [],
    entities: [
      entity(1, SPLIT, at(0, 900, -2000)),
      entity(2, BOX, at(1000, 1000, -2000), { state: { openEntries: 2 } }),
      entity(3, PANEL, at(0, 0, -2000), { state: { openEntries: 0 } }),
      entity(4, BREAKER, at(100, 255, -1955), {
        state: { on: false },
        sim: { thermal: 0, tripped: false },
        mountedOn: { entity: 3, mount: 'rail-1' },
      }),
      entity(5, BATTERY, at(-500, 0, 0), { sim: { stateOfCharge: 1 } }),
    ],
    connections: [
      connection(1, {
        a: { entity: 1, terminal: 'l1', termination: termination(1) },
        b: { entity: 4, terminal: 'line', termination: termination(2) },
        route: [free(at(50, 1150, -1700))],
        lengthMm: 2000,
      }),
      connection(2, {
        a: { entity: 1, terminal: 'l2', termination: termination(3) },
        cable: { id: 1, conductor: 0 },
      }),
      connection(3, { cable: { id: 1, conductor: 1 }, colour: { base: 'white', stripe: null } }),
      connection(4, { ref: BARE, cable: { id: 1, conductor: 2 }, colour: { base: 'bare', stripe: null } }),
      connection(5, {
        ref: LEAD,
        a: { entity: 5, terminal: 'pos', termination: null },
        b: { entity: 5, terminal: 'neg', termination: null },
        lengthMm: null,
        colour: null,
      }),
    ],
    cables: [
      {
        id: 1,
        ref: CABLE,
        a: null,
        b: { entity: 2, entry: 'ko1' },
        route: [free(at(0, 1100, -1800))],
        lengthMm: 3000,
        tailsMm: { a: 300, b: 300 },
        jacketStripMm: { a: 150, b: 150 },
        label: null,
        extensions: {},
      },
    ],
    sim: null,
    extensions: {},
  };
}
