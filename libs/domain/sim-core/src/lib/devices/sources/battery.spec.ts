import { BUILTIN_CATALOG, type BatteryParams } from '@controls/catalog';
import { deviceOutputSchemaProblems } from '@controls/sim-protocol';
import { AC_SOURCE, BATTERY, LAMP } from '../../../testing/bench';
import { engineTestOptions, FLIP, RESISTOR_2_4, THERMAL_LOAD } from '../../../testing/engine';
import { SimEngine } from '../../engine/engine';
import { BENCH_SUPPLY, SourceHost } from '../../../testing/sources';
import { World } from '@controls/save-format';
import { BATTERY_COLLAPSE_SOC, BATTERY_OUTPUT, batteryChargeEmfV, batteryEmfV, batteryGassingV } from './battery';

/*
 * The battery (plan F2.4): EMF against state of charge, internal resistance, coulomb counting.
 *
 * The catalogue battery (battery.ferrovane-12v-7ah): E(s) = 11.8 + 1.1 s V above 2 % (collapsing to 0 V
 * below), r = 0.023 Ω, Q = 7 A·h, and a charge EMF rising to 14.4 V above 80 %.
 * Every circuit here is the battery into a load through two 1 m test leads, each
 * R_L = ρL/A + 2 × 0.01 Ω = 0.040948155 Ω (F2.1's hand calculation, `compile.spec.ts`).
 */

const params = BUILTIN_CATALOG.device(BATTERY)?.model.params as BatteryParams;
const R_LEAD = 0.040948155;

/** The battery (1) into a load (2) through two leads. */
function loop(load: { id: string; version: number }): SourceHost {
  const host = new SourceHost();
  const battery = host.place(BATTERY);
  const device = host.place(load);
  return host.lead(battery, 'pos', device, 'a').lead(device, 'b', battery, 'neg');
}

describe('batteryEmfV and batteryChargeEmfV: the EMF against state of charge', () => {
  it('is linear between the empty and full open-circuit voltages above 2 %, and clamps outside [0, 1]', () => {
    expect(params).toMatchObject({ openCircuitVoltageFullV: 12.9, openCircuitVoltageEmptyV: 11.8 });
    expect(batteryEmfV(params, 1)).toBe(12.9);
    expect(batteryEmfV(params, 0.5)).toBeCloseTo(12.35, 12);
    expect(batteryEmfV(params, 0.02)).toBeCloseTo(11.822, 12);
    expect(batteryEmfV(params, 2)).toBe(12.9);
    // Resting at its nominal 12.0 V, the battery is only about 18 % charged on this line.
    expect((12 - 11.8) / 1.1).toBeCloseTo(0.1818, 4);
  });

  it('collapses to 0 V over the last 2 % (a flat battery delivers nothing more)', () => {
    expect(BATTERY_COLLAPSE_SOC.value).toBe(0.02);
    expect(batteryEmfV(params, 0)).toBe(0);
    expect(batteryEmfV(params, -1)).toBe(0);
    expect(batteryEmfV(params, 0.01)).toBeCloseTo(11.822 / 2, 12);
  });

  it('charging, rises from E(s) above 80 % to the 14.4 V gassing voltage at full', () => {
    expect(batteryGassingV(params)).toBeCloseTo(14.4, 12);
    expect(batteryChargeEmfV(params, 0.5)).toBe(batteryEmfV(params, 0.5));
    expect(batteryChargeEmfV(params, 0.8)).toBe(batteryEmfV(params, 0.8));
    // At 90 %: E = 12.79 V, plus (14.4 − 12.9) · (0.1 / 0.2) = 0.75 V: 13.54 V.
    expect(batteryChargeEmfV(params, 0.9)).toBeCloseTo(13.54, 12);
    expect(batteryChargeEmfV(params, 1)).toBeCloseTo(14.4, 12);
    expect(batteryChargeEmfV(params, 3)).toBeCloseTo(14.4, 12);
  });
});

describe('the battery model (golden)', () => {
  it('terminal voltage = EMF − I·r within 0.5 % (here 1e-9), into 2.4 Ω through two leads', () => {
    // Hand calculation, a new battery (s = 1, E = 12.9 V):
    //   I = E / (r + R + 2 R_L) = 12.9 / (0.023 + 2.4 + 0.08189631) = 12.9 / 2.50489631 = 5.149914 A
    //   V = E − r I = 12.9 − 0.023 × 5.149914 = 12.781552 V
    const host = loop(RESISTOR_2_4);
    const I = 12.9 / (0.023 + 2.4 + 2 * R_LEAD);
    expect(I).toBeCloseTo(5.149914, 6);
    expect(host.amps(1)).toBeCloseTo(I, 6);
    const V = host.volts(1, 'pos', 1, 'neg');
    expect(Math.abs(V - (12.9 - 0.023 * host.amps(1)))).toBeLessThan(1e-9 * 12.9);
    expect(V).toBeCloseTo(12.781552, 6);
    expect(host.record(1)).toStrictEqual({
      emfV: 12.9,
      terminalV: V,
      currentA: host.amps(1),
      stateOfCharge: 1,
      status: 'solved',
    });
  });

  it('over a minute, the state of charge falls by ∫I dt ÷ capacity within 0.5 % (the hour: sim-cli)', () => {
    // The one-hour golden, with its closed form, is `apps/sim-cli/src/battery-hour.spec.ts` (outside
    // coverage instrumentation, which makes an hour of sim time six times slower). Here a minute:
    // ∫I dt from the current each cadence solve holds for its 10 ticks.
    const host = loop(RESISTOR_2_4);
    const Q = params.capacityAh * 3600;
    let charge = 0;
    for (let t = 0; t < 60_000; t += 10) {
      host.engine.advanceTo(t + 1); // step t solved first (the cadence), then integrated
      charge += (host.volts(2, 'a', 2, 'b') / 2.4) * 0.01;
      host.engine.advanceTo(t + 10);
    }
    const soc = host.sim(1)['stateOfCharge'] as number;
    // About 5.15 A for 60 s: 309 C of 25 200, a drop of about 0.01226.
    expect(1 - soc).toBeCloseTo(0.01226, 4);
    expect(Math.abs(1 - soc - charge / Q)).toBeLessThan(1e-9 * (1 - soc));
    expect(host.record(1)['emfV']).toBe(batteryEmfV(params, soc));
    // The solver sees the EMF at that state of charge: V + I r at the terminals is E(s), below 12.9 V
    // (to the few µV the state of charge moves in the 10 ticks since the last solve).
    const solvedEmf = host.volts(1, 'pos', 1, 'neg') + 0.023 * host.amps(1);
    expect(Math.abs(solvedEmf - batteryEmfV(params, soc))).toBeLessThan(1e-5);
    expect(batteryEmfV(params, soc)).toBeLessThan(12.9 - 0.01);
  });

  it('counts only a solved island: an unmodelled one (the lamp until F2.5) or a mixed one never drains it', () => {
    const lamp = loop(LAMP).advance(500);
    expect(lamp.sim(1)['stateOfCharge']).toBe(1);
    expect(lamp.record(1)).toStrictEqual({
      emfV: 12.9,
      terminalV: 0,
      currentA: 0,
      stateOfCharge: 1,
      status: 'unsolved',
    });
    const mixed = new SourceHost();
    mixed.place(BATTERY);
    mixed.place(AC_SOURCE);
    mixed.lead(1, 'pos', 2, 'l').lead(2, 'n', 1, 'neg');
    mixed.advance(500);
    expect(mixed.engine.islands().map((i) => i.status)).toContain('mixed');
    expect(mixed.sim(1)['stateOfCharge']).toBe(1);
    // An unsettled island's currents look real but aren't readings: no charge is counted.
    const unsettled = loop(FLIP).advance(500);
    expect(unsettled.engine.islands()[0].status).toBe('nonConverged');
    expect(unsettled.sim(1)['stateOfCharge']).toBe(1);
    expect(unsettled.record(1)).toMatchObject({ status: 'unsettled', terminalV: 0, currentA: 0 });
  });

  /** A battery at state of charge `soc` across a bench supply (1) set to `volts` and `amps`, output on. */
  function charging(soc: number, volts: number, amps: number): SourceHost {
    const built = new SourceHost();
    built.place(BENCH_SUPPLY);
    built.place(BATTERY);
    built.lead(1, 'pos', 2, 'pos').lead(1, 'neg', 2, 'neg');
    built.operate(1, 'setpointV', volts).operate(1, 'currentLimitA', amps);
    const host = built.withSim(2, { stateOfCharge: soc });
    return host.operate(1, 'outputOn', true);
  }

  it('charges from half full: 1 A for 36 s adds 36 C of 25 200', () => {
    // 13.8 V limited to 1 A: E(0.5) = 12.35 V, so CV would push about 13.7 A: the supply limits at 1 A.
    const host = charging(0.5, 13.8, 1);
    expect(host.record(1)['mode']).toBe('cc');
    expect(host.amps(2)).toBeCloseTo(-1, 9); // into the battery's + (less gmin's leak)
    host.advance(36_000);
    const soc = host.sim(2)['stateOfCharge'] as number;
    expect(soc - 0.5).toBeCloseTo(36 / 25_200, 9);
  });

  it('a supply above the gassing voltage drives it to full, where the state of charge clamps at exactly 1', () => {
    // 15 V, 5 A from 99.9 %: 25.2 C to go at 5 A is about 5 s.
    const host = charging(0.999, 15, 5);
    host.advance(10_000);
    expect(host.sim(2)['stateOfCharge']).toBe(1);
    expect(World.safeParse(host.materialised()).success).toBe(true);
  });

  it('on a 13.8 V float the charge current tapers, and above about 93 % no current flows at all', () => {
    // E_c(s) reaches 13.8 V at s = 8 / 8.6 = 0.9302: below it the battery charges, above it it rests.
    const tapering = charging(0.92, 13.8, 5);
    const first = -tapering.amps(2);
    expect(first).toBeGreaterThan(0.5);
    tapering.advance(20_000);
    const later = -tapering.amps(2);
    expect(later).toBeGreaterThan(0);
    expect(later).toBeLessThan(first);
    expect(tapering.sim(2)['stateOfCharge']).toBeLessThan(8 / 8.6);
    const resting = charging(0.94, 13.8, 5);
    expect(resting.amps(2)).toBe(0);
    expect(resting.record(1)['mode']).toBe('cv'); // the supply holds 13.8 V, nothing flows
    resting.advance(5000);
    expect(resting.sim(2)['stateOfCharge']).toBe(0.94);
    expect(resting.engine.islands()[0].status).toBe('solved');
  });

  it('a flat battery collapses: shorted from 5 %, the current dies away and it never goes below empty', () => {
    // One lead across the terminals: about 190 A, so the 3 % above the collapse goes in about 4 s.
    const built = new SourceHost();
    built.place(BATTERY);
    built.lead(1, 'pos', 1, 'neg');
    const host = built.withSim(1, { stateOfCharge: 0.05 });
    const start = host.amps(1);
    expect(start).toBeGreaterThan(150);
    host.advance(60_000);
    const soc = host.sim(1)['stateOfCharge'] as number;
    expect(soc).toBeGreaterThan(0);
    expect(soc).toBeLessThan(0.02); // into the collapse, where the EMF falls with the charge left
    expect(host.amps(1)).toBeLessThan(start / 2);
    expect(host.record(1)['emfV']).toBe(batteryEmfV(params, soc));
    expect(World.safeParse(host.materialised()).success).toBe(true);
  });

  it('driven past empty by a source, the state of charge clamps at exactly 0 and the EMF is 0 V', () => {
    // A bench supply reversed across a battery at 0.1 %: 1 A forced through the cell in its discharge
    // direction (− to + inside), 25.2 C to empty in 25 s.
    const built = new SourceHost();
    built.place(BENCH_SUPPLY);
    built.place(BATTERY);
    built.lead(1, 'pos', 2, 'neg').lead(1, 'neg', 2, 'pos');
    built.operate(1, 'setpointV', 30).operate(1, 'currentLimitA', 1);
    const host = built.withSim(2, { stateOfCharge: 0.001 }).operate(1, 'outputOn', true);
    expect(host.amps(2)).toBeCloseTo(1, 9);
    host.advance(30_000);
    expect(host.sim(2)['stateOfCharge']).toBe(0);
    expect(host.record(2)['emfV']).toBe(0);
    expect(World.safeParse(host.materialised()).success).toBe(true);
  });

  it('a saved and reloaded battery continues bit for bit (state of charge and snapshot)', () => {
    const straight = loop(THERMAL_LOAD).advance(1234);
    const loaded = straight.reload();
    expect(loaded.sim(1)).toStrictEqual(straight.sim(1));
    straight.advance(5000);
    loaded.advance(5000);
    expect(Object.is(loaded.sim(1)['stateOfCharge'], straight.sim(1)['stateOfCharge'])).toBe(true);
    expect(loaded.engine.snapshotHash()).toBe(straight.engine.snapshotHash());
  });

  it('keeps its state of charge across a topology change and a save', () => {
    const host = loop(THERMAL_LOAD).advance(2000);
    const soc = host.sim(1)['stateOfCharge'] as number;
    expect(soc).toBeLessThan(1);
    host.lead(1, 'pos', 2, 'b'); // a lead across the load: a new topology
    expect(host.sim(1)['stateOfCharge']).toBe(soc);
    expect(host.materialised().entities[0].sim).toStrictEqual({ stateOfCharge: soc });
  });

  it('a hand-built world whose bag lacks the key (the bench plant) starts the battery full', () => {
    const host = loop(RESISTOR_2_4);
    const world = host.bus.state;
    const bare = { ...world, entities: world.entities.map((e) => (e.id === 1 ? { ...e, sim: {} } : e)) };
    const engine = SimEngine.start(bare, engineTestOptions());
    expect(engine.exportState().entities[0].state).toStrictEqual({ stateOfCharge: 1 });
  });

  it('publishes a valid output record schema', () => {
    expect(deviceOutputSchemaProblems(BATTERY_OUTPUT)).toStrictEqual([]);
    expect(BATTERY_OUTPUT.fields.map((f) => f.name)).toStrictEqual([
      'emfV',
      'terminalV',
      'currentA',
      'stateOfCharge',
      'status',
    ]);
  });
});
