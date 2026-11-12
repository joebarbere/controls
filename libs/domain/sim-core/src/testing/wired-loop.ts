import { LEAD_SIM_BAG_V3, World } from '@controls/save-format';
import { BATTERY } from './bench';
import { HEATER } from './loads';

/*
 * The wired loop of the connection-bank specs (F3.6 parts 1 and 2): real catalogue content, built
 * directly (as the bench plants are), every termination its own id. Specs only.
 */

export const LEAD_REF = { id: 'lead.quillfern-test-1m', version: 1 };
export const BREAKER_REF = { id: 'breaker.saltmere-1p-15a', version: 1 };
export const NUT_REF = { id: 'splice.corvelle-tw-l', version: 1 };
export const THHN_14 = { id: 'conductor.tallowmere-thhn-14-solid', version: 1 };

/** What a spec may vary in {@link wiredLoopWorld}. */
export interface WiredLoopOptions {
  /** The world seed (default 5). */
  readonly seed?: number;
  /** The world tick (default 0). */
  readonly tick?: number;
  /** Merged into conductor 2's sim bag (its end A is the breaker's load screw, termination 1). */
  readonly conductor2Sim?: Readonly<Record<string, number | string | boolean | null>>;
  /** The breaker's load-screw torque (N·m; default 4, the marked torque). */
  readonly loadTorqueNm?: number;
  /**
   * Spread the entities 1 m apart along x and route the conductors over the breaker, so `wire.land`
   * finds no body in the way (default: everything at the origin, as part 1's specs pinned it).
   */
  readonly spread?: boolean;
}

/**
 * A battery (1) through a 15 A breaker (2, handle on) into two wire nuts (3, 4) and the 12 V 50 W
 * heater (5): lead 1 battery + → breaker line; conductor 2 breaker load (screw) → nut 3; conductors 3
 * and 4 nut 3 → nut 4 in parallel; lead 5 nut 4 → heater a; lead 6 heater b → battery −; conductor 7
 * landed in nut 4 at one end, free at the other. About 4 A, so the conductors and their ends warm.
 */
export function wiredLoopWorld(options: WiredLoopOptions = {}): World {
  const spread = options.spread === true;
  const transform = (id: number) => ({
    positionMm: { x: spread ? 1000 * id : 0, y: 0, z: 0 },
    orientationMdeg: { yaw: 0, pitch: 0, roll: 0 },
  });
  const waypoint = spread ? { x: 2000, y: 600, z: 0 } : { x: 0, y: 300, z: 0 };
  const entity = (id: number, ref: { id: string; version: number }, state: Record<string, boolean> = {}) => ({
    id,
    ref,
    transform: transform(id),
    state,
    sim: {},
    mountedOn: null,
    label: null,
    extensions: {},
  });
  const termination = (id: number, method: 'screw' | 'twistOn', torqueNm = 4) => ({
    id,
    method,
    auto: false,
    stripLengthMm: 13,
    nickedStrandFraction: 0,
    torqueNm: method === 'screw' ? torqueNm : null,
    accessory: null,
  });
  const base = { cable: null, label: null, state: {}, extensions: {} };
  const lead = (id: number, a: [number, string], b: [number, string]) => ({
    ...base,
    sim: { ...LEAD_SIM_BAG_V3 },
    id,
    ref: LEAD_REF,
    a: { entity: a[0], terminal: a[1], termination: null },
    b: { entity: b[0], terminal: b[1], termination: null },
    route: null,
    lengthMm: null,
    colour: null,
  });
  const conductor = (id: number, a: object | null, b: object | null, sim: object = {}) => ({
    ...base,
    sim: { ...LEAD_SIM_BAG_V3, ...sim },
    id,
    ref: THHN_14,
    a,
    b,
    route: [{ kind: 'free', positionMm: waypoint, entity: null, fixture: null, tool: null }],
    lengthMm: spread ? 6000 : 1500,
    colour: { base: 'black', stripe: null },
  });
  const nut = (entity: number, t: number) => ({ entity, terminal: 'splice', termination: termination(t, 'twistOn') });
  return World.parse({
    schemaVersion: 3,
    seed: options.seed ?? 5,
    tick: options.tick ?? 0,
    nextEntityId: 6,
    nextConnectionId: 8,
    nextCableId: 1,
    nextTerminationId: 8,
    regionId: 'nec',
    difficulty: 'apprentice',
    assisted: false,
    fixtures: [],
    entities: [
      entity(1, BATTERY),
      entity(2, BREAKER_REF, { on: true }),
      entity(3, NUT_REF),
      entity(4, NUT_REF),
      entity(5, HEATER),
    ],
    connections: [
      lead(1, [1, 'pos'], [2, 'line']),
      conductor(
        2,
        { entity: 2, terminal: 'load', termination: termination(1, 'screw', options.loadTorqueNm) },
        nut(3, 2),
        options.conductor2Sim,
      ),
      conductor(3, nut(3, 3), nut(4, 4)),
      conductor(4, nut(3, 5), nut(4, 6)),
      lead(5, [4, 'splice'], [5, 'a']),
      lead(6, [5, 'b'], [1, 'neg']),
      conductor(7, nut(4, 7), null),
    ],
    cables: [],
    sim: null,
    extensions: {},
  });
}
