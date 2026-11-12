import { BUILTIN_CATALOG, type HeaterParams, type LampIncandescentParams } from '@controls/catalog';
import { AC_SOURCE, SPST } from '../../../testing/bench';
import { AC_SOURCE_OHMS, BUSBAR, RHEOSTAT } from '../../../testing/engine';
import { SourceHost } from '../../../testing/sources';
import { LAMP_AMBIENT_K, LAMP_CONDUCTION_FRACTION, lampConductionFraction, lampResistanceOhm } from './lamp';
import { tungstenResistivity } from './tungsten';

/*
 * P3 decision D12's demo loads: the 120 V 60 W lamp (`lamp.lumivane-120v-60w@1`, with D17's τ ≈ 30 ms /
 * f ≈ 0.05 pairing) and the 120 V 1500 W heater (`heater.hearthvale-120v-1500w@1`). Hand calculations:
 *
 * - the lamp: R_r = 120² / 60 = 240 Ω, I_r = 60 / 120 = 0.5 A;
 * - ρ(2700 K) = 81.095 µΩ·cm and ρ(293.15 K) = 5.484915 µΩ·cm (`lamp.spec.ts`), so
 *   R_cold = 240 · 5.484915 / 81.095 = 16.23256 Ω, 1/14.7851 of the hot resistance: inside the entry's
 *   `inrush-band` source (13.5–16.1 for 2500–2900 K), so a cold start on a stiff 120 V source draws
 *   120 / 16.23 = 7.39 A, about 14.8 × the settled 0.5 A;
 * - the ODE's constants (engine 7's lamp model), f = 0.05, P_r = 60 W, T_r = 2700 K, T_a = 293.15 K,
 *   τ = 30 ms: T_r⁴ − T_a⁴ = 5.3144100e13 − 7.3852e9 = 5.3136715e13 K⁴, so
 *   k = 0.95 · 60 / 5.3136715e13 = 1.0727046e-12 W/K⁴; G = 0.05 · 60 / 2406.85 = 1.2464424e-3 W/K;
 *   4 k T_r³ = 4 · 1.0727046e-12 · 1.9683e10 = 8.4456181e-2 W/K, so the rated loss slope is
 *   8.5702623e-2 W/K and C = 8.5702623e-2 · 0.030 = 2.5710787e-3 J/K; the cool-down's tail, C / G = 2.0627 s;
 * - the τ physics estimate (the entry's `filament-time-constant` source): a straight wire radiating
 *   (1 − f) · 60 = 57 W at 2700 K with ε = 0.317 needs A = 57 / (0.317 σ (T_r⁴ − T_a⁴)) = 5.9680e-5 m²
 *   = π d L; with R = ρ L / (π d² / 4) = 240 Ω, d³ = 4 ρ A / (π² R), so d = 43.4 µm, L = 438 mm,
 *   m = 19300 · π d² / 4 · L = 12.50 mg; C = m · 36.192 / 183.84 J/(g·K) = 2.460 mJ/K and
 *   τ = C / 8.5702623e-2 = 28.7 ms. If 90 % of a coil's surface radiates freely, A grows by 1/0.9 and
 *   τ = 33.0 ms. The entry takes 30 ms (its model heat capacity 2.571 mJ/K is 4.5 % above the
 *   straight-wire estimate);
 * - the heater: R = 120² / 1500 = 9.6 Ω, I = 1500 / 120 = 12.5 A;
 * - both at 120 V: 12.5 + 0.5 = 13.0 A (D12's demo, before the wiring's drop);
 * - on the test AC source (120 V behind `AC_SOURCE_OHMS` = 0.1 Ω): the lamp's cold closing solve draws
 *   120 / (16.23256 + 0.1) = 7.34735 A; the heater alone 120 / 9.7 = 12.37113 A, 1469.23 W.
 */

const LAMP_REF = { id: 'lamp.lumivane-120v-60w', version: 1 };
const HEATER_REF = { id: 'heater.hearthvale-120v-1500w', version: 1 };
const lamp = BUILTIN_CATALOG.device(LAMP_REF)?.model.params as LampIncandescentParams;
const heater = BUILTIN_CATALOG.device(HEATER_REF)?.model.params as HeaterParams;

const rel = (actual: number, expected: number) => Math.abs(actual / expected - 1);
const RHO_RATED = 81.095;
const RHO_AMBIENT = 5.484915;

/** The test 120 V AC source (1, behind 0.1 Ω) with each `refs` device across it through busbar links (17 nΩ). */
function across(...refs: { id: string; version: number }[]): SourceHost {
  const host = new SourceHost();
  host.place(AC_SOURCE);
  refs.forEach((ref, i) => {
    const id = host.place(ref);
    expect(id).toBe(i + 2);
    host.exec('lead.connect', { ref: BUSBAR, a: { entity: 1, terminal: 'l' }, b: { entity: id, terminal: 'a' } });
    host.exec('lead.connect', { ref: BUSBAR, a: { entity: id, terminal: 'b' }, b: { entity: 1, terminal: 'n' } });
  });
  return host;
}

describe('the 120 V 60 W lamp (D12, D17): hand calculations', () => {
  it('carries the rated values and the recalibrated pairing; R_r = 240 Ω, I_r = 0.5 A', () => {
    expect(lamp).toStrictEqual({
      ratedVoltageV: 120,
      ratedPowerW: 60,
      filamentRatedTempK: 2700,
      thermalTimeConstantMs: 30,
      conductionFraction: 0.05,
    });
    const ratedOhm = (lamp.ratedVoltageV * lamp.ratedVoltageV) / lamp.ratedPowerW;
    expect(rel(ratedOhm, 240)).toBeLessThan(1e-15);
    expect(rel(lamp.ratedPowerW / lamp.ratedVoltageV, 0.5)).toBeLessThan(1e-15);
    // The pairing is the entry's own; the bench lamp keeps the sourced default (D17).
    expect(lampConductionFraction(lamp)).toBe(0.05);
    const bench = BUILTIN_CATALOG.device({ id: 'lamp.lumivane-12v-5w', version: 1 })?.model
      .params as LampIncandescentParams;
    expect(bench.conductionFraction).toBeUndefined();
    expect(lampConductionFraction(bench)).toBe(LAMP_CONDUCTION_FRACTION.value);
  });

  it('is 16.23 Ω cold, 1/14.79 of hot: inside the inrush band its source states (13.5–16.1)', () => {
    const rhoRated = tungstenResistivity(lamp.filamentRatedTempK);
    expect(rhoRated).toBeCloseTo(RHO_RATED, 12);
    const cold = lampResistanceOhm(240, rhoRated, LAMP_AMBIENT_K.value);
    expect(rel(cold, (240 * RHO_AMBIENT) / RHO_RATED)).toBeLessThan(1e-12);
    expect(rel(cold, 16.23256)).toBeLessThan(1e-6);
    const ratio = 240 / cold;
    expect(rel(ratio, 14.7851)).toBeLessThan(1e-5);
    expect(ratio).toBeGreaterThan(13.5);
    expect(ratio).toBeLessThan(16.1);
  });

  it('the model constants: k, G, C = 2.5711 mJ/K and the tail C / G = 2.063 s', () => {
    const ambient = LAMP_AMBIENT_K.value;
    const tr = lamp.filamentRatedTempK;
    const f = lampConductionFraction(lamp);
    const span4 = tr * tr * tr * tr - ambient * ambient * ambient * ambient;
    expect(rel(span4, 5.3136715e13)).toBeLessThan(1e-7);
    const k = ((1 - f) * lamp.ratedPowerW) / span4;
    const g = (f * lamp.ratedPowerW) / (tr - ambient);
    expect(rel(k, 1.0727046e-12)).toBeLessThan(1e-6);
    expect(rel(g, 1.2464424e-3)).toBeLessThan(1e-6);
    const slope = 4 * k * tr * tr * tr + g;
    expect(rel(slope, 8.5702623e-2)).toBeLessThan(1e-6);
    const c = slope * (lamp.thermalTimeConstantMs / 1000);
    expect(rel(c, 2.5710787e-3)).toBeLessThan(1e-6);
    expect(rel(c / g, 2.0627)).toBeLessThan(0.005);
  });

  it('τ = 30 ms lies inside the physics estimate (28.7 ms straight wire, 33.0 ms at 90 % free surface)', () => {
    // Stefan–Boltzmann σ (CODATA 2018), tungsten's total emissivity at 2700 K between Holladay's 0.311
    // (2600 K) and 0.323 (2800 K), ρ(2700 K) from Jones and Langmuir, 19 300 kg/m³, and NIST-JANAF's
    // c_p of crystalline tungsten at 2700 K (36.192 J/(mol·K), 183.84 g/mol).
    const sigma = 5.670374419e-8;
    const emissivity = (0.311 + 0.323) / 2;
    const rho = RHO_RATED * 1e-8;
    const cp = (36.192 / 183.84) * 1000;
    const ambient = LAMP_AMBIENT_K.value;
    const tr = 2700;
    const span4 = tr ** 4 - ambient ** 4;
    const slope = 8.5702623e-2;
    const estimate = (freeSurface: number) => {
      const area = 57 / (freeSurface * emissivity * sigma * span4);
      const d = Math.cbrt((4 * rho * area) / (Math.PI * Math.PI * 240));
      const length = area / (Math.PI * d);
      const mass = (19300 * Math.PI * d * d * length) / 4;
      return { d, length, mass, tauMs: ((mass * cp) / slope) * 1000 };
    };
    const straight = estimate(1);
    expect(rel(straight.d, 43.4e-6)).toBeLessThan(0.005);
    expect(rel(straight.length, 0.438)).toBeLessThan(0.005);
    expect(rel(straight.mass, 12.5e-6)).toBeLessThan(0.005);
    expect(rel(straight.tauMs, 28.7)).toBeLessThan(0.005);
    const coiled = estimate(0.9);
    expect(rel(coiled.tauMs, 33.0)).toBeLessThan(0.005);
    expect(lamp.thermalTimeConstantMs).toBeGreaterThan(straight.tauMs);
    expect(lamp.thermalTimeConstantMs).toBeLessThan(coiled.tauMs);
  });
});

describe('the 120 V 1500 W heater (D12): hand calculations', () => {
  it('is 9.6 Ω at its rating, 12.5 A', () => {
    expect(heater).toStrictEqual({ ratedVoltageV: 120, ratedPowerW: 1500 });
    expect(rel((heater.ratedVoltageV * heater.ratedVoltageV) / heater.ratedPowerW, 9.6)).toBeLessThan(1e-15);
    expect(rel(heater.ratedPowerW / heater.ratedVoltageV, 12.5)).toBeLessThan(1e-15);
  });
});

describe('the D12 loads in the engine, on the test 120 V source (0.1 Ω)', () => {
  it('the lamp settles at 60 W, 0.5 A, light 1, after a cold inrush of about 14.8 × (inside the 10–15 × band)', () => {
    const host = across(LAMP_REF);
    const peak = host.record(2);
    expect(peak['status']).toBe('solved');
    // The closing solve sees the cold filament: 120 / (16.23256 + 0.1) = 7.34735 A.
    expect(AC_SOURCE_OHMS).toBe(0.1);
    expect(rel(peak['currentA'] as number, 7.34735)).toBeLessThan(0.005);
    host.advance(3000);
    const r = host.record(2);
    expect(host.engine.islands()[0]).toMatchObject({ kind: 'ac', status: 'solved' });
    expect(rel(r['powerW'] as number, 60)).toBeLessThan(0.005);
    expect(rel(r['currentA'] as number, 0.5)).toBeLessThan(0.005);
    expect(rel(r['resistanceOhm'] as number, 240)).toBeLessThan(0.005);
    expect(rel(r['lightOutputRel'] as number, 1)).toBeLessThan(0.005);
    const ratio = (peak['currentA'] as number) / (r['currentA'] as number);
    expect(ratio).toBeGreaterThanOrEqual(10);
    expect(ratio).toBeLessThanOrEqual(15);
  });

  it('light follows the published relation, L ∝ V^3.4, within 1 % from 75 % to 115 % of rated voltage', () => {
    // Two test sources in series (240 V behind 0.2 Ω) through a rheostat, set from the hand estimate
    // R_s = R(v) · (2 / v − 1) with R(v) ≈ 240 · v^0.4, so the lamp sees about v × 120 V.
    for (const [v, ohms] of [
      [0.75, 355.3],
      [0.875, 292.4],
      [1, 240],
      [1.15, 187.5],
    ]) {
      const host = new SourceHost();
      host.place(AC_SOURCE);
      host.place(AC_SOURCE);
      host.place(RHEOSTAT);
      host.place(LAMP_REF);
      const link = (a: number, ta: string, b: number, tb: string) =>
        host.exec('lead.connect', { ref: BUSBAR, a: { entity: a, terminal: ta }, b: { entity: b, terminal: tb } });
      link(1, 'l', 2, 'n');
      link(2, 'l', 3, 'a');
      link(3, 'b', 4, 'a');
      link(4, 'b', 1, 'n');
      const r = host.operate(3, 'ohms', ohms).advance(3000).record(4);
      const ratio = (r['voltageV'] as number) / 120;
      expect(Math.abs(ratio - v)).toBeLessThan(0.03);
      // f = 0.05 is where the model's curve fits best (the reviewer measured within 0.7 %).
      expect(rel(r['lightOutputRel'] as number, Math.pow(ratio, 3.4))).toBeLessThan(0.01);
    }
  });

  it('cools with its own f = 0.05: the engine follows the ODE with the entry’s fraction, not the default 0.1', () => {
    // The test source (1) → SPST (2) → lamp (3) → back, busbar links; lit for 3 s, then switched off.
    const host = new SourceHost();
    host.place(AC_SOURCE);
    host.place(SPST);
    host.place(LAMP_REF);
    const link = (a: number, ta: string, b: number, tb: string) =>
      host.exec('lead.connect', { ref: BUSBAR, a: { entity: a, terminal: ta }, b: { entity: b, terminal: tb } });
    link(1, 'l', 2, 'a');
    link(2, 'b', 3, 'a');
    link(3, 'b', 1, 'n');
    host.operate(2, 'closed', true).advance(3000).operate(2, 'closed', false);
    const start = host.record(3)['filamentTempK'] as number;
    // An independent explicit-Euler integration of C dT/dt = −k (T⁴ − T_a⁴) − G (T − T_a) at the 1 ms tick.
    const ambient = LAMP_AMBIENT_K.value;
    const span4 = 2700 ** 4 - ambient ** 4;
    const cooled = (f: number, ms: number): number => {
      const k = ((1 - f) * 60) / span4;
      const g = (f * 60) / (2700 - ambient);
      const c = (4 * k * 2700 ** 3 + g) * 0.03;
      let t = start;
      for (let i = 0; i < ms; i++) t -= (0.001 * (k * (t ** 4 - ambient ** 4) + g * (t - ambient))) / c;
      return t;
    };
    host.advance(2000);
    const now = host.record(3)['filamentTempK'] as number;
    expect(rel(now, cooled(0.05, 2000))).toBeLessThan(0.005);
    // With the default fraction it would be well over 10 % cooler by now.
    expect(cooled(0.1, 2000) / now).toBeLessThan(0.9);
  });

  it('the heater draws 120 / 9.7 = 12.371 A, and with the lamp the parallel pair the source divides', () => {
    const alone = across(HEATER_REF).advance(100);
    expect(rel(alone.record(2)['currentA'] as number, 12.37113)).toBeLessThan(0.005);
    expect(rel(alone.record(2)['powerW'] as number, 1469.23)).toBeLessThan(0.005);
    const both = across(HEATER_REF, LAMP_REF).advance(3000);
    const lampOhm = both.record(3)['resistanceOhm'] as number;
    // At 98.9 % of its rated volts the filament settles a little cooler: within 1 % of 240 Ω.
    expect(rel(lampOhm, 240)).toBeLessThan(0.01);
    const parallel = 1 / (1 / 9.6 + 1 / lampOhm);
    const total = (both.record(2)['currentA'] as number) + (both.record(3)['currentA'] as number);
    expect(rel(total, 120 / (AC_SOURCE_OHMS + parallel))).toBeLessThan(0.005);
    expect(total).toBeGreaterThan(12.8);
    expect(total).toBeLessThan(12.9);
  });
});
