import { WIRING_TEST_CATALOG } from '@controls/world-model/testing';
import {
  BREAKER_15A,
  DIN_PSU_24V,
  free,
  RESISTOR_10R,
  TEST_LEAD,
  THHN_14_SOLID,
  wireArgs,
  wiredBus,
} from '../../testing/wired';
import { run } from '../../testing/bench';
import { solveDc } from '../mna/dc';
import { dcBranchValues, type DcBranchValues } from '../mna/values';
import { compileNetlist } from './compile';
import { topologyBytes } from './hash';
import { CONNECTION_NETLIST_MODELS } from './models';
import { createHash } from 'node:crypto';

/*
 * F3.1's conductor netlist model (ADR 0018 §1): one resistor branch per landed conductor, its static
 * value R_cond at T₀ plus both ends' as-made contact resistance (ideal until F3.3 part 1).
 */

/**
 * The 30 m golden's circuit (plan phase acceptance, the unit half): the 24 V DIN supply (1), the 15 A
 * breaker (2, on) and the 10 Ω resistor (3). One 30 m 14 AWG solid copper THHN conductor runs from the
 * supply's + screw to the breaker's line screw; test leads close the loop from the breaker's load
 * through the resistor to the supply's −.
 */
function thirtyMetreCircuit() {
  const bus = wiredBus();
  run(bus, 'entity.place', { ref: DIN_PSU_24V, positionMm: { x: 0, y: 0, z: 0 } });
  run(bus, 'entity.place', { ref: BREAKER_15A, positionMm: { x: 2000, y: 0, z: 0 } });
  run(bus, 'entity.place', { ref: RESISTOR_10R, positionMm: { x: 4000, y: 0, z: 0 } });
  run(bus, 'device.operate', { id: 2, control: 'on', value: true });
  run(
    bus,
    'wire.add',
    wireArgs(THHN_14_SOLID, [1, 'pos'], [2, 'line'], [free(0, 1000, 500), free(2000, 1000, 500)], 30_000),
  );
  run(bus, 'lead.connect', { ref: TEST_LEAD, a: { entity: 2, terminal: 'load' }, b: { entity: 3, terminal: 'a' } });
  run(bus, 'lead.connect', { ref: TEST_LEAD, a: { entity: 3, terminal: 'b' }, b: { entity: 1, terminal: 'neg' } });
  return bus.state;
}

/** The DIN supply as an ideal 24 V source (its regulator model is the engine's, not this spec's). */
const idealSupply = (branch: { model: string; index: number }, values: DcBranchValues) => {
  if (branch.model !== 'supply.dinPsu') return false;
  values.vsource(branch.index, 24, 0);
  return true;
};

describe('the conductor netlist model (F3.1)', () => {
  it('is one resistor: R_cond at T₀ over the cut length plus two ideal contacts (until F3.3 part 1)', () => {
    const device = WIRING_TEST_CATALOG.device(THHN_14_SOLID);
    if (!device) throw new Error('missing entry');
    const element = CONNECTION_NETLIST_MODELS['conductor'].element({
      params: device.model.params,
      device,
      catalog: WIRING_TEST_CATALOG,
      lengthMm: 30_000,
    });
    // R = 1.7241379e-8 Ω·m × 30 m / 2.08091e-6 m² = 0.2485650 Ω (catalog's conductor.spec.ts).
    expect(element.kind).toBe('resistor');
    expect(element.values['conductorOhm']).toBeCloseTo(0.248565, 6);
    expect(element.values['endAContactOhm']).toBe(0);
    expect(element.values['endBContactOhm']).toBe(0);
    expect(element.values['resistanceOhm']).toBe(element.values['conductorOhm']);
  });

  it('refuses an entry without conductor data or a connection without a cut length (a programming error)', () => {
    const lead = WIRING_TEST_CATALOG.device(TEST_LEAD);
    const wire = WIRING_TEST_CATALOG.device(THHN_14_SOLID);
    if (!lead || !wire) throw new Error('missing entry');
    const model = CONNECTION_NETLIST_MODELS['conductor'];
    expect(() =>
      model.element({ params: lead.model.params, device: lead, catalog: WIRING_TEST_CATALOG, lengthMm: 1000 }),
    ).toThrow(/needs conductor data/);
    expect(() =>
      model.element({ params: wire.model.params, device: wire, catalog: WIRING_TEST_CATALOG, lengthMm: null }),
    ).toThrow(/a cut length/);
  });

  it('30 m of 14 AWG at 20 °C: R = 0.248565 Ω, and the solved drop equals I × R within 0.5 % (plan acceptance, unit)', () => {
    // Hand calculation: A = π/4 · (0.127 mm · 92^(22/39))² = 2.08091 mm²; R = ρ₀ L / A
    //   = 1.7241379e-8 Ω·m × 30 m / 2.08091e-6 m² = 0.248565 Ω.
    // Loop: 24 V into R + the breaker's closed pole (10 mΩ) + 2 leads (40.948 mΩ each: 20.948 mΩ of
    // 18 AWG plus 2 × 10 mΩ of clip) + 10 Ω = 10.340461 Ω: I = 24 / 10.340461 = 2.320979 A, and the
    // drop is I × R = 2.320979 × 0.248565 = 0.576914 V.
    const world = thirtyMetreCircuit();
    const netlist = compileNetlist(world, WIRING_TEST_CATALOG);
    const wire = netlist.branches.find((b) => b.model === 'conductor');
    if (!wire) throw new Error('no conductor branch');
    expect(wire.element).toStrictEqual({ kind: 'connection', connection: 1 });
    expect(wire.values['resistanceOhm']).toBeCloseTo(0.248565, 6);
    const solution = solveDc(netlist, dcBranchValues(netlist, idealSupply));
    const current = Math.abs(solution.branches[2 * wire.index]);
    const drop = Math.abs(solution.nodes[2 * wire.a] - solution.nodes[2 * wire.b]);
    expect(Math.abs(drop / (current * 0.248565) - 1)).toBeLessThan(0.005);
    // And the loop by hand (the resistor, the breaker and the leads at their catalogue values).
    const others = netlist.branches.filter((b) => b.index !== wire.index && b.kind === 'resistor');
    const total = 0.248565 + others.reduce((sum, b) => sum + b.values['resistanceOhm'], 0);
    expect(Math.abs(current / (24 / total) - 1)).toBeLessThan(0.005);
    expect(current).toBeCloseTo(2.320979, 5);
    expect(drop).toBeCloseTo(0.576914, 5);
  });

  it('a conductor with a free end is not netlisted (unlanded)', () => {
    const bus = wiredBus();
    run(bus, 'entity.place', { ref: DIN_PSU_24V, positionMm: { x: 0, y: 0, z: 0 } });
    run(bus, 'wire.add', { ...wireArgs(THHN_14_SOLID, [1, 'pos'], [1, 'neg'], [free(0, 1000, 500)], 3000), b: null });
    const netlist = compileNetlist(bus.state, WIRING_TEST_CATALOG);
    expect(netlist.branches.some((b) => b.model === 'conductor')).toBe(false);
    expect(netlist.diagnostics).toContainEqual({ code: 'absent-connection', connection: 1, reason: 'unlanded' });
  });

  it('its branch is encoded under the model name `conductor`; the hash is Node crypto’s SHA-256 of the bytes', () => {
    const netlist = compileNetlist(thirtyMetreCircuit(), WIRING_TEST_CATALOG);
    const bytes = topologyBytes(netlist.nodes, netlist.branches);
    const text = Buffer.from(bytes).toString('latin1');
    expect(text).toContain('\u0009conductor');
    expect(netlist.topologyHash).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('a longer cut moves the value, never the topology hash', () => {
    const build = (lengthMm: number) => {
      const bus = wiredBus();
      run(bus, 'entity.place', { ref: DIN_PSU_24V, positionMm: { x: 0, y: 0, z: 0 } });
      run(bus, 'entity.place', { ref: BREAKER_15A, positionMm: { x: 2000, y: 0, z: 0 } });
      run(
        bus,
        'wire.add',
        wireArgs(THHN_14_SOLID, [1, 'pos'], [2, 'line'], [free(0, 1000, 500), free(2000, 1000, 500)], lengthMm),
      );
      return compileNetlist(bus.state, WIRING_TEST_CATALOG);
    };
    const short = build(5000);
    const long = build(10_000);
    const value = (n: typeof short) =>
      n.branches.find((b) => b.model === 'conductor')?.values['resistanceOhm'] as number;
    expect(value(long)).toBe(2 * value(short));
    expect(long.topologyHash).toBe(short.topologyHash);
  });
});
