import {
  CONNECTION_OUTPUT_SCHEMAS,
  CONNECTION_RECORD_BYTES,
  decodeSnapshot,
  DescriptorIndex,
  NetlistReadout,
  CONNECTION_VALUE_COUNT,
  CONNECTION_VALUE_INDEX,
  snapshotViewFromBytes,
} from '@controls/sim-protocol';
import fc from 'fast-check';
import { engineBus } from '../../testing/engine';
import { SourceHost } from '../../testing/sources';
import { wiredLoopWorld } from '../../testing/wired-loop';
import { AMBIENT_TEMPERATURE_K } from '../constants';
import type { SimConnectionRecord } from './engine';

/*
 * Protocol 7's connection records (F3.6 part 3; ADR 0015 "Protocol 7 connection records", the ADR
 * 0011 amendment): one per connection in the thermal bank, netlisted or not, written from the bank's
 * state and the engine's solution. The wired loop (`testing/wired-loop.ts`): a battery (1) through a
 * 15 A breaker (2) into two wire nuts (3, 4) and the 12 V 50 W heater (5); lead 1 battery + → breaker
 * line; conductor 2 breaker load screw → nut 3; conductors 3 and 4 nut 3 → nut 4 in parallel; leads 5
 * and 6 to and from the heater; conductor 7 landed in nut 4 at one end, free at the other.
 *
 * Hand calculations (everything at the 20 °C ambient at the start solve, tick 0):
 *
 * - **Conductor 3's resistance.** 14 AWG: d = 0.127 mm × 92^((36 − 14)/39) = 1.62814 mm, so
 *   A = π d²/4 = 2.08196 mm² (solid, lay factor 1). Annealed copper at 20 °C: ρ = 1/58 Ω·mm²/m
 *   = 1.724138 × 10⁻⁸ Ω·m (IACS, the materials table's row). 1.5 m: R = ρ L / A = 1.724138e-8 × 1.5 /
 *   2.08196e-6 = 0.0124219 Ω. T_c = T₀, so no temperature correction.
 * - **Lead 1's resistance.** 1 m of 8.2305 × 10⁻⁷ m² copper (the lead's params): ρ L / A = 0.0209481 Ω,
 *   plus two 10 mΩ clips = 0.0409481 Ω. A lead's clips are inside its conductor value; its ends have no
 *   termination node (`none`).
 * - **Series and parallel.** Lead 1 and conductor 2 carry the loop current; conductors 3 and 4 are
 *   equal and in parallel, so each carries half (KCL at the nuts).
 * - **Drops.** The terminal-to-terminal voltage splits in proportion to R_cond, R_a and R_b, so the
 *   three drops add up to it, and at the start (the stamp is the state's) each end's drop is I × R_end.
 */

/** The record's own arithmetic (a split, a subtraction): a few ulps. */
const ROUNDING = 1e-12;
/** Kirchhoff's current law across branches: the solve's residual (numerical, not the record's). */
const KCL = 1e-9;
const relative = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-300);

const host = (options: Parameters<typeof wiredLoopWorld>[0] = {}) =>
  new SourceHost(engineBus(options.seed ?? 5, wiredLoopWorld(options)));

const num = (record: SimConnectionRecord | null, field: string): number => {
  const value = record?.values[field];
  if (typeof value !== 'number') throw new Error(`${field} is not a number: ${String(value)}`);
  return value;
};

/** |V(a) − V(b)| between connection `id`'s two terminals, from an ideal probe. */
function terminalVolts(h: SourceHost, id: number): number {
  const connection = h.bus.state.connections.find((c) => c.id === id);
  if (!connection?.a || !connection.b) throw new Error('a landed connection');
  const reading = h.engine.probe(connection.a, connection.b);
  if (reading.kind !== 'dc') throw new Error(`no DC reading: ${reading.kind}`);
  return Math.abs(reading.volts);
}

describe('connection records (protocol 7)', () => {
  it('golden: resistances, currents and drops at the start solve, by hand', () => {
    const h = host();
    const c2 = h.engine.connectionRecord(2);
    const c3 = h.engine.connectionRecord(3);
    const c4 = h.engine.connectionRecord(4);
    const lead1 = h.engine.connectionRecord(1);
    expect(c3).toMatchObject({ kind: 'conductor', connection: 3, values: { status: 'solved' } });
    expect(relative(num(c3, 'conductorResistanceOhm'), 0.0124219)).toBeLessThan(0.005);
    expect(relative(num(lead1, 'conductorResistanceOhm'), 0.0409481)).toBeLessThan(0.005);
    expect(lead1?.values).toMatchObject({
      endAState: 'none',
      endBState: 'none',
      endATempK: 0,
      endAContactOhm: 0,
      endADropV: 0,
      status: 'solved',
    });
    // Series and parallel (KCL through the loop, to the LU solve's rounding).
    expect(relative(num(lead1, 'currentA'), num(c2, 'currentA'))).toBeLessThan(KCL);
    expect(relative(num(c3, 'currentA'), num(c4, 'currentA'))).toBeLessThan(KCL);
    expect(relative(num(c3, 'currentA') + num(c4, 'currentA'), num(c2, 'currentA'))).toBeLessThan(KCL);
    expect(num(c2, 'currentA')).toBeGreaterThan(3); // about 4 A
    // Temperatures: everything at ambient, both conductor ends landed (`ok`).
    expect(c2?.values).toMatchObject({
      conductorTempK: AMBIENT_TEMPERATURE_K.value,
      endATempK: AMBIENT_TEMPERATURE_K.value,
      endBTempK: AMBIENT_TEMPERATURE_K.value,
      endAState: 'ok',
      endBState: 'ok',
      insulationDamaged: 'no',
    });
    for (const id of [1, 2, 3, 4, 5, 6]) {
      const r = h.engine.connectionRecord(id);
      const volts = terminalVolts(h, id);
      const sum = num(r, 'conductorDropV') + num(r, 'endADropV') + num(r, 'endBDropV');
      expect(relative(sum, volts)).toBeLessThan(ROUNDING);
      const amps = num(r, 'currentA');
      expect(relative(num(r, 'conductorDropV'), amps * num(r, 'conductorResistanceOhm'))).toBeLessThan(1e-9);
      if (r?.kind === 'conductor') {
        expect(relative(num(r, 'endADropV'), amps * num(r, 'endAContactOhm'))).toBeLessThan(1e-9);
        expect(relative(num(r, 'endBDropV'), amps * num(r, 'endBContactOhm'))).toBeLessThan(1e-9);
      }
    }
  });

  it("end voltages are the terminal's less the contact's drop, against the island reference", () => {
    const h = host();
    const c2 = h.engine.connectionRecord(2);
    const breakerLoad = h.engine.probe({ entity: 2, terminal: 'load' }, { entity: 1, terminal: 'neg' });
    const nut3 = h.engine.probe({ entity: 3, terminal: 'splice' }, { entity: 1, terminal: 'neg' });
    if (breakerLoad.kind !== 'dc' || nut3.kind !== 'dc') throw new Error('DC readings');
    // The battery's − is the island reference (its most negative source terminal); the current flows a → b.
    expect(relative(num(c2, 'endAVolts'), breakerLoad.volts - num(c2, 'endADropV'))).toBeLessThan(ROUNDING);
    expect(relative(num(c2, 'endBVolts'), nut3.volts + num(c2, 'endBDropV'))).toBeLessThan(ROUNDING);
  });

  it('a connection that is not netlisted is `open`: zero current and drops, its own state still written', () => {
    const h = host().advanceTo(2000);
    const c7 = h.engine.connectionRecord(7);
    expect(c7).toMatchObject({ kind: 'conductor', connection: 7, branch: -1 });
    expect(c7?.values).toMatchObject({
      status: 'open',
      currentA: 0,
      conductorDropV: 0,
      endADropV: 0,
      endBDropV: 0,
      endAVolts: 0,
      endBVolts: 0,
      endAState: 'ok', // landed in nut 4
      endBState: 'none', // free
      endBTempK: 0,
      endBContactOhm: 0,
    });
    expect(num(c7, 'endAContactOhm')).toBeGreaterThan(0); // the bank's own as-made value
    expect(num(c7, 'conductorTempK')).toBe(AMBIENT_TEMPERATURE_K.value); // no current, no heat
    expect(h.engine.connectionRecord(99)).toBeNull();
  });

  it('bad termination: the end drop is I × R_contact within 0.5 % and more than 10× the good end, under load', () => {
    const good = host().advanceTo(60_000);
    const bad = host({ loadTorqueNm: 0.8 }).advanceTo(60_000);
    const r = bad.engine.connectionRecord(2);
    const amps = num(r, 'currentA');
    expect(relative(num(r, 'endADropV'), amps * num(r, 'endAContactOhm'))).toBeLessThan(0.005);
    expect(num(r, 'endADropV')).toBeGreaterThan(10 * num(good.engine.connectionRecord(2), 'endADropV'));
    // The hot spot is above its conductor.
    expect(num(r, 'endATempK')).toBeGreaterThan(num(r, 'conductorTempK'));
  });

  it('the snapshot holds every record in connection order, as connectionRecord decodes it', () => {
    const h = host().advanceTo(1234);
    const snapshot = decodeSnapshot(h.engine.snapshot());
    const descriptor = h.engine.topologyDescriptor();
    expect(snapshot.connectionCount).toBe(7);
    expect(snapshot.connections.byteLength).toBe(7 * CONNECTION_RECORD_BYTES);
    expect(descriptor.connections.map((c) => [c.connection, c.kind, c.recordOffset])).toStrictEqual(
      [1, 2, 3, 4, 5, 6, 7].map((id, i) => [id, [1, 5, 6].includes(id) ? 'lead' : 'conductor', i * 104]),
    );
    expect(descriptor.connections[6].branch).toBe(-1);
    expect(descriptor.connectionSchemas).toStrictEqual(CONNECTION_OUTPUT_SCHEMAS);
    const view = snapshotViewFromBytes(h.engine.snapshot(), descriptor);
    const index = DescriptorIndex.of(descriptor);
    const readout = NetlistReadout.of(descriptor);
    const reading = readout.createReading();
    readout.read(view, reading);
    for (const entry of descriptor.connections) {
      const record = h.engine.connectionRecord(entry.connection);
      const branch = readout.branchOfConnection(entry.connection);
      expect(entry.branch).toBe(branch);
      for (const field of CONNECTION_OUTPUT_SCHEMAS[entry.kind].fields) {
        const ref = index.connectionField(entry.connection, field.name, entry.kind);
        if (ref === null) throw new Error(field.name);
        const value = view.readConnection(ref);
        const decoded = record?.values[field.name];
        expect(field.values === null ? value : field.values[value]).toBe(decoded);
        const c = readout.recordOfConnection(entry.connection);
        expect(reading.connectionValues[c * CONNECTION_VALUE_COUNT + CONNECTION_VALUE_INDEX[field.name]]).toBe(value);
      }
      // The record's current is the branch's: the overlays and the inspector agree.
      if (branch >= 0) expect(num(record, 'currentA')).toBe(reading.branchAmps[branch]);
    }
  });

  it('the descriptor generation follows the bank membership: deleting an un-netlisted conductor, and its undo', () => {
    const h = host();
    const generation = h.engine.topologyGeneration;
    const topology = h.engine.netlist.topologyHash;
    const before = h.engine.topologyDescriptor();
    h.exec('wire.delete', { id: 7 });
    expect(h.engine.netlist.topologyHash).toBe(topology); // not a topology change
    expect(h.engine.topologyGeneration).toBe(generation + 1);
    const after = h.engine.topologyDescriptor();
    expect(after).not.toBe(before);
    expect(after.connections.map((c) => c.connection)).toStrictEqual([1, 2, 3, 4, 5, 6]);
    expect(decodeSnapshot(h.engine.snapshot()).connectionCount).toBe(6);
    h.exec('edit.undo');
    expect(h.engine.topologyGeneration).toBe(generation + 2);
    expect(h.engine.topologyDescriptor().connections.map((c) => c.connection)).toStrictEqual([1, 2, 3, 4, 5, 6, 7]);
    // A connection change that moves neither the membership nor the topology keeps the generation:
    // unlanding conductor 7's landed end (it is not netlisted either way), its end now `none`.
    h.exec('wire.unland', { id: 7, end: 'a' });
    expect(h.engine.topologyGeneration).toBe(generation + 2);
    expect(h.engine.connectionRecord(7)?.values).toMatchObject({ status: 'open', endAState: 'none', endATempK: 0 });
  });

  it('a records-only engine state round-trips a save and load: the same snapshot bytes (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }).map((n) => n * 997),
        fc.constantFrom(1, 600, 3000, 30_000),
        (ticks, degradation) => {
          const live = host({
            loadTorqueNm: 0.8,
            conductor2Sim: { endADegradation: degradation, endATerminationId: 1 },
          });
          live.advanceTo(ticks);
          const loaded = live.reload();
          expect(loaded.engine.snapshot()).toStrictEqual(live.engine.snapshot());
          expect(loaded.engine.connectionRecord(2)).toStrictEqual(live.engine.connectionRecord(2));
        },
      ),
      { numRuns: 12 },
    );
  });
});

describe('connection events (protocol 7)', () => {
  it('a bad termination raises terminationOverheat once, as a sim event with its connection and end', () => {
    // 20 % torque at the loop's ~4 A stays well below the threshold; 3000× the as-made contact
    // (degradation, not the oxidation-driven growth) heats the screw past ambient + 100 K.
    const h = host({ conductor2Sim: { endADegradation: 400, endATerminationId: 1 } });
    h.advanceTo(120_000);
    const overheats = h.events.filter((e) => e.kind === 'terminationOverheat');
    expect(overheats.length).toBeGreaterThanOrEqual(1);
    expect(overheats[0]).toMatchObject({ entity: null, entities: [], connection: 2, end: 'a' });
    expect(overheats[0].detail['temperatureK'] as number).toBeGreaterThanOrEqual(AMBIENT_TEMPERATURE_K.value + 100);
    expect(overheats[0].tick % 10).toBe(1); // the state after a cadence step (step tick + 1)
  });
});
