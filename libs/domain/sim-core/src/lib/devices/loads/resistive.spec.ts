import { BUILTIN_CATALOG, type HeaterParams, leadResistanceOhm, type LeadParams } from '@controls/catalog';
import { deviceOutputSchemaProblems } from '@controls/sim-protocol';
import { AC_SOURCE, BATTERY, LEAD } from '../../../testing/bench';
import { BUSBAR, OPAQUE } from '../../../testing/engine';
import { HEATER, RESISTOR_10R } from '../../../testing/loads';
import { BENCH_SUPPLY, SourceHost } from '../../../testing/sources';
import { LEAD_CONDUCTOR_TEMPERATURE_K } from '../../constants';
import { dcBranchValues } from '../../mna/values';
import { acBranchValues } from '../../mna/ac-values';
import { compileNetlist } from '../../netlist/compile';
import { HEATER_OUTPUT, heaterResistanceOhm, RESISTOR_OUTPUT } from './resistive';

/*
 * The resistor and the heater (plan F2.5). Hand calculations:
 *
 * - the 10 Ω 10 W resistor across a full battery through two 1 m leads: I = 12.9 / (10 + 0.023 + 2 R_lead),
 *   P = I² · 10 ≈ 16.5 W > 10 W, so it is over-rated; at 9 V from a bench supply through busbar links,
 *   P = 9² / 10 = 8.1 W (under 1 mΩ of supply), not over-rated;
 * - the 12 V 50 W heater: R = 12² / 50 = 2.88 Ω; at 12 V, 50 W less the supply's 1 mΩ share (0.07 %).
 */

const leadOhm = leadResistanceOhm(
  BUILTIN_CATALOG.device(LEAD)?.model.params as LeadParams,
  LEAD_CONDUCTOR_TEMPERATURE_K.value,
);
const rel = (actual: number, expected: number) => Math.abs(actual / expected - 1);

/** `source` (1) into `load` (2) through two leads of `lead`. */
function loop(source: { id: string; version: number }, load: { id: string; version: number }, lead = LEAD): SourceHost {
  const host = new SourceHost();
  host.place(source);
  host.place(load);
  const [pos, neg] = source === AC_SOURCE ? ['l', 'n'] : ['pos', 'neg'];
  host.exec('lead.connect', { ref: lead, a: { entity: 1, terminal: pos }, b: { entity: 2, terminal: 'a' } });
  host.exec('lead.connect', { ref: lead, a: { entity: 2, terminal: 'b' }, b: { entity: 1, terminal: neg } });
  return host;
}

const onSupply = (volts: number, load: { id: string; version: number }) =>
  loop(BENCH_SUPPLY, load, BUSBAR)
    .operate(1, 'setpointV', volts)
    .operate(1, 'currentLimitA', 5)
    .operate(1, 'outputOn', true);

describe('the resistor (golden)', () => {
  it('publishes a valid record, and is valued from its catalogue entry with no engine hook (DC and AC defaults)', () => {
    expect(deviceOutputSchemaProblems(RESISTOR_OUTPUT)).toStrictEqual([]);
    const host = loop(BATTERY, RESISTOR_10R);
    const netlist = compileNetlist(host.bus.state, BUILTIN_CATALOG);
    const element = netlist.branches.find((b) => b.model === 'resistor');
    expect(element?.values).toStrictEqual({ resistanceOhm: 10 });
    const values = dcBranchValues(netlist);
    expect(values.ohms[element?.index ?? -1]).toBe(10);
    const ac = loop(AC_SOURCE, RESISTOR_10R);
    const acNetlist = compileNetlist(ac.bus.state, ac.options.catalog, { models: ac.options.netlistModels });
    const acElement = acNetlist.branches.find((b) => b.model === 'resistor');
    const hook = (b: (typeof acNetlist.branches)[number], v: Parameters<typeof acBranchValues>[2] & object) => {
      if (b.model !== 'test.acSource') return false;
      v.vsourcePolar(b.index, 120, 0, 0.1);
      return true;
    };
    expect(acBranchValues(acNetlist, hook).ohms[acElement?.index ?? -1]).toBe(10);
  });

  it('across a full battery it dissipates I²R ≈ 16.5 W and says overRated; at 9 V (8.1 W) it does not', () => {
    const hot = loop(BATTERY, RESISTOR_10R).record(2);
    const amps = 12.9 / (10 + 0.023 + 2 * leadOhm);
    expect(rel(hot['currentA'] as number, amps)).toBeLessThan(1e-9);
    expect(rel(hot['powerW'] as number, amps * amps * 10)).toBeLessThan(1e-9);
    expect(rel(hot['voltageV'] as number, amps * 10)).toBeLessThan(1e-9);
    expect(hot).toMatchObject({ overRated: 'yes', status: 'solved' });
    const cool = onSupply(9, RESISTOR_10R).record(2);
    expect(rel(cool['powerW'] as number, 8.1)).toBeLessThan(0.005);
    expect(cool).toMatchObject({ overRated: 'no', status: 'solved' });
  });

  it('keeps its value however long it is over-rated (no damage model in P2)', () => {
    const host = loop(BATTERY, RESISTOR_10R);
    const first = host.record(2)['currentA'] as number;
    host.advance(10_000);
    // Only the battery's discharge moves the current: 10 s at 1.3 A is 0.05 % of 7 Ah.
    expect(rel(host.record(2)['currentA'] as number, first)).toBeLessThan(0.001);
    expect(host.sim(2)).toStrictEqual({});
  });

  it('on an AC island the record holds RMS magnitudes: 120 V over 10 Ω behind 0.1 Ω and two leads', () => {
    const r = loop(AC_SOURCE, RESISTOR_10R).record(2);
    const amps = 120 / (10 + 0.1 + 2 * leadOhm);
    expect(rel(r['currentA'] as number, amps)).toBeLessThan(1e-9);
    expect(rel(r['voltageV'] as number, amps * 10)).toBeLessThan(1e-9);
    expect(r).toMatchObject({ overRated: 'yes', status: 'solved' });
  });

  it('on an unsolved island: status unsolved, nothing solved written (overRated is no reading either)', () => {
    const host = loop(BATTERY, RESISTOR_10R);
    const opaque = host.place(OPAQUE);
    host.lead(opaque, 'a', 2, 'a').lead(opaque, 'b', 2, 'b');
    expect(host.record(2)).toStrictEqual({
      voltageV: 0,
      currentA: 0,
      powerW: 0,
      overRated: 'no',
      status: 'unsolved',
    });
  });
});

describe('the heater (golden)', () => {
  it('is its rated watts at its rated volts: R = V² / P = 2.88 Ω, 50 W at 12 V (within 0.5 %)', () => {
    expect(deviceOutputSchemaProblems(HEATER_OUTPUT)).toStrictEqual([]);
    const params = BUILTIN_CATALOG.device(HEATER)?.model.params as HeaterParams;
    expect(heaterResistanceOhm(params)).toBeCloseTo(2.88, 12);
    const r = onSupply(12, HEATER).record(2);
    expect(rel(r['powerW'] as number, 50)).toBeLessThan(0.005);
    expect(rel(r['currentA'] as number, 12 / 2.88)).toBeLessThan(0.005);
    expect(r['status']).toBe('solved');
    expect(onSupply(6, HEATER).record(2)['powerW']).toBeCloseTo(12.5, 1); // P ∝ V²: a fixed resistance
  });
});
