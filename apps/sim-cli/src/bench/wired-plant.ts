import { type ConnectionV3, type EntityV3, LEAD_SIM_BAG_V3, World } from '@controls/save-format';

/*
 * The bench's wired plant (F3.6 part 1, plan P3 "Budgets", ADR 0015, ADR 0018 §10): 1,000 catalogue
 * devices and 2,000 conductors with thermal state, for `tick-wired-plant`'s cadence tick.
 *
 * {@link WIRED_LOOPS} loops, each a battery, a 15 A breaker (handle on), two large wire nuts and a
 * 12 V lamp (five devices): a lead from the battery's + to the breaker's line screw, a 14 AWG solid
 * THHN conductor from the breaker's load screw into nut A, {@link WIRED_PARALLEL} conductors in
 * parallel from nut A to nut B, a lead from nut B to the lamp and a lead from the lamp back to the
 * battery's −. So every conductor is netlisted and carries current (the lamp's 0.43 A, shared), and
 * every conductor end is landed (4,000 hot spots), as in ADR 0018 §10's prototype.
 *
 * **Built directly, as `plant.ts` is**, not by commands: nut A holds 10 conductors where its method is
 * rated for 5, a world `wire.land` would refuse (`combination-out-of-range`). The engine never checks a
 * combination (ADR 0018 §4.4); an over-full nut only lowers its ends' clamp ratio (higher contact R),
 * and the bank's cost per conductor and per end doesn't depend on it. Deterministic: no randomness.
 */

export const WIRED_LOOPS = 200;
export const WIRED_PARALLEL = 9;

const BATTERY = { id: 'battery.ferrovane-12v-7ah', version: 1 };
const BREAKER = { id: 'breaker.saltmere-1p-15a', version: 1 };
const NUT = { id: 'splice.corvelle-tw-l', version: 1 };
const LAMP = { id: 'lamp.lumivane-12v-5w', version: 1 };
const LEAD = { id: 'lead.quillfern-test-1m', version: 1 };
const THHN_14 = { id: 'conductor.tallowmere-thhn-14-solid', version: 1 };

/** The wired plant's world at tick 0 (sim bags initial, no solution). */
export function buildWiredPlant(): World {
  const entities: EntityV3[] = [];
  const connections: ConnectionV3[] = [];
  let terminations = 0;
  const place = (ref: { id: string; version: number }, state: EntityV3['state'], sim: EntityV3['sim']): number => {
    const id = entities.length + 1;
    const positionMm = { x: (id % 100) * 200, y: 0, z: Math.floor(id / 100) * 200 };
    entities.push({
      id,
      ref,
      transform: { positionMm, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } },
      state,
      sim,
      mountedOn: null,
      label: null,
      extensions: {},
    });
    return id;
  };
  const connection = (fields: Partial<ConnectionV3> & Pick<ConnectionV3, 'ref' | 'a' | 'b'>) =>
    connections.push({
      id: connections.length + 1,
      cable: null,
      route: null,
      lengthMm: null,
      colour: null,
      label: null,
      state: {},
      sim: { ...LEAD_SIM_BAG_V3 },
      extensions: {},
      ...fields,
    });
  const lead = (a: number, at: string, b: number, bt: string) =>
    connection({
      ref: LEAD,
      a: { entity: a, terminal: at, termination: null },
      b: { entity: b, terminal: bt, termination: null },
    });
  const end = (entity: number, terminal: string, method: 'screw' | 'twistOn') => ({
    entity,
    terminal,
    termination: {
      id: ++terminations,
      method,
      auto: false,
      stripLengthMm: 13,
      nickedStrandFraction: 0,
      torqueNm: method === 'screw' ? 4 : null,
      accessory: null,
    },
  });
  const conductor = (a: ReturnType<typeof end>, b: ReturnType<typeof end>) =>
    connection({
      ref: THHN_14,
      a,
      b,
      route: [{ kind: 'free', positionMm: { x: 0, y: 300, z: 0 }, entity: null, fixture: null, tool: null }],
      lengthMm: 1000,
      colour: { base: 'black', stripe: null },
    });

  for (let k = 0; k < WIRED_LOOPS; k++) {
    const battery = place(BATTERY, {}, {});
    const breaker = place(BREAKER, { on: true }, {});
    const nutA = place(NUT, {}, {});
    const nutB = place(NUT, {}, {});
    const lamp = place(LAMP, {}, {});
    lead(battery, 'pos', breaker, 'line');
    conductor(end(breaker, 'load', 'screw'), end(nutA, 'splice', 'twistOn'));
    for (let p = 0; p < WIRED_PARALLEL; p++) conductor(end(nutA, 'splice', 'twistOn'), end(nutB, 'splice', 'twistOn'));
    lead(nutB, 'splice', lamp, 'a');
    lead(lamp, 'b', battery, 'neg');
  }
  return World.parse({
    schemaVersion: 3,
    seed: 2026,
    tick: 0,
    nextEntityId: entities.length + 1,
    nextConnectionId: connections.length + 1,
    nextCableId: 1,
    nextTerminationId: terminations + 1,
    regionId: 'nec',
    difficulty: 'apprentice',
    assisted: false,
    fixtures: [],
    entities,
    connections,
    cables: [],
    sim: null,
    extensions: {},
  });
}
