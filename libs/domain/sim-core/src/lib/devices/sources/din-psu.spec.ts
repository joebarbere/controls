import { BUILTIN_CATALOG, type DinPsuParams } from '@controls/catalog';
import { deviceOutputSchemaProblems } from '@controls/sim-protocol';
import { RESISTOR_12, RHEOSTAT } from '../../../testing/engine';
import { DIN_PSU, SourceHost } from '../../../testing/sources';
import { DIN_PSU_OUTPUT } from './din-psu';

/*
 * The DIN-rail PSU (plan F2.4): 24 V behind 48 mΩ, a 6 A current limit, and hiccup mode: 100 ticks in
 * limit switch the output off for 1000 ticks, then it retries. Each circuit is the PSU (1) and a load
 * through 1 m test leads (R_L = 0.040948155 Ω each).
 */

const params = BUILTIN_CATALOG.device(DIN_PSU)?.model.params as DinPsuParams;
const R_LEAD = 0.040948155;
const D = 100;
const F = 1000;

/** The PSU shorted by one lead from `pos` to `neg`, at tick `at`. */
function shorted(at = 0): SourceHost {
  const host = new SourceHost();
  host.place(DIN_PSU);
  host.advanceTo(at);
  return host.lead(1, 'pos', 1, 'neg');
}

const hiccups = (host: SourceHost) =>
  host.events.filter((e) => e.kind === 'hiccup').map((e) => [e.tick, e.detail['phase']] as const);

describe('the DIN PSU (golden)', () => {
  it('has the catalogue values: 24 V, 5 A rated, a 6 A limit, 48 mΩ, a 100 ms + 1 s hiccup', () => {
    expect(params).toStrictEqual({
      ratedVoltageV: 24,
      ratedCurrentA: 5,
      currentLimitA: 6,
      outputResistanceOhm: 0.048,
      hiccupDetectMs: D,
      hiccupOffMs: F,
    });
    expect(deviceOutputSchemaProblems(DIN_PSU_OUTPUT)).toStrictEqual([]);
  });

  it('regulates 24 V behind its output resistance under its rating: 12 Ω draws about 1.98 A', () => {
    // I = 24 / (0.048 + 12 + 0.08189631) = 24 / 12.12989631 = 1.978582 A; V = 24 − 0.048 I = 23.905028 V.
    const host = new SourceHost();
    host.place(DIN_PSU);
    host.place(RESISTOR_12);
    host.lead(1, 'pos', 2, 'a').lead(2, 'b', 1, 'neg');
    const I = 24 / (0.048 + 12 + 2 * R_LEAD);
    expect(I).toBeCloseTo(1.978582, 6);
    expect(host.amps(1)).toBeCloseTo(I, 9);
    expect(host.volts(1, 'pos', 1, 'neg')).toBeCloseTo(24 - 0.048 * I, 9);
    expect(host.record(1)).toMatchObject({ mode: 'ok', status: 'solved' });
    host.advance(5000);
    expect(hiccups(host)).toStrictEqual([]);
  });

  it('a short hiccups tick-exactly: off at T0 + 100, retry at T0 + 1100, a period of 1100 ticks', () => {
    // The short is one lead (0.040948155 Ω): CV would draw 24 / 0.0889 ≈ 270 A, so the limit holds
    // 6 A at 6 × 0.040948 = 0.2457 V.
    const T0 = 37; // off the solve cadence, so nothing waits for a multiple of 10
    const host = shorted(T0);
    expect(host.record(1)).toMatchObject({ mode: 'limit', outputA: 6, status: 'solved' });
    expect(host.volts(1, 'pos', 1, 'neg')).toBeCloseTo(6 * R_LEAD, 7); // R_LEAD to 9 digits
    host.advanceTo(T0 + D - 1);
    expect(host.record(1)['mode']).toBe('limit');
    host.advanceTo(T0 + D);
    // Off at exactly T0 + D: the protection layer's re-solve within step T0 + D − 1.
    expect(host.record(1)).toMatchObject({ mode: 'hiccupOff', outputA: 0, outputV: 0 });
    expect(host.engine.lastSolveTick).toBe(T0 + D);
    host.advanceTo(T0 + 3 * (D + F) + 1);
    const events = hiccups(host);
    expect(events).toStrictEqual([
      [T0 + D, 'off'],
      [T0 + D + F, 'retry'],
      [T0 + 2 * D + F, 'off'],
      [T0 + 2 * (D + F), 'retry'],
      [T0 + 3 * D + 2 * F, 'off'],
      [T0 + 3 * (D + F), 'retry'],
    ]);
    // The documented period, D + F = 1100 ticks, within ±1 tick (here exactly).
    const offs = events.filter(([, phase]) => phase === 'off').map(([tick]) => tick);
    for (let k = 1; k < offs.length; k++) expect(Math.abs(offs[k] - offs[k - 1] - (D + F))).toBeLessThanOrEqual(1);
    expect(host.record(1)['mode']).toBe('limit'); // retried into the short again
  });

  it('an overload that clears before 100 ticks resets the count; the next starts from zero', () => {
    const host = new SourceHost();
    host.place(DIN_PSU);
    host.place(RHEOSTAT);
    host.lead(1, 'pos', 2, 'a').lead(2, 'b', 1, 'neg');
    host.operate(2, 'ohms', 2); // 24 / 2.13 ≈ 11 A: in limit
    expect(host.record(1)['mode']).toBe('limit');
    host.advance(D - 10);
    host.operate(2, 'ohms', 12); // cleared
    expect(host.record(1)['mode']).toBe('ok');
    host.advance(5);
    const start = host.engine.tick;
    host.operate(2, 'ohms', 2);
    host.advance(D - 1);
    expect(hiccups(host)).toStrictEqual([]);
    host.advance(1);
    expect(hiccups(host)).toStrictEqual([[start + D, 'off']]);
  });

  it('a save mid-hiccup resumes the same period: its mode and phase are in the sim bag', () => {
    const host = shorted();
    host.advanceTo(D + 400); // 400 ticks into the off period
    expect(host.sim(1)).toStrictEqual({ mode: 'hiccupOff', phaseTicks: 400 });
    expect(host.materialised().entities[0].sim).toStrictEqual({ mode: 'hiccupOff', phaseTicks: 400 });
  });

  it('a moderate overload holds the limit and then hiccups too (6 A into 3 Ω)', () => {
    const host = new SourceHost();
    host.place(DIN_PSU);
    host.place(RHEOSTAT);
    host.lead(1, 'pos', 2, 'a').lead(2, 'b', 1, 'neg');
    host.operate(2, 'ohms', 3);
    // 24 / (0.048 + 3.0819) ≈ 7.67 A > 6 A: limit at 6 A, V = 6 × 3.0819 = 18.49 V.
    expect(host.record(1)).toMatchObject({ mode: 'limit', outputA: 6 });
    expect(host.volts(1, 'pos', 1, 'neg')).toBeCloseTo(6 * (3 + 2 * R_LEAD), 7);
    host.advance(D);
    expect(hiccups(host)).toStrictEqual([[D, 'off']]);
  });
});
