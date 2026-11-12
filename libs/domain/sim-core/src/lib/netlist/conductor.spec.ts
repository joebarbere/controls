import { autoTermination } from '@controls/world-model';
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
import { compileNetlist, NetlistCompiler } from './compile';
import { topologyBytes } from './hash';
import { CLIP_END, CONNECTION_NETLIST_MODELS } from './models';
import { createHash } from 'node:crypto';

/*
 * F3.1's conductor netlist model (ADR 0018 §1): one resistor branch per landed conductor, its static
 * value R_cond at T₀ plus both ends' as-made contact resistance (F3.3 part 1, ADR 0018 §4): the
 * stored termination, the terminal's method spec and the landed count on that terminal.
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

/** A supply (1) and the breaker (2) with one 5 m conductor from the supply's + to the breaker's line screw. */
function supplyToBreaker() {
  const bus = wiredBus();
  run(bus, 'entity.place', { ref: DIN_PSU_24V, positionMm: { x: 0, y: 0, z: 0 } });
  run(bus, 'entity.place', { ref: BREAKER_15A, positionMm: { x: 2000, y: 0, z: 0 } });
  run(bus, 'wire.add', wireArgs(THHN_14_SOLID, [1, 'pos'], [2, 'line'], ROUTE, 5000));
  return bus;
}
const ROUTE = [free(0, 1000, 500), free(2000, 1000, 500)];
const HALF_SEATED_OHM = 0.424264068711928e-3; // 0.3 mΩ / √0.5
const relative = (a: number, b: number) => Math.abs(a / b - 1);

describe('the conductor netlist model (F3.1, F3.3 part 1)', () => {
  it("is one resistor: R_cond at T₀ over the cut length plus each end's as-made contact (ADR 0018 §4)", () => {
    const device = WIRING_TEST_CATALOG.device(THHN_14_SOLID);
    const screw = WIRING_TEST_CATALOG.device(BREAKER_15A)?.terminals[0].methods[0];
    if (!device || !screw) throw new Error('missing entry');
    const element = CONNECTION_NETLIST_MODELS['conductor'].element({
      params: device.model.params,
      device,
      catalog: WIRING_TEST_CATALOG,
      lengthMm: 30_000,
      ends: {
        a: { termination: autoTermination(1, screw), spec: screw, landedCount: 1 },
        // 20 % of the marked 4 N·m: 0.3/√0.4 + 100 × 0.5² mΩ = 25.4743 mΩ (ADR 0018 §12 golden 2).
        b: { termination: { ...autoTermination(2, screw), auto: false, torqueNm: 0.8 }, spec: screw, landedCount: 1 },
      },
    });
    // R = 1.7241379e-8 Ω·m × 30 m / 2.08091e-6 m² = 0.2485650 Ω (catalog's conductor.spec.ts).
    expect(element.kind).toBe('resistor');
    expect(element.values['conductorOhm']).toBeCloseTo(0.248565, 6);
    expect(element.values['endAContactOhm']).toBe(3e-4);
    expect(element.values['endAConstrictionOhm']).toBe(3e-4);
    expect(element.values['endAFilmOhm']).toBe(0);
    expect(element.values['endBConstrictionOhm']).toBeCloseTo(0.474342e-3, 9);
    expect(element.values['endBFilmOhm']).toBeCloseTo(25e-3, 12);
    expect(element.values['endBContactOhm']).toBeCloseTo(25.474342e-3, 9);
    expect(element.values['resistanceOhm']).toBe(
      element.values['conductorOhm'] + element.values['endAContactOhm'] + element.values['endBContactOhm'],
    );
  });

  it('refuses an entry without conductor data, a cut length or a termination (a programming error)', () => {
    const lead = WIRING_TEST_CATALOG.device(TEST_LEAD);
    const wire = WIRING_TEST_CATALOG.device(THHN_14_SOLID);
    if (!lead || !wire) throw new Error('missing entry');
    const model = CONNECTION_NETLIST_MODELS['conductor'];
    const ends = { a: CLIP_END, b: CLIP_END };
    const catalog = WIRING_TEST_CATALOG;
    expect(() => model.element({ params: lead.model.params, device: lead, catalog, lengthMm: 1000, ends })).toThrow(
      /needs conductor data/,
    );
    expect(() => model.element({ params: wire.model.params, device: wire, catalog, lengthMm: null, ends })).toThrow(
      /a cut length/,
    );
    expect(() => model.element({ params: wire.model.params, device: wire, catalog, lengthMm: 1000, ends })).toThrow(
      /a landed end without a termination/,
    );
  });

  it('30 m of 14 AWG at 20 °C plus two 0.3 mΩ ends: the solved drop equals I × R within 0.5 % (plan acceptance, unit)', () => {
    // Hand calculation: A = π/4 · (0.127 mm · 92^(22/39))² = 2.08091 mm²; R = ρ₀ L / A
    //   = 1.7241379e-8 Ω·m × 30 m / 2.08091e-6 m² = 0.248565 Ω. Both ends land 'auto' (ideal): the
    //   supply's box clamp and the breaker's pressure plate at their marked torque, R₀ = 0.3 mΩ each
    //   (ADR 0018 §12 golden 1), so the branch is 0.248565 + 0.0006 = 0.249165 Ω.
    // Loop: 24 V into the branch + the breaker's closed pole (10 mΩ) + 2 leads (40.948 mΩ each: 20.948 mΩ
    // of 18 AWG plus 2 × 10 mΩ of clip) + 10 Ω = 10.341061 Ω: I = 24 / 10.341061 = 2.320845 A; the drop
    // across the branch is I × 0.249165 = 0.578273 V, of which the conductor's own is I × 0.248565
    // = 0.576881 V (contacts excluded).
    const world = thirtyMetreCircuit();
    const netlist = compileNetlist(world, WIRING_TEST_CATALOG);
    const wire = netlist.branches.find((b) => b.model === 'conductor');
    if (!wire) throw new Error('no conductor branch');
    expect(wire.element).toStrictEqual({ kind: 'connection', connection: 1 });
    expect(wire.values['endAContactOhm']).toBe(3e-4);
    expect(wire.values['endBContactOhm']).toBe(3e-4);
    expect(wire.values['resistanceOhm']).toBeCloseTo(0.249165, 6);
    const solution = solveDc(netlist, dcBranchValues(netlist, idealSupply));
    const current = Math.abs(solution.branches[2 * wire.index]);
    const drop = Math.abs(solution.nodes[2 * wire.a] - solution.nodes[2 * wire.b]);
    expect(relative(drop, current * 0.249165)).toBeLessThan(0.005);
    // And the loop by hand (the resistor, the breaker and the leads at their catalogue values).
    const others = netlist.branches.filter((b) => b.index !== wire.index && b.kind === 'resistor');
    const total = 0.249165 + others.reduce((sum, b) => sum + b.values['resistanceOhm'], 0);
    expect(relative(current, 24 / total)).toBeLessThan(0.005);
    expect(current).toBeCloseTo(2.320845, 5);
    expect(drop).toBeCloseTo(0.578273, 5);
    expect(current * wire.values['conductorOhm']).toBeCloseTo(0.576881, 5);
  });

  it('two conductors under a one-conductor screw: each end on it is 0.3/√0.5 = 0.4243 mΩ (ADR 0018 §12 golden 6)', () => {
    // Two 'auto' conductors land on the breaker's line screw (rated 1, max 2): n = 2 > rated, so
    // r_eff = 1/2 ≥ r_seat and each end there is 0.3/√0.5 mΩ; the supply ends stay R₀.
    const bus = supplyToBreaker();
    const single = compileNetlist(bus.state, WIRING_TEST_CATALOG);
    const compiler = new NetlistCompiler(WIRING_TEST_CATALOG);
    expect(compiler.compile(bus.state)).toStrictEqual(single);
    run(bus, 'wire.add', wireArgs(THHN_14_SOLID, [1, 'neg'], [2, 'line'], ROUTE, 5000));
    const doubled = compileNetlist(bus.state, WIRING_TEST_CATALOG);
    const wires = doubled.branches.filter((b) => b.model === 'conductor');
    expect(wires).toHaveLength(2);
    for (const w of wires) {
      expect(w.values['endAContactOhm']).toBe(3e-4);
      expect(relative(w.values['endBContactOhm'], HALF_SEATED_OHM)).toBeLessThan(1e-12);
    }
    // The first conductor's value moved although its own connection didn't (a landed-count change):
    // the incremental compiler agrees with a fresh compile both ways.
    expect(compiler.compile(bus.state)).toStrictEqual(doubled);
    run(bus, 'edit.undo', {});
    expect(compiler.compile(bus.state)).toStrictEqual(single);
    expect(single.branches.find((b) => b.model === 'conductor')?.values['endBContactOhm']).toBe(3e-4);
  });

  it('counts a conductor end landed by a connection with a free end too, and never a lead clip', () => {
    const bus = supplyToBreaker();
    const value = () =>
      compileNetlist(bus.state, WIRING_TEST_CATALOG).branches.find((b) => b.model === 'conductor')?.values[
        'endBContactOhm'
      ] as number;
    // A lead clipped on the same screw doesn't count.
    run(bus, 'lead.connect', { ref: TEST_LEAD, a: { entity: 2, terminal: 'line' }, b: { entity: 1, terminal: 'neg' } });
    expect(value()).toBe(3e-4);
    // A second conductor on the screw with its other end free isn't netlisted, but it is in the clamp.
    run(bus, 'wire.add', {
      ...wireArgs(THHN_14_SOLID, [2, 'line'], [1, 'neg'], [free(2000, 1000, 500)], 3000),
      b: null,
    });
    expect(relative(value(), HALF_SEATED_OHM)).toBeLessThan(1e-12);
  });

  it('a wire nut joins its conductors at one node; each end in it is the nut’s R₀ = 0.5 mΩ (ADR 0018 §4.4, golden 9)', () => {
    // Supply + → 5 m → nut → 5 m → breaker line, all 'auto'. Twist-on: r = 1 and n ≤ rated, so each
    // nut end is the method's 0.5 mΩ; the screw ends stay 0.3 mΩ. Series total of the two branches:
    // 2 × 0.0414275 Ω (5 m of 14 AWG: 1.7241379e-8 × 5 / 2.08091e-6) + 0.3 + 0.5 + 0.5 + 0.3 mΩ.
    const bus = wiredBus();
    run(bus, 'entity.place', { ref: DIN_PSU_24V, positionMm: { x: 0, y: 0, z: 0 } });
    run(bus, 'entity.place', { ref: BREAKER_15A, positionMm: { x: 2000, y: 0, z: 0 } });
    run(bus, 'entity.place', {
      ref: { id: 'splice.corvelle-tw-m', version: 1 },
      positionMm: { x: 1000, y: 900, z: 0 },
    });
    run(bus, 'wire.add', wireArgs(THHN_14_SOLID, [1, 'pos'], [3, 'splice'], ROUTE, 5000));
    run(bus, 'wire.add', wireArgs(THHN_14_SOLID, [3, 'splice'], [2, 'line'], ROUTE, 5000));
    const netlist = compileNetlist(bus.state, WIRING_TEST_CATALOG);
    const [first, second] = netlist.branches.filter((b) => b.model === 'conductor');
    expect(first.b).toBe(second.a); // the splice node
    expect(netlist.nodes[first.b].members).toStrictEqual([{ entity: 3, terminal: 'splice' }]);
    expect([first.values['endAContactOhm'], first.values['endBContactOhm']]).toStrictEqual([3e-4, 5e-4]);
    expect([second.values['endAContactOhm'], second.values['endBContactOhm']]).toStrictEqual([5e-4, 3e-4]);
    const series = first.values['resistanceOhm'] + second.values['resistanceOhm'];
    expect(relative(series, 2 * 0.0414275 + 0.0016)).toBeLessThan(0.005);
  });

  it('static values are permutation-invariant: any order of world.connections gives the same netlist', () => {
    const world = thirtyMetreCircuit();
    const reversed = { ...world, connections: [...world.connections].reverse() };
    expect(compileNetlist(reversed, WIRING_TEST_CATALOG)).toStrictEqual(compileNetlist(world, WIRING_TEST_CATALOG));
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
      run(bus, 'wire.add', wireArgs(THHN_14_SOLID, [1, 'pos'], [2, 'line'], ROUTE, lengthMm));
      return compileNetlist(bus.state, WIRING_TEST_CATALOG);
    };
    const short = build(5000);
    const long = build(10_000);
    const value = (n: typeof short) =>
      n.branches.find((b) => b.model === 'conductor')?.values['conductorOhm'] as number;
    expect(value(long)).toBe(2 * value(short));
    expect(long.topologyHash).toBe(short.topologyHash);
  });
});
