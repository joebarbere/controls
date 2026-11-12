import {
  BUILTIN_CATALOG,
  LAMP_FILAMENT_MAX_K,
  LAMP_FILAMENT_MIN_K,
  type LampIncandescentParams,
  leadResistanceOhm,
  type LeadParams,
} from '@controls/catalog';
import { deviceOutputSchemaProblems } from '@controls/sim-protocol';
import fc from 'fast-check';
import { AC_SOURCE, BATTERY, LAMP, LEAD } from '../../../testing/bench';
import { BUSBAR, FLIP, OPAQUE, TWIN_SUPPLY } from '../../../testing/engine';
import { benchLampHost, LAMP_120V } from '../../../testing/loads';
import { BENCH_SUPPLY, SourceHost } from '../../../testing/sources';
import { LEAD_CONDUCTOR_TEMPERATURE_K } from '../../constants';
import {
  LAMP_AMBIENT_K,
  LAMP_CONDUCTION_FRACTION,
  LAMP_LIGHT_POWER_EXPONENT,
  LAMP_MAX_TEMP_K,
  LAMP_OUTPUT,
  LAMP_RESOLVE_RELTOL,
  lampResistanceOhm,
  pow17over8,
} from './lamp';
import { TUNGSTEN_RESISTIVITY, TUNGSTEN_TABLE_MAX_K, tungstenResistivity } from './tungsten';

/*
 * The incandescent lamp (plan F2.5): tungsten R(T), the filament's thermal ODE, the inrush that
 * emerges from it, and the light output from the published relation. Hand calculations:
 *
 * - ρ(2700 K) = 77.49 + (84.70 − 77.49) · 100/200 = 81.095 µΩ·cm (between the 2600 and 2800 K points);
 * - ρ(293.15 K) = 5.65 − (8.06 − 5.65) · 6.85/100 = 5.484915 µΩ·cm (the 300–400 K segment extended);
 * - the bench lamp: R_r = 12² / 5 = 28.8 Ω, so R_cold = 28.8 · 5.484915 / 81.095 = 1.947907 Ω (14.79× colder);
 * - the inrush through the bench demo: E = 12.9 V (a full battery) behind 23 mΩ, three 1 m leads of
 *   `leadResistanceOhm` each, so I_peak = 12.9 / (1.947907 + 0.023 + 3 R_lead) at the closing solve;
 * - the ODE's constants (engine 6), f = 0.1, P_r = 5 W, T_r = 2700 K, T_a = 293.15 K, τ = 50 ms:
 *   T_r⁴ − T_a⁴ = 5.3144100e13 − 7.3852e9 = 5.3136715e13 K⁴, so k = 0.9 · 5 / 5.3136715e13
 *   = 8.468721e-14 W/K⁴; G = 0.1 · 5 / 2406.85 = 2.077404e-4 W/K; 4 k T_r³ = 4 · 8.468721e-14 · 1.9683e10
 *   = 6.667593e-3 W/K, so C = (6.667593e-3 + 2.077404e-4) · 0.05 = 3.437667e-4 J/K;
 * - near ambient the loss is linear, G + 4 k T_a³ = 2.077404e-4 + 4 · 8.468721e-14 · 2.519241e7
 *   = 2.077404e-4 + 8.533899e-6 = 2.162743e-4 W/K, so an excess ΔT decays as e^(−λt) with
 *   λ = 2.162743e-4 / 3.437667e-4 = 0.629131 /s: 10 K falls to 10 · e^(−0.629131) = 5.3305 K in 1 s;
 * - deep in the cool-down conduction alone sets the pace: C / G = 1.6548 s.
 */

const lampParams = BUILTIN_CATALOG.device(LAMP)?.model.params as LampIncandescentParams;
const leadOhm = leadResistanceOhm(
  BUILTIN_CATALOG.device(LEAD)?.model.params as LeadParams,
  LEAD_CONDUCTOR_TEMPERATURE_K.value,
);
const RATED_OHM = 28.8;
const RHO_RATED = 81.095;
const RHO_AMBIENT = 5.484915;
const COLD_OHM = (RATED_OHM * RHO_AMBIENT) / RHO_RATED;

/** A bench supply (1) at `volts` into the lamp (2) through two busbar links (17 nΩ each), output on. */
function supplied(volts: number, ref = LAMP): SourceHost {
  const host = new SourceHost();
  host.place(BENCH_SUPPLY);
  host.place(ref);
  host.exec('lead.connect', { ref: BUSBAR, a: { entity: 1, terminal: 'pos' }, b: { entity: 2, terminal: 'a' } });
  host.exec('lead.connect', { ref: BUSBAR, a: { entity: 2, terminal: 'b' }, b: { entity: 1, terminal: 'neg' } });
  return host.operate(1, 'setpointV', volts).operate(1, 'currentLimitA', 5).operate(1, 'outputOn', true);
}

const rel = (actual: number, expected: number) => Math.abs(actual / expected - 1);

/** The bench lamp's conductance to its two lead-ins (hand calculation above), W/K. */
const CONDUCTANCE = (LAMP_CONDUCTION_FRACTION.value * 5) / (2700 - LAMP_AMBIENT_K.value);

describe('tungsten resistivity (Jones and Langmuir)', () => {
  it('passes through every sourced point and rises monotonically, with the hand-calculated interpolations', () => {
    TUNGSTEN_RESISTIVITY.temperaturesK.forEach((t, i) => {
      expect(tungstenResistivity(t)).toBeCloseTo(TUNGSTEN_RESISTIVITY.microOhmCm[i], 12);
    });
    expect(TUNGSTEN_RESISTIVITY.source).toMatch(/Jones and I. Langmuir/);
    expect(tungstenResistivity(2700)).toBeCloseTo(RHO_RATED, 12);
    expect(tungstenResistivity(293.15)).toBeCloseTo(RHO_AMBIENT, 12);
    fc.assert(
      fc.property(
        fc.double({ min: 200, max: 3700, noNaN: true }),
        fc.double({ min: 0.01, max: 500, noNaN: true }),
        (t, d) => {
          expect(tungstenResistivity(t + d)).toBeGreaterThan(tungstenResistivity(t));
        },
      ),
    );
    // The inrush band's source (the lamp entry's `inrush-band`): a cold-to-hot ratio of 13.5–16.1 for
    // rated temperatures of 2500–2900 K at a 293.15 K bench.
    expect(tungstenResistivity(2500) / tungstenResistivity(293.15)).toBeCloseTo(13.48, 2);
    expect(tungstenResistivity(2900) / tungstenResistivity(293.15)).toBeCloseTo(16.11, 2);
    // About T^1.2 overall (the usual rule of thumb): 16.3× from 300 K to 3000 K.
    expect(tungstenResistivity(3000) / tungstenResistivity(300)).toBeCloseTo(16.29, 2);
    expect(TUNGSTEN_TABLE_MAX_K).toBe(LAMP_MAX_TEMP_K.value);
    // The save format's bounds on filamentTempK sit inside the model's range: above where the table's
    // first segment extended reaches 0 Ω, at its top (save-format review of F2.5).
    expect(LAMP_FILAMENT_MAX_K).toBe(LAMP_MAX_TEMP_K.value);
    const zeroK = 300 - TUNGSTEN_RESISTIVITY.microOhmCm[0] / ((8.06 - 5.65) / 100);
    expect(zeroK).toBeCloseTo(65.56, 2);
    expect(LAMP_FILAMENT_MIN_K).toBeGreaterThan(zeroK);
    expect(tungstenResistivity(LAMP_FILAMENT_MIN_K)).toBeGreaterThan(0);
  });

  it('x^(17/8) is x² · ⁸√x within an ulp or two of Math.pow, and 0 for x ≤ 0', () => {
    expect(LAMP_LIGHT_POWER_EXPONENT.value).toBe(3.4 / 1.6);
    expect(pow17over8(1)).toBe(1);
    expect(pow17over8(0)).toBe(0);
    expect(pow17over8(-1e-9)).toBe(0);
    expect(pow17over8(Number.NaN)).toBe(0);
    fc.assert(
      fc.property(fc.double({ min: 1e-9, max: 64, noNaN: true }), (x) => {
        expect(rel(pow17over8(x), Math.pow(x, 17 / 8))).toBeLessThan(1e-15);
      }),
    );
  });
});

describe('the lamp model (golden)', () => {
  it('publishes a valid record schema, and R(T) is exact at the rated point and 1/14.8 of it cold', () => {
    expect(deviceOutputSchemaProblems(LAMP_OUTPUT)).toStrictEqual([]);
    expect(lampParams).toStrictEqual({
      ratedVoltageV: 12,
      ratedPowerW: 5,
      filamentRatedTempK: 2700,
      thermalTimeConstantMs: 50,
    });
    expect(rel(lampResistanceOhm(RATED_OHM, tungstenResistivity(2700), 2700), RATED_OHM)).toBeLessThan(1e-15);
    expect(rel(lampResistanceOhm(RATED_OHM, tungstenResistivity(2700), LAMP_AMBIENT_K.value), COLD_OHM)).toBeLessThan(
      1e-12,
    );
    expect(RATED_OHM / COLD_OHM).toBeCloseTo(14.785, 3);
  });

  it('a saved filament outside the model range is clamped into it at the bank build (never a negative R)', () => {
    const host = benchLampHost();
    const cold = host.withSim(3, { filamentTempK: 200 });
    expect(cold.sim(3)).toStrictEqual({ filamentTempK: LAMP_AMBIENT_K.value });
    cold.operate(2, 'closed', true).advance(10);
    expect(cold.record(3)['status']).toBe('solved');
  });

  it('a new lamp starts at ambient: the inrush at the closing solve is E over the cold resistance and the series R', () => {
    const host = benchLampHost();
    expect(host.sim(3)).toStrictEqual({ filamentTempK: LAMP_AMBIENT_K.value });
    host.advance(5).operate(2, 'closed', true);
    const peak = host.record(3);
    const expected = 12.9 / (COLD_OHM + 0.023 + 3 * leadOhm);
    expect(rel(peak['currentA'] as number, expected)).toBeLessThan(1e-9);
    expect(peak).toMatchObject({ filamentTempK: LAMP_AMBIENT_K.value, lightOutputRel: 0, status: 'solved' });
    expect(rel(peak['resistanceOhm'] as number, COLD_OHM)).toBeLessThan(1e-12);
  });

  it('the inrush emerges: the peak is 10 to 15 times the settled current (the sourced band), and decays monotonically', () => {
    const host = benchLampHost().operate(2, 'closed', true);
    const peak = host.amps(3);
    let last = peak;
    for (let t = 0; t < 300; t++) {
      host.advance(1);
      const now = host.amps(3);
      expect(now).toBeLessThanOrEqual(last);
      last = now;
    }
    host.advance(1700);
    const settled = host.amps(3);
    const ratio = peak / settled;
    // The band follows from Jones and Langmuir: ρ(T_r)/ρ(T_a) is 13.5–16.1 for T_r of 2500–2900 K,
    // lowered by the series resistance (the lamp entry's `inrush-band` source); this lamp gives 14.3.
    expect(ratio).toBeGreaterThan(10);
    expect(ratio).toBeLessThan(15);
    // 14.26 under engine 5 (radiation alone): conduction leaves the filament 4 K hotter at 12.84 V.
    expect(ratio).toBeCloseTo(14.28, 2);
  });

  it('settles at its rated point on its rated voltage: 5 W, 2700 K, light 1 (within 0.5 %)', () => {
    const host = supplied(12).advance(2000);
    const r = host.record(2);
    // The supply's 1 mΩ output resistance takes 0.4 mV of the 12 V: the lamp is a hair under rated.
    expect(rel(r['powerW'] as number, 5)).toBeLessThan(0.005);
    expect(rel(r['filamentTempK'] as number, 2700)).toBeLessThan(0.005);
    expect(rel(r['lightOutputRel'] as number, 1)).toBeLessThan(0.005);
    expect(rel(r['resistanceOhm'] as number, RATED_OHM)).toBeLessThan(0.005);
    expect(rel(r['voltageV'] as number, 12)).toBeLessThan(0.0005);
    // At the steady state the electrical power is the radiated power plus the conducted, so the light is
    // ((P − G (T − T_a)) / ((1 − f) P_r))^(17/8): the energy balance, read back from the record.
    const radiated = (r['powerW'] as number) - CONDUCTANCE * ((r['filamentTempK'] as number) - LAMP_AMBIENT_K.value);
    expect(rel(r['lightOutputRel'] as number, Math.pow(radiated / (0.9 * 5), 17 / 8))).toBeLessThan(1e-4);
  });

  it('light follows the published relation, L ∝ V^3.4, within 4 % from 75 % to 115 % of rated voltage', () => {
    for (const volts of [9, 10.5, 12, 13.8]) {
      const r = supplied(volts).advance(3000).record(2);
      const published = Math.pow((r['voltageV'] as number) / 12, 3.4);
      // Constant emissivity alone gave L ∝ V^3.27, 3.9 % above the fit at 75 % of rated voltage (engine
      // 5). Conduction makes no light and takes a larger share of a cooler filament's power, so it
      // steepens the curve: 2.6 % below the fit at 75 %, 1.0 % below at 87.5 %, 0.6 % above at 115 %.
      expect(rel(r['lightOutputRel'] as number, published)).toBeLessThan(volts < 10 ? 0.04 : 0.02);
    }
  });

  it('goes dark when the switch opens: below one display step (1/255) within 500 ms, and never below ambient', () => {
    const host = benchLampHost().operate(2, 'closed', true).advance(1500);
    expect(host.record(3)['lightOutputRel']).toBeGreaterThan(1);
    host.operate(2, 'closed', false);
    expect(host.record(3)).toMatchObject({ powerW: 0, currentA: 0, status: 'solved' });
    host.advance(500);
    expect(host.record(3)['lightOutputRel']).toBeLessThan(1 / 255);
    host.advance(10_000);
    const r = host.record(3);
    expect(r['lightOutputRel']).toBeLessThan(1e-5);
    expect(r['filamentTempK']).toBeGreaterThanOrEqual(LAMP_AMBIENT_K.value);
  });

  it('the ODE constants match the hand calculation: k, G and C from f, P_r, T_r and τ', () => {
    expect(LAMP_CONDUCTION_FRACTION.value).toBe(0.1);
    expect(LAMP_CONDUCTION_FRACTION.source).toMatch(/Langmuir, S. MacLane and K. B. Blodgett/);
    const span4 = 2700 ** 4 - LAMP_AMBIENT_K.value ** 4;
    const k = (0.9 * 5) / span4;
    const capacity = (4 * k * 2700 ** 3 + CONDUCTANCE) * 0.05;
    expect(rel(span4, 5.3136715e13)).toBeLessThan(1e-7);
    expect(rel(k, 8.468721e-14)).toBeLessThan(1e-6);
    expect(rel(CONDUCTANCE, 2.077404e-4)).toBeLessThan(1e-6);
    expect(rel(capacity, 3.437667e-4)).toBeLessThan(1e-6);
    expect(rel(capacity / CONDUCTANCE, 1.6548)).toBeLessThan(1e-4);
    // Hot, radiation's slope is about 32 times conduction's: the warm-up is radiation's business.
    expect((4 * k * 2700 ** 3) / CONDUCTANCE).toBeCloseTo(32.1, 1);
  });

  it('near ambient a 10 K excess decays as e^(−λt), λ = (G + 4 k T_a³) / C: 5.3305 K after 1 s (hand calculation, 0.5 %)', () => {
    const host = benchLampHost().withSim(3, { filamentTempK: LAMP_AMBIENT_K.value + 10 });
    host.advance(1000);
    const excess = (host.record(3)['filamentTempK'] as number) - LAMP_AMBIENT_K.value;
    expect(rel(excess, 10 * Math.exp(-0.629131))).toBeLessThan(0.005);
    expect(rel(excess, 5.3305)).toBeLessThan(0.005);
  });

  it('cools by radiation and then conduction: under 600 K within 2 s of the switch opening, 400 K within 3.5 s, ambient + 10 K within 7.5 s', () => {
    const host = benchLampHost().operate(2, 'closed', true).advance(1500).operate(2, 'closed', false);
    const marks = [600, 400, LAMP_AMBIENT_K.value + 10];
    const reached = marks.map(() => 0);
    let last = host.record(3)['filamentTempK'] as number;
    for (let t = 1; t <= 8000; t++) {
      host.advance(1);
      const now = host.record(3)['filamentTempK'] as number;
      expect(now).toBeLessThanOrEqual(last);
      marks.forEach((mark, m) => {
        if (reached[m] === 0 && now < mark) reached[m] = t;
      });
      last = now;
    }
    // Measured: 1761, 3344 and 7073 ms. Radiation alone (engine 5) took about 6.2 s and 20 s to the first two.
    expect(reached[0]).toBeGreaterThan(1500);
    expect(reached[0]).toBeLessThan(2000);
    expect(reached[1]).toBeGreaterThan(0);
    expect(reached[1]).toBeLessThan(3500);
    expect(reached[2]).toBeGreaterThan(0);
    expect(reached[2]).toBeLessThan(7500);
  });

  it('a re-strike shows more of the cold inrush the longer the filament has cooled: about half after 2 s, nearly all after 10 s', () => {
    const cold = benchLampHost().operate(2, 'closed', true).amps(3);
    const restrike = (offMs: number): number =>
      benchLampHost()
        .operate(2, 'closed', true)
        .advance(1500)
        .operate(2, 'closed', false)
        .advance(offMs)
        .operate(2, 'closed', true)
        .amps(3) / cold;
    const ratios = [500, 1000, 2000, 5000, 10_000].map(restrike);
    for (let i = 1; i < ratios.length; i++) expect(ratios[i]).toBeGreaterThan(ratios[i - 1]);
    // Measured 0.20, 0.29, 0.48, 0.87 and 0.994 (engine 5, radiation alone: 0.17, 0.21, 0.28, 0.40, 0.52).
    expect(ratios[2]).toBeGreaterThan(0.45);
    expect(ratios[3]).toBeGreaterThan(0.85);
    expect(ratios[4]).toBeGreaterThan(0.99);
    expect(ratios[4]).toBeLessThanOrEqual(1);
  });

  it('an open circuit never warms the filament nor takes it below ambient, from any temperature (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: LAMP_AMBIENT_K.value, max: LAMP_MAX_TEMP_K.value, noNaN: true }), (start) => {
        const host = benchLampHost().withSim(3, { filamentTempK: start });
        let last = host.record(3)['filamentTempK'] as number;
        for (let t = 0; t < 40; t++) {
          host.advance(50);
          const now = host.record(3)['filamentTempK'] as number;
          expect(now).toBeLessThanOrEqual(last);
          expect(now).toBeGreaterThanOrEqual(LAMP_AMBIENT_K.value);
          last = now;
        }
        // 2 s from anywhere in the model's range: under 650 K.
        expect(last).toBeLessThan(650);
      }),
      { numRuns: 25 },
    );
  });

  it('a reload mid-cool-down runs on byte for byte with the straight run', () => {
    const straight = benchLampHost().operate(2, 'closed', true).advance(1500).operate(2, 'closed', false).advance(777);
    const loaded = straight.reload();
    for (let t = 0; t < 1500; t += 50) {
      straight.advance(50);
      loaded.advance(50);
      expect(loaded.engine.snapshotHash()).toBe(straight.engine.snapshotHash());
    }
    expect(loaded.record(3)['filamentTempK']).toBe(straight.record(3)['filamentTempK']);
  });

  it('re-solves within the step while the filament heats, and not once it has settled or on an open circuit', () => {
    const host = benchLampHost();
    host.advance(500);
    expect(host.engine.stats.continuousSolves).toBe(0); // open circuit: gmin-level current, no re-solve
    host.operate(2, 'closed', true).advance(400);
    const warmUp = host.engine.stats.continuousSolves;
    expect(warmUp).toBeGreaterThan(30);
    host.advance(2000);
    expect(host.engine.stats.continuousSolves).toBe(warmUp);
    expect(LAMP_RESOLVE_RELTOL.value).toBe(0.01);
  });

  it('through the warm-up the solve never lags the filament by more than 1 %, and does lag by over 0.5 % (the threshold bites)', () => {
    const host = benchLampHost().operate(2, 'closed', true);
    let worst = 0;
    for (let t = 0; t < 400; t++) {
      host.advance(1);
      const r = host.record(3);
      // The filament's R(T) now against what the last solve saw, V / I.
      const seen = (r['voltageV'] as number) / (r['currentA'] as number);
      const lag = Math.abs((r['resistanceOhm'] as number) - seen) / (r['resistanceOhm'] as number);
      expect(lag).toBeLessThanOrEqual(LAMP_RESOLVE_RELTOL.value);
      worst = Math.max(worst, lag);
    }
    expect(worst).toBeGreaterThan(0.005);
  });

  it('a reload mid-warm-up re-solves at exactly the ticks the straight run does (the trigger reads the solution)', () => {
    const straight = benchLampHost().operate(2, 'closed', true).advance(23);
    const loaded = straight.reload();
    for (let t = 0; t < 120; t++) {
      straight.advance(1);
      loaded.advance(1);
      expect(loaded.engine.snapshotHash()).toBe(straight.engine.snapshotHash());
    }
    expect(loaded.engine.stats.continuousSolves).toBeGreaterThan(10);
  });

  it('a reload of a settled lamp asks for no re-solve the straight run does not (nothing cached survives a load)', () => {
    // Cut mid-interval, so a spurious re-solve would show in the snapshot's lastSolveTick.
    const straight = benchLampHost().operate(2, 'closed', true).advance(1503);
    const loaded = straight.reload();
    const before = straight.engine.stats.continuousSolves;
    for (let t = 0; t < 30; t++) {
      straight.advance(1);
      loaded.advance(1);
      expect(loaded.engine.snapshotHash()).toBe(straight.engine.snapshotHash());
    }
    expect(straight.engine.stats.continuousSolves).toBe(before);
    expect(loaded.engine.stats.continuousSolves).toBe(0);
  });

  it('on an AC island: a 120 V 60 W lamp on a 120 V source settles at its rating (RMS values, within 0.5 %)', () => {
    const host = new SourceHost();
    host.place(AC_SOURCE);
    host.place(LAMP_120V);
    host.lead(1, 'l', 2, 'a').lead(2, 'b', 1, 'n');
    const peak = host.record(2);
    host.advance(3000);
    const r = host.record(2);
    expect(host.engine.islands()[0]).toMatchObject({ kind: 'ac', status: 'solved' });
    expect(rel(r['powerW'] as number, 60)).toBeLessThan(0.005);
    expect(rel(r['voltageV'] as number, 120)).toBeLessThan(0.005);
    expect(r['currentA']).toBeGreaterThan(0);
    expect((peak['currentA'] as number) / (r['currentA'] as number)).toBeGreaterThan(10);
  });
});

describe('the validity rule: a lamp on an unsolved island is unknown, never dark at 0 W (plan F2.5)', () => {
  /** The bench lamp, lit, then `load` wired across the lamp's own terminals (a parallel branch). */
  function litThen(load: { id: string; version: number }): SourceHost {
    const host = benchLampHost().operate(2, 'closed', true).advance(1500);
    const id = host.place(load);
    return host.lead(id, 'a', 3, 'a').lead(id, 'b', 3, 'b');
  }

  it('unmodelled: status unsolved, the solved fields zero, its own state (hot, lit) frozen rather than cooling', () => {
    const host = litThen(OPAQUE);
    const before = host.record(3);
    expect(before).toMatchObject({ status: 'unsolved', powerW: 0, currentA: 0, voltageV: 0 });
    expect(before['lightOutputRel']).toBeGreaterThan(1);
    host.advance(500);
    expect(host.record(3)).toStrictEqual(before);
  });

  it('unsettled (a non-converged island): status unsettled, never a steady reading', () => {
    const host = litThen(FLIP);
    expect(host.engine.islands()[0].status).toBe('nonConverged');
    expect(host.record(3)).toMatchObject({ status: 'unsettled', powerW: 0, currentA: 0 });
  });

  it('singular: status singular', () => {
    const host = new SourceHost();
    host.place(TWIN_SUPPLY);
    host.place(LAMP);
    host.lead(1, 'pos', 2, 'a').lead(2, 'b', 1, 'neg');
    expect(host.record(2)).toMatchObject({ status: 'singular', powerW: 0, filamentTempK: LAMP_AMBIENT_K.value });
  });

  it('a battery and a lamp alone is solved: the circuit is the reading', () => {
    const host = new SourceHost();
    host.place(BATTERY);
    host.place(LAMP);
    host.lead(1, 'pos', 2, 'a').lead(2, 'b', 1, 'neg').advance(1000);
    expect(host.record(2)).toMatchObject({ status: 'solved' });
    expect(host.record(2)['lightOutputRel']).toBeGreaterThan(1);
  });
});
