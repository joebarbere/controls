import type { PlugOnBreakerParams } from '@controls/catalog';
import { DEVICE_OUTPUT_SCHEMAS, deviceOutputSchemaProblems } from '@controls/sim-protocol';
import { deriveStream, entityPurposeStreamKey, entityStreamKey } from '@controls/world-model';
import { bankRig } from '../../../testing/breakers';
import { BUSBAR, engineBus, RHEOSTAT } from '../../../testing/engine';
import { GFCI_20, GFCI_SENSE_PARAMS, PLUG_ON_20, PLUG_ON_2P_20, plugOnParams } from '../../../testing/plug-on';
import { SourceHost, UTILITY_SPLIT } from '../../../testing/sources';
import {
  AFCI_BREAKER_MODEL,
  GFCI_BREAKER_MODEL,
  PLUG_ON_1P_MODEL,
  PLUG_ON_2P_MODEL,
  PLUG_ON_READING_CURRENT,
  PLUG_ON_READING_LINE_VOLTAGE,
  PLUG_ON_READING_LOAD_VOLTAGE,
  PLUG_ON_READING_NEUTRAL_CURRENT,
  PLUG_ON_READING_RESIDUAL,
} from './plug-on';

/*
 * Breakers v2's protocol 8 records (P4 PR 11, ADR 0011's protocol 8 amendment), through the engine and
 * the snapshot encoder (`SourceHost.record` decodes the snapshot's bytes). Hand calculations:
 *
 * - the utility stand-in (25 kVA, 2 %, X/R 2; Z_LN 7.728 + j12.365 mΩ, ADR 0021 §1) feeding a 12 Ω load
 *   through a 20 A breaker (a 5 mΩ pole) and busbar links (17 nΩ each): I = 120 / |12.0127 + j0.0124| Ω
 *   = 9.98942 A, so `currentA` is 10 A within 0.2 % (and the solved branch's |I| exactly);
 * - the two-pole breaker on 12 Ω (L1) and 24 Ω (L2): 9.99 A and 5.00 A within 0.2 %;
 * - the GFCI breaker's load 12 Ω (load → load neutral) and a 12 kΩ leak from its load to the service
 *   neutral (around the sensor): the residual is the leak's current, 120 / 12 000 = 10.0 mA within 0.2 %;
 *   the line-side voltage (line to pigtail) is the service's 120 V less the drops, within 0.5 %, and so is
 *   the load side's. After its trip (cause `groundFault`, 2695 ticks at 10 mA, ADR 0021 §12) the pole
 *   carries exactly 0 A (a reading), the line side still reads about 120 V, and the load side 0 V: the
 *   load and its neutral both sit on the service neutral through the leak and the neutral pole;
 * - pickups and opening times are each stream's first output over its band (ADR 0021 §11, §12), so the
 *   records' `magneticPickupA`, `openingMs` and `pickupMa` equal the specs' own draws exactly;
 * - `thermalFraction` is the bag's θ over k_u² (1.5625): 1 trips.
 */

const P20 = plugOnParams(20);
const near = (got: number, want: number, rel: number) => expect(Math.abs(got / want - 1)).toBeLessThan(rel);
const pickupOf = (seed: number, id: number, purpose: 'pickupL2' | null = null) =>
  P20.magneticPickupMinA +
  (P20.magneticPickupMaxA - P20.magneticPickupMinA) *
    (purpose === null
      ? deriveStream(seed, entityStreamKey(id))
      : deriveStream(seed, entityPurposeStreamKey(id, purpose))
    ).nextFloat();
const openingOf = (seed: number, id: number) =>
  Math.ceil(
    P20.openingTimeMinMs +
      (P20.openingTimeMaxMs - P20.openingTimeMinMs) *
        deriveStream(seed, entityPurposeStreamKey(id, 'opening')).nextFloat(),
  );

const link = (host: SourceHost, a: number, ta: string, b: number, tb: string) =>
  host.exec('lead.connect', { ref: BUSBAR, a: { entity: a, terminal: ta }, b: { entity: b, terminal: tb } });

/** |I| of entity `id`'s part `part` in the held solution (0 when the part isn't netlisted). */
function partAmps(host: SourceHost, id: number, part: string): number {
  const branch = host.engine.netlist.branches.find(
    (b) => b.element.kind === 'entity' && b.element.entity === id && b.element.part === part,
  );
  if (branch === undefined) return 0;
  const s = host.engine.exportState().solution?.branches as number[];
  return Math.sqrt(s[2 * branch.index] * s[2 * branch.index] + s[2 * branch.index + 1] * s[2 * branch.index + 1]);
}

describe('the plug-on breakers’ records (protocol 8)', () => {
  /** The stand-in (1), L1 through the 20 A breaker (2) into a rheostat (3) at `ohms`, back to N. */
  function feed(ohms: number, seed = 11): SourceHost {
    const host = new SourceHost(engineBus(seed));
    host.place(UTILITY_SPLIT);
    host.place(PLUG_ON_20);
    host.place(RHEOSTAT);
    link(host, 1, 'l1', 2, 'line');
    link(host, 2, 'load', 3, 'a');
    link(host, 3, 'b', 1, 'n');
    return host.operate(3, 'ohms', ohms).operate(2, 'on', true);
  }

  it('a closed 1-pole breaker reads its solved current, thermal fraction, draws, state and no cause', () => {
    const host = feed(12).advance(500);
    const r = host.record(2);
    near(r['currentA'] as number, 120 / 12.0127, 0.002);
    near(r['currentA'] as number, partAmps(host, 2, 'pole'), 1e-12);
    expect(r['thermalFraction']).toBe((host.sim(2)['thermal'] as number) / 1.5625);
    expect(r['magneticPickupA']).toBe(pickupOf(11, 2));
    expect(r['openingMs']).toBe(openingOf(11, 2));
    expect(r).toMatchObject({ state: 'on', tripCause: 'none', status: 'solved' });
  });

  it('a trip reads `tripped` with its cause (handle still on) and exactly 0 A; off reads `off`, its cause cleared', () => {
    const host = feed(12).advance(10);
    host.operate(3, 'ohms', 0.1).advance(40);
    expect(host.record(2)).toMatchObject({ currentA: 0, state: 'tripped', tripCause: 'magnetic', status: 'solved' });
    expect(host.bus.state.entities.find((e) => e.id === 2)?.state['on']).toBe(true); // the sim never writes `on`
    host.operate(2, 'on', false);
    expect(host.record(2)).toMatchObject({ currentA: 0, state: 'off', tripCause: 'none', status: 'solved' });
  });

  it('the 2-pole breaker reads each pole’s current, fraction and pickup, and one state and cause', () => {
    const host = new SourceHost(engineBus(11));
    host.place(UTILITY_SPLIT);
    host.place(PLUG_ON_2P_20);
    host.place(RHEOSTAT);
    host.place(RHEOSTAT);
    link(host, 1, 'l1', 2, 'line1');
    link(host, 1, 'l2', 2, 'line2');
    link(host, 2, 'load1', 3, 'a');
    link(host, 2, 'load2', 4, 'a');
    link(host, 3, 'b', 1, 'n');
    link(host, 4, 'b', 1, 'n');
    host.operate(3, 'ohms', 12).operate(4, 'ohms', 24).operate(2, 'on', true).advance(200);
    const r = host.record(2);
    near(r['pole1CurrentA'] as number, 10, 0.002);
    near(r['pole2CurrentA'] as number, 5, 0.002);
    near(r['pole2CurrentA'] as number, partAmps(host, 2, 'pole2'), 1e-12);
    const bag = host.sim(2);
    expect(r['pole1ThermalFraction']).toBe((bag['thermalL1'] as number) / 1.5625);
    expect(r['pole2ThermalFraction']).toBe((bag['thermalL2'] as number) / 1.5625);
    expect(r['pole1MagneticPickupA']).toBe(pickupOf(11, 2));
    expect(r['pole2MagneticPickupA']).toBe(pickupOf(11, 2, 'pickupL2'));
    expect(r).toMatchObject({ state: 'on', tripCause: 'none', status: 'solved' });
  });
});

describe('the GFCI breaker’s record (protocol 8)', () => {
  /** The stand-in (1), the GFCI (2), its 12 Ω load (3, load → load neutral) and a leak (4, load → N) at `leak` Ω. */
  function gfci(leak: number): SourceHost {
    const host = new SourceHost(engineBus(11));
    host.place(UTILITY_SPLIT);
    host.place(GFCI_20);
    host.place(RHEOSTAT);
    host.place(RHEOSTAT);
    link(host, 1, 'l1', 2, 'line');
    link(host, 2, 'pigtail', 1, 'n');
    link(host, 2, 'load', 3, 'a');
    link(host, 3, 'b', 2, 'loadNeutral');
    link(host, 2, 'load', 4, 'a');
    link(host, 4, 'b', 1, 'n');
    return host.operate(3, 'ohms', 12).operate(4, 'ohms', leak).operate(2, 'on', true);
  }
  const ALL = 31;
  const pickupMa = 1000 * (0.004 + 0.002 * deriveStream(11, entityPurposeStreamKey(2, 'gfciPickup')).nextFloat());

  it('reads the residual it senses (10.0 mA through a 12 kΩ leak), both sides’ voltages and its own state', () => {
    const host = gfci(12_000).advance(100);
    const r = host.record(2);
    near(r['residualMa'] as number, 10, 0.002);
    // The leak's current against the sensed residual: equal to KCL's floor at the load node, which the
    // 17 nΩ busbar links set at about ε · V / R ≈ 1.6 µA (the floor policy, simulation caveats).
    expect(Math.abs((r['residualMa'] as number) - 1000 * partAmps(host, 4, 'element'))).toBeLessThan(1000 * 2e-6);
    near(r['currentA'] as number, partAmps(host, 2, 'pole'), 1e-12);
    near(r['neutralCurrentA'] as number, partAmps(host, 2, 'neutral'), 1e-12);
    near(r['lineVoltageV'] as number, 120, 0.005);
    near(r['loadVoltageV'] as number, 120, 0.005);
    expect(r['pickupMa']).toBe(pickupMa);
    expect(r['residualIntegral']).toBe(host.sim(2)['residualIntegral']);
    expect(r['residualIntegral'] as number).toBeGreaterThan(0);
    expect(r).toMatchObject({ state: 'on', tripCause: 'none', testHeld: 'no', readings: ALL, status: 'solved' });
  });

  it('tripped: 0 A on the pole, the line side still live, the load side dead (0 V), cause groundFault', () => {
    const host = gfci(12_000);
    const start = host.engine.tick;
    host.advance(3000);
    const trip = host.events.find((e) => e.kind === 'tripped');
    expect(trip?.detail).toStrictEqual({ cause: 'groundFault' });
    // At 10 mA the limit is 2.695 s; the leak draws a little less through the source's drop.
    expect((trip?.tick as number) - start).toBeGreaterThan(2600);
    expect((trip?.tick as number) - start).toBeLessThan(3000);
    const r = host.record(2);
    expect(r).toMatchObject({
      currentA: 0,
      residualMa: 0,
      loadVoltageV: 0,
      state: 'tripped',
      tripCause: 'groundFault',
    });
    near(r['lineVoltageV'] as number, 120, 0.005);
    expect(r['readings']).toBe(ALL);
    expect(r['status']).toBe('solved');
  });

  it('a press reads testHeld yes until the trip', () => {
    const host = gfci(1e7).advance(10);
    host.exec('device.press', { id: 2, control: 'test' });
    expect(host.record(2)['testHeld']).toBe('yes');
    near(host.record(2)['residualMa'] as number, 8, 0.01); // 120 V across the 15 kΩ test resistor
    host.advance(4000);
    expect(host.record(2)).toMatchObject({ testHeld: 'no', state: 'tripped', tripCause: 'test' });
  });

  it('a voltage across two islands, or an unsolved pole, is no reading: its bit is clear and the field 0', () => {
    // An unlanded pigtail: the line terminal is on the service's island, the pigtail on its own.
    const host = new SourceHost(engineBus(11));
    host.place(UTILITY_SPLIT);
    host.place(GFCI_20);
    host.place(RHEOSTAT);
    link(host, 1, 'l1', 2, 'line');
    link(host, 2, 'load', 3, 'a');
    link(host, 3, 'b', 1, 'n');
    host.operate(3, 'ohms', 12).operate(2, 'on', true).advance(10);
    const r = host.record(2);
    expect((r['readings'] as number) & PLUG_ON_READING_LINE_VOLTAGE).toBe(0);
    expect(r['lineVoltageV']).toBe(0);
    expect((r['readings'] as number) & PLUG_ON_READING_CURRENT).toBe(PLUG_ON_READING_CURRENT);
  });
});

describe('the record writers on a bank (exact inputs)', () => {
  const GFCI_PARAMS = { ...P20, ...GFCI_SENSE_PARAMS };
  const nodes = { line: 0, load: 1, pigtail: 2, loadNeutral: 3 };

  it('the GFCI record: |I_pole + I_neutral| in mA, |V(line) − V(pigtail)|, |V(load) − V(loadNeutral)|', () => {
    // Parts in branch order: neutral (nodes 0, 1), pole (nodes 2, 3); the record reads the terminal map.
    const rig = bankRig(GFCI_BREAKER_MODEL, GFCI_PARAMS, ['neutral', 'pole'], {
      state: { on: true, test: 0 },
      nodes,
    })
      .amps('pole', 10, 1)
      .amps('neutral', -9.996, -1)
      .volts(0, 120)
      .volts(1, 118, 2)
      .volts(2, 0.5)
      .volts(3, 0.25, -0.25);
    const view = rig.record();
    const schema = GFCI_BREAKER_MODEL.output;
    const at = (name: string) => schema?.fields.find((f) => f.name === name)?.offset as number;
    expect(view.getFloat64(at('currentA'), true)).toBe(Math.sqrt(101));
    expect(view.getFloat64(at('residualMa'), true)).toBeCloseTo(4, 9);
    expect(view.getFloat64(at('lineVoltageV'), true)).toBe(119.5);
    expect(view.getFloat64(at('loadVoltageV'), true)).toBe(Math.sqrt(117.75 * 117.75 + 2.25 * 2.25));
    expect(view.getUint8(at('readings'))).toBe(
      PLUG_ON_READING_CURRENT |
        PLUG_ON_READING_NEUTRAL_CURRENT |
        PLUG_ON_READING_RESIDUAL |
        PLUG_ON_READING_LINE_VOLTAGE |
        PLUG_ON_READING_LOAD_VOLTAGE,
    );
    expect(view.getUint8(at('status'))).toBe(1);
  });

  it('on an unsolved island nothing electrical is a reading; own state is still written', () => {
    const rig = bankRig(AFCI_BREAKER_MODEL, P20, ['neutral', 'pole'], { state: { on: true, test: 0 }, nodes }).amps(
      'pole',
      10,
    );
    (rig.ctx as unknown as { islandStatus: () => string }).islandStatus = () => 'nonConverged';
    const view = rig.record();
    const schema = AFCI_BREAKER_MODEL.output;
    const at = (name: string) => schema?.fields.find((f) => f.name === name)?.offset as number;
    expect(view.getFloat64(at('currentA'), true)).toBe(0);
    expect(view.getUint8(at('readings'))).toBe(0);
    expect(view.getUint8(at('status'))).toBe(2); // unsettled
    expect(view.getUint8(at('state'))).toBe(1); // on
    expect(view.getFloat64(at('magneticPickupA'), true)).toBe(pickupOf(11, 2));
  });

  it('every breakers-v2 schema is the protocol’s, well formed, and ends with its status', () => {
    for (const model of [PLUG_ON_1P_MODEL, PLUG_ON_2P_MODEL, GFCI_BREAKER_MODEL, AFCI_BREAKER_MODEL]) {
      const schema = model.output;
      expect(schema, model.kind).not.toBeNull();
      expect(deviceOutputSchemaProblems(schema as NonNullable<typeof schema>)).toStrictEqual([]);
      expect(JSON.parse(JSON.stringify(schema))).toStrictEqual(
        JSON.parse(JSON.stringify(DEVICE_OUTPUT_SCHEMAS[model.kind])),
      );
      expect(schema?.fields.at(-1)?.name).toBe('status');
    }
  });

  it('the AFCI reads its exposure from its bag, and no downstream arcing with nothing arcing', () => {
    const rig = bankRig(AFCI_BREAKER_MODEL, P20, ['neutral', 'pole'], {
      state: { on: true, test: 0 },
      bag: { arcExposure: 0.25, arcLastSeenTick: 5 },
      nodes,
    });
    const view = rig.record();
    const at = (name: string) => AFCI_BREAKER_MODEL.output?.fields.find((f) => f.name === name)?.offset as number;
    expect(view.getFloat64(at('arcExposure'), true)).toBe(0.25);
    expect(view.getUint8(at('arcingDownstream'))).toBe(0);
  });

  it('documents its own figures: the hand current through 12 Ω on the stand-in, and k_u²', () => {
    // |Z| of 12 Ω + Z_LN (7.728 + j12.365 mΩ) + the 5 mΩ pole (the 17 nΩ links are negligible).
    const z = Math.hypot(12 + 0.007728 + 0.005, 0.012365);
    near(120 / z, 9.98942, 1e-5);
    const p: PlugOnBreakerParams = P20;
    expect(p.ultimateTripRatio * p.ultimateTripRatio).toBe(1.5625);
  });
});
