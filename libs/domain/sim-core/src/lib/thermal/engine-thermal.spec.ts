import { LEAD_SIM_BAG_V3, World } from '@controls/save-format';
import { worldHash } from '@controls/world-model';
import fc from 'fast-check';
import { BATTERY, LAMP } from '../../testing/bench';
import { engineBus, RESISTOR_2_4 } from '../../testing/engine';
import { HEATER } from '../../testing/loads';

const LEAD_REF = { id: 'lead.quillfern-test-1m', version: 1 };
const BREAKER = { id: 'breaker.saltmere-1p-15a', version: 1 };
const NUT = { id: 'splice.corvelle-tw-l', version: 1 };
import { SourceHost } from '../../testing/sources';
import { AMBIENT_TEMPERATURE_K } from '../constants';

/*
 * The connection thermal bank inside the engine (F3.6 part 1, ADR 0018 §3.4, ADR 0015): the fixed
 * absolute schedule, materialisation of every connection's bag, and save/load parity mid-heating.
 */

const TA = AMBIENT_TEMPERATURE_K.value;

/** A battery (1) shorted through a 2.4 Ω resistor (2) by two leads (1, 2): about 5 A, so the leads warm. */
function heatingLoop(host = new SourceHost()): SourceHost {
  host.place(BATTERY);
  host.place(RESISTOR_2_4);
  host.lead(1, 'pos', 2, 'a');
  host.lead(2, 'b', 1, 'neg');
  return host;
}

const leadTemp = (host: SourceHost, id: number) =>
  host.engine.exportState().connections.find((c) => c.id === id)?.state['conductorTempK'] as number;

describe('the connection thermal bank in the engine', () => {
  it('integrates only at cadence ticks (t % 10 = 0), never in between', () => {
    // Step 20 integrates over [20, 30): the state at 21 holds it, and nothing moves until step 30.
    const host = heatingLoop().advanceTo(21);
    const after20 = leadTemp(host, 1);
    expect(after20).toBeGreaterThan(TA);
    for (let t = 22; t <= 30; t++) {
      host.advanceTo(t);
      expect(leadTemp(host, 1)).toBe(after20);
    }
    host.advanceTo(31);
    expect(leadTemp(host, 1)).toBeGreaterThan(after20);
  });

  it('materialises every connection of a known kind, with the ten keys; a lead keeps its end keys initial', () => {
    const host = heatingLoop().advance(5000);
    const world = host.materialised();
    expect(world.connections.map((c) => c.id)).toStrictEqual([1, 2]);
    for (const connection of world.connections) {
      expect(Object.keys(connection.sim).sort()).toStrictEqual(Object.keys(LEAD_SIM_BAG_V3).sort());
      expect(connection.sim['conductorTempK'] as number).toBeGreaterThan(TA);
      const { conductorTempK: _, ...ends } = connection.sim;
      const { conductorTempK: __, ...initial } = LEAD_SIM_BAG_V3;
      expect(ends).toStrictEqual(initial);
    }
  });

  it('a heating lead raises the loop resistance: the current falls as it warms', () => {
    const host = heatingLoop().advanceTo(1);
    const cold = host.engine.branchAmps({ kind: 'connection', connection: 1 });
    host.advance(30_000);
    const warm = host.engine.branchAmps({ kind: 'connection', connection: 1 });
    expect(warm).toBeLessThan(cold);
    expect(warm / cold).toBeGreaterThan(0.99); // a few kelvin on a 2.4 Ω load: a tiny effect
  });

  it('save and load mid-heating equals the uninterrupted run (property: any cut, any continuation)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3000 }), fc.integer({ min: 1, max: 3000 }), (cut, more) => {
        const straight = heatingLoop().advanceTo(cut);
        const loaded = straight.reload();
        straight.advance(more);
        loaded.advance(more);
        expect(loaded.engine.snapshotHash()).toBe(straight.engine.snapshotHash());
        expect(loaded.engine.exportState()).toStrictEqual(straight.engine.exportState());
        expect(worldHash(loaded.materialised())).toBe(worldHash(straight.materialised()));
      }),
      { numRuns: 12 },
    );
  });

  it('every materialised connection bag is finite, at or above ambient, with D ≥ 1, after a session', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(fc.constant('lamp' as const), fc.constant('short' as const), fc.integer({ min: 1, max: 4000 })),
          {
            minLength: 1,
            maxLength: 6,
          },
        ),
        (ops) => {
          const host = new SourceHost();
          for (const op of ops) {
            if (op === 'lamp' || op === 'short') {
              const battery = host.place(BATTERY);
              if (op === 'lamp') {
                const lamp = host.place(LAMP);
                host.lead(battery, 'pos', lamp, 'a').lead(lamp, 'b', battery, 'neg');
              } else {
                host.lead(battery, 'pos', battery, 'neg');
              }
            } else host.advance(op);
          }
          for (const connection of host.materialised().connections) {
            const sim = connection.sim;
            expect(Number.isFinite(sim['conductorTempK'])).toBe(true);
            expect(sim['conductorTempK'] as number).toBeGreaterThanOrEqual(TA);
            expect(sim['endADegradation'] as number).toBeGreaterThanOrEqual(1);
            expect(sim['endBDegradation'] as number).toBeGreaterThanOrEqual(1);
            expect(sim['insulationDamaged']).toBe(false);
            expect([
              sim['endATempK'],
              sim['endBTempK'],
              sim['endATerminationId'],
              sim['endBTerminationId'],
            ]).toStrictEqual([null, null, null, null]);
          }
        },
      ),
      { numRuns: 15 },
    );
  });

  it('a deleted and undone lead keeps its temperature (a tombstone), a disconnected one is dropped from the export', () => {
    const host = heatingLoop().advance(3000);
    const warm = leadTemp(host, 2);
    host.exec('lead.disconnect', { id: 2 });
    expect(host.engine.exportState().connections.map((c) => c.id)).toStrictEqual([1]);
    host.exec('edit.undo');
    expect(leadTemp(host, 2)).toBe(warm);
  });

  it('save and load mid-heating with landed conductors equals the uninterrupted run (end keys through materialise → JSON → migrate)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4000 }), fc.integer({ min: 1, max: 4000 }), (cut, more) => {
        const straight = new SourceHost(engineBus(5, wiredLoopWorld())).advanceTo(cut);
        const loaded = straight.reload();
        // The end keys reached the save: landed ends hot, their termination ids, an unlanded end null.
        const saved = straight.materialised().connections.find((c) => c.id === 2)?.sim ?? {};
        expect(saved['endATerminationId']).toBe(1);
        expect(saved['endATempK'] as number).toBeGreaterThan(TA);
        const free = straight.materialised().connections.find((c) => c.id === 7)?.sim ?? {};
        expect([free['endATerminationId'], free['endBTempK']]).toStrictEqual([7, null]);
        straight.advance(more);
        loaded.advance(more);
        expect(loaded.engine.snapshotHash()).toBe(straight.engine.snapshotHash());
        expect(loaded.engine.exportState()).toStrictEqual(straight.engine.exportState());
        expect(worldHash(loaded.materialised())).toBe(worldHash(straight.materialised()));
      }),
      { numRuns: 10 },
    );
  });
});

const THHN_14 = { id: 'conductor.tallowmere-thhn-14-solid', version: 1 };

/**
 * A battery (1) through a 15 A breaker (2, handle on) into two wire nuts (3, 4) and the 12 V 50 W
 * heater (5): lead 1 battery + → breaker line; conductor 2 breaker load (screw) → nut 3; conductors 3
 * and 4 nut 3 → nut 4 in parallel; lead 5 nut 4 → heater a; lead 6 heater b → battery −; conductor 7
 * landed in nut 4 at one end, free at the other. About 4 A, so the conductors and their ends warm.
 * Built directly (as the bench plants are), every termination its own id.
 */
function wiredLoopWorld(): World {
  const transform = { positionMm: { x: 0, y: 0, z: 0 }, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } };
  const entity = (id: number, ref: { id: string; version: number }, state: Record<string, boolean> = {}) => ({
    id,
    ref,
    transform,
    state,
    sim: {},
    mountedOn: null,
    label: null,
    extensions: {},
  });
  const termination = (id: number, method: 'screw' | 'twistOn') => ({
    id,
    method,
    auto: false,
    stripLengthMm: 13,
    nickedStrandFraction: 0,
    torqueNm: method === 'screw' ? 4 : null,
    accessory: null,
  });
  const base = { cable: null, label: null, state: {}, sim: { ...LEAD_SIM_BAG_V3 }, extensions: {} };
  const lead = (id: number, a: [number, string], b: [number, string]) => ({
    ...base,
    id,
    ref: LEAD_REF,
    a: { entity: a[0], terminal: a[1], termination: null },
    b: { entity: b[0], terminal: b[1], termination: null },
    route: null,
    lengthMm: null,
    colour: null,
  });
  const conductor = (id: number, a: object | null, b: object | null) => ({
    ...base,
    id,
    ref: THHN_14,
    a,
    b,
    route: [{ kind: 'free', positionMm: { x: 0, y: 300, z: 0 }, entity: null, fixture: null, tool: null }],
    lengthMm: 1500,
    colour: { base: 'black', stripe: null },
  });
  const nut = (entity: number, t: number) => ({ entity, terminal: 'splice', termination: termination(t, 'twistOn') });
  return World.parse({
    schemaVersion: 3,
    seed: 5,
    tick: 0,
    nextEntityId: 6,
    nextConnectionId: 8,
    nextCableId: 1,
    nextTerminationId: 8,
    regionId: 'nec',
    difficulty: 'apprentice',
    assisted: false,
    fixtures: [],
    entities: [entity(1, BATTERY), entity(2, BREAKER, { on: true }), entity(3, NUT), entity(4, NUT), entity(5, HEATER)],
    connections: [
      lead(1, [1, 'pos'], [2, 'line']),
      conductor(2, { entity: 2, terminal: 'load', termination: termination(1, 'screw') }, nut(3, 2)),
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
