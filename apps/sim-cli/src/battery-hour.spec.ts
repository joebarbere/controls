import { BUILTIN_CATALOG, type BatteryParams } from '@controls/catalog';
import { batteryEmfV } from '@controls/sim-core';
import { BATTERY, RESISTOR_2_4, SourceHost } from '@controls/sim-core/testing';

/*
 * The battery's state-of-charge golden over one hour of sim time (plan F2.4), headless: the engine
 * advances 3 600 000 ticks with the battery discharging into a fixed 2.4 Ω load. It lives here rather
 * than in sim-core's specs because sim-core always runs under coverage instrumentation, which makes an
 * hour of sim time about six times slower (4 s against 0.65 s); the engine is the same code.
 *
 * Hand calculation. The catalogue battery: E(s) = E₀ + k s with E₀ = 11.8 V and k = 1.1 V, r = 0.023 Ω,
 * Q = 7 A·h = 25 200 C. The loop: r + 2.4 Ω + two 1 m leads (2 × 0.040948155 Ω), R_t = 2.50489631 Ω.
 * Coulomb counting is the linear ODE ds/dt = −(E₀ + k s) / (Q R_t), so with τ = Q R_t / k = 57 384.9 s,
 *
 *   s(t) = (s₀ + E₀/k) e^(−t/τ) − E₀/k,
 *
 * and from s₀ = 1 after t = 3600 s: (1 + 10.727273) × e^(−0.0627343) − 10.727273 = 0.286900. The
 * engine holds each solve's current for its 10 ms cadence, a lag of about 5 ms against τ: about 1e-7
 * of the drop, far inside 0.5 %.
 */

const params = BUILTIN_CATALOG.device(BATTERY)?.model.params as BatteryParams;

describe('the battery over one hour of sim time (F2.4 golden)', () => {
  it('its state of charge falls by ∫I dt ÷ capacity within 0.5 %, and follows the closed form', () => {
    const host = new SourceHost();
    host.place(BATTERY);
    host.place(RESISTOR_2_4);
    host.lead(1, 'pos', 2, 'a').lead(2, 'b', 1, 'neg');
    const Q = params.capacityAh * 3600;
    let charge = 0; // ∫I dt (C): each cadence solve's current, held for its 10 ticks
    for (let t = 0; t < 3_600_000; t += 10) {
      host.engine.advanceTo(t + 1); // step t solved first (the cadence), then integrated
      charge += (host.volts(2, 'a', 2, 'b') / 2.4) * 0.01;
      host.engine.advanceTo(t + 10);
    }
    const soc = host.sim(1)['stateOfCharge'] as number;
    const drop = 1 - soc;
    expect(Math.abs(drop - charge / Q)).toBeLessThan(0.005 * drop);
    expect(Math.abs(drop - charge / Q)).toBeLessThan(1e-9 * drop); // in fact to rounding (the load's current is the cell's, gmin aside)

    const Rt = 0.023 + 2.4 + 2 * 0.040948155;
    const tau = (Q * Rt) / (params.openCircuitVoltageFullV - params.openCircuitVoltageEmptyV);
    expect(tau).toBeCloseTo(57384.9, 1);
    const offset = params.openCircuitVoltageEmptyV / 1.1;
    const closed = (1 + offset) * Math.exp(-3600 / tau) - offset;
    expect(closed).toBeCloseTo(0.2869, 5);
    expect(Math.abs(soc - closed)).toBeLessThan(0.005 * (1 - closed));
    expect(host.record(1)['emfV']).toBe(batteryEmfV(params, soc));
    expect(host.engine.tick).toBe(3_600_000);
  });
});
