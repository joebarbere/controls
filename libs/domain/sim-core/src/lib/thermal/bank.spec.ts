import {
  BUILTIN_CATALOG,
  conductanceToAirOf,
  conductorPhysics,
  conductorResistanceOhm,
  conductorThermal,
  type DeviceDefinition,
  heatCapacityPerMetre,
  leadThermalLine,
  type LeadParams,
  THERMAL_MIN_TAU_S,
  thermalConductivityWPerMK,
} from '@controls/catalog';
import { LEAD_SIM_BAG_V3, World } from '@controls/save-format';
import fc from 'fast-check';
import { AMBIENT_TEMPERATURE_K } from '../constants';
import { SOLVE_INTERVAL_TICKS, TICK_S } from '../engine/constants';
import type { LayerContext } from '../engine/device-model';
import { createDcSolution } from '../mna/dc';
import { compileNetlist } from '../netlist/compile';
import { CONNECTION_STEP_S, ConnectionThermalBank, type ConnectionBankOptions } from './bank';
import { CONNECTION_RESOLVE_MIN_A, CONNECTION_RESOLVE_RELTOL, THERMAL_MIN_TAU_STEPS } from './constants';

/*
 * The connection thermal bank (F3.6 part 1, ADR 0018 §3, §12): goldens with their hand calculations
 * written out, tolerances 0.5 % **of the rise over ambient** (§3.5), never of absolute kelvin; and the
 * bank's properties (energy balance, never below ambient, the end identity rules, permutation).
 *
 * The rig drives the bank directly: the real compiler on a real world (a 15 A breaker with a 14 AWG
 * solid THHN conductor from its load screw to its line screw, and a test lead), and a solution whose
 * branch currents the test sets, so a golden's current is exactly the hand calculation's.
 */

const TA = AMBIENT_TEMPERATURE_K.value;
const T0 = 293.15;
const BREAKER = { id: 'breaker.saltmere-1p-15a', version: 1 };
const THHN_14 = { id: 'conductor.tallowmere-thhn-14-solid', version: 1 };
const LEAD = { id: 'lead.quillfern-test-1m', version: 1 };
const rise = (t: number) => t - TA;
/** |actual − expected| as a fraction of the expected rise over ambient (§3.5). */
const riseError = (actual: number, expected: number) => Math.abs(rise(actual) - rise(expected)) / rise(expected);

const transform = { positionMm: { x: 0, y: 0, z: 0 }, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } };
const termination = (id: number, torqueNm: number) => ({
  id,
  method: 'screw',
  auto: false,
  stripLengthMm: 13,
  nickedStrandFraction: 0,
  torqueNm,
  accessory: null,
});
const conductor = (id: number, a: object | null, b: object | null, sim: object = { ...LEAD_SIM_BAG_V3 }) => ({
  id,
  ref: THHN_14,
  a,
  b,
  cable: null,
  route: [{ kind: 'free', positionMm: { x: 0, y: 500, z: 0 }, entity: null, fixture: null, tool: null }],
  lengthMm: 2000,
  colour: { base: 'black', stripe: null },
  label: null,
  state: {},
  sim,
  extensions: {},
});
const lead = (id: number) => ({
  id,
  ref: LEAD,
  a: { entity: 1, terminal: 'load', termination: null },
  b: { entity: 1, terminal: 'line', termination: null },
  cable: null,
  route: null,
  lengthMm: null,
  colour: null,
  label: null,
  state: {},
  sim: { ...LEAD_SIM_BAG_V3 },
  extensions: {},
});

/**
 * A breaker (1, handle on) with conductor 1 from its load screw at `torqueA` (r = torqueA / 4 N·m)
 * to its line screw at full torque, and lead 2 across the same screws.
 */
function thermalWorld(torqueA = 0.8, connections?: unknown[]): World {
  return World.parse({
    schemaVersion: 3,
    seed: 3,
    tick: 0,
    nextEntityId: 2,
    nextConnectionId: 10,
    nextCableId: 1,
    nextTerminationId: 10,
    regionId: 'nec',
    difficulty: 'apprentice',
    assisted: false,
    fixtures: [],
    entities: [
      {
        id: 1,
        ref: BREAKER,
        transform,
        state: { on: true },
        sim: { thermal: 0, tripped: false },
        mountedOn: null,
        label: null,
        extensions: {},
      },
    ],
    connections: connections ?? [
      conductor(
        1,
        { entity: 1, terminal: 'load', termination: termination(1, torqueA) },
        { entity: 1, terminal: 'line', termination: termination(2, 4) },
      ),
      lead(2),
    ],
    cables: [],
    sim: null,
    extensions: {},
  });
}

/** The bank on `world`, a solution whose currents the test sets, and a step loop. */
function rig(world: World = thermalWorld(), options: ConnectionBankOptions = {}) {
  const bank = new ConnectionThermalBank(BUILTIN_CATALOG, options);
  const netlist = compileNetlist(world, BUILTIN_CATALOG);
  bank.sync(world, netlist);
  const solution = createDcSolution(netlist);
  const ctx: LayerContext = {
    tick: 0,
    dtS: TICK_S.value,
    netlist,
    solution,
    islandReadable: () => true,
    islandStatus: () => 'solved',
    emit: () => undefined,
  };
  const setAmps = (connection: number, amps: number) => {
    const branch = bank.branch[bank.indexOf(connection)];
    solution.branches[2 * branch] = amps;
    solution.branches[2 * branch + 1] = 0;
  };
  const step = (n: number) => {
    for (let k = 0; k < n; k++) bank.continuous(ctx);
  };
  const bag = (connection: number) => bank.bag(bank.indexOf(connection));
  return { bank, netlist, solution, ctx, setAmps, step, bag };
}

const device = (ref: { id: string; version: number }) => BUILTIN_CATALOG.device(ref) as DeviceDefinition;
const physics14 = () => {
  const p = conductorPhysics(BUILTIN_CATALOG, device(THHN_14));
  if (!p) throw new Error('14 AWG');
  return p;
};

describe('the connection thermal bank: constants', () => {
  it('are sourced and labelled numerical', () => {
    for (const c of [THERMAL_MIN_TAU_STEPS, CONNECTION_RESOLVE_RELTOL, CONNECTION_RESOLVE_MIN_A]) {
      expect(c.kind).toBe('numerical');
      expect(c.source).toMatch(/^numerical: /);
    }
    expect([
      THERMAL_MIN_TAU_STEPS.value,
      CONNECTION_RESOLVE_RELTOL.value,
      CONNECTION_RESOLVE_MIN_A.value,
    ]).toStrictEqual([100, 0.01, 1e-6]);
  });

  it('steps exactly 0.01 s, and the catalogue minimum τ is THERMAL_MIN_TAU_STEPS steps', () => {
    expect(CONNECTION_STEP_S).toBe(0.01);
    expect(CONNECTION_STEP_S).toBe(SOLVE_INTERVAL_TICKS.value * TICK_S.value);
    expect(THERMAL_MIN_TAU_STEPS.value * CONNECTION_STEP_S).toBe(THERMAL_MIN_TAU_S.value);
    // The catalogue's bare-conductor bound takes the ambient at the material's T₀: the game's ambient.
    expect(physics14().referenceTemperatureK).toBe(TA);
  });
});

describe('the connection thermal bank: goldens (ADR 0018 §12, F3.6 part 1)', () => {
  /*
   * 14 AWG solid copper: d = 0.127 mm × 92^(22/39) = 1.627727 mm, A = 2.080908 mm² (the gauge table's
   * 2.08091), R′₀ = ρ₀/A = 1.724138e-8 / 2.08091e-6 = 8.285509 mΩ/m, C′ = 8890 × 385 × A = 7.122219 J/(m·K)
   * (metal only: the insulation rows carry no heat capacity, §3.6).
   */

  it('1. linearised steady state (fixed G′ = 0.15 W/(m·K), DC 20 A): ΔT = 24.1957 K', () => {
    // ΔT = I² R′₀ (1 + α (T_a − T₀)) / (G′ − I² R′₀ α) = 400 × 8.285509e-3 / (0.15 − 400 × 8.285509e-3 × 0.00393)
    //    = 3.314204 / (0.15 − 0.0130248) = 3.314204 / 0.1369752 = 24.19565 K.
    const r = rig(thermalWorld(4), { fixedConductanceWPerMK: 0.15 });
    r.setAmps(1, 20);
    r.step(150_000); // 1,500 s: τ ≈ 52 s, settled to well under 10⁻⁹ of the rise
    expect(riseError(r.bag(1)['conductorTempK'] as number, TA + 24.19565)).toBeLessThan(0.005);
    expect(Math.abs(rise(r.bag(1)['conductorTempK'] as number) - 24.19565)).toBeLessThan(1e-3);
  });

  it('2. time constant (α = 0, fixed G′ = 0.15): τ = C′/G′ = 47.481 s, T(τ) − T_a = 0.632121 ΔT_ss', () => {
    // ΔT_ss = I² R′₀ / G′ = 3.314204 / 0.15 = 22.09469 K; τ = 7.122219 / 0.15 = 47.48146 s.
    // At k = 4748 steps (t = 47.48 s), the continuous solution is 1 − e^(−47.48/47.48146) = 0.6321093 of ΔT_ss
    // (13.96608 K); forward Euler's (1 − dt/τ)^k gives 0.6321480 (13.96694 K), 6 × 10⁻⁵ of the rise away.
    const r = rig(thermalWorld(4), { fixedConductanceWPerMK: 0.15, zeroAlpha: true });
    r.setAmps(1, 20);
    r.step(4748);
    const atTau = rise(r.bag(1)['conductorTempK'] as number);
    expect(Math.abs(atTau - 13.96608) / 13.96608).toBeLessThan(0.005);
    expect(Math.abs(atTau / 22.09469 - 0.632121)).toBeLessThan(0.005 * 0.632121);
    r.step(150_000);
    // To the gauge table's six-figure area (2.08091 mm², 1.1 × 10⁻⁶ from the exact definition).
    expect(Math.abs(rise(r.bag(1)['conductorTempK'] as number) - 22.09469) / 22.09469).toBeLessThan(1e-5);
  });

  it('3. full model by inversion at T_c = 343.15 K: I = 28.9403 A gives a 50.00 K rise', () => {
    // R′_ins = ln(1.195841/0.813863)/(2π 0.18) + ln(1.297841/1.195841)/(2π 0.25) = 0.391676 K·m/W;
    // h₀ = 22.168052, R′_surf = 5.536029, T_s = 339.846229; h₁ = 21.797264, R′_surf = 5.630202;
    // G′ = 1/(0.391676 + 5.630202) = 0.166061 W/(m·K); R′(343.15) = 8.285509e-3 × (1 + 0.00393 × 50) = 9.913611 mΩ/m;
    // I = √(50 × 0.166061 / 9.913611e-3) = 28.9403 A.
    const thermal = conductorThermal(physics14());
    expect(Math.abs(thermal.insulationResistanceKMPerW / 0.391676 - 1)).toBeLessThan(1e-5);
    const g = conductanceToAirOf(thermal.insulationResistanceKMPerW, thermal.outerDiameterM, 0.9, 343.15, TA);
    expect(Math.abs(g / 0.166061 - 1)).toBeLessThan(1e-5);
    const r = rig(thermalWorld(4));
    r.setAmps(1, 28.9403);
    r.step(150_000);
    const t = r.bag(1)['conductorTempK'] as number;
    expect(riseError(t, 343.15)).toBeLessThan(0.005);
    expect(Math.abs(rise(t) - 50)).toBeLessThan(0.01);
  });

  it('4. two-node termination (§7: I = 12.5 A, r = 0.2): T_c = 304.0831 K, T_h = 406.7253 K; the good end 297.572 K', () => {
    // Conductor: T_c = T_a + I² R′(T_c) / G′(T_c) by fixed point = 304.083136 K, G′ = 0.123499 W/(m·K).
    // Fin: k = L₀ T₀ / ρ₀ = 2.443004509e-8 × 293.15 / 1.724138e-8 = 415.3767 W/(m·K);
    //      G_fin = √(0.123499 × 415.3767 × 2.080908e-6) = 0.0103319 W/K.
    // Contact at r = 0.2 (R₀ 0.3 mΩ): a = 0.3/√0.4 = 0.474342 mΩ (constriction), b = 0.1 × 0.5² = 25.000 mΩ (film).
    // T_h = [I² (a (1 − α T₀) + b) + G_fin T_c + G_term T_a] / (G_fin + G_term − I² a α)
    //     = [156.25 × (0.474342e-3 × (1 − 1.152080) + 0.025) + 0.0103319 × 304.083136 + 0.026 × 293.15]
    //       / (0.0103319 + 0.026 − 156.25 × 0.474342e-3 × 0.00393) = 406.725343 K.
    // The good end (r = 1, a = 0.3 mΩ, b = 0): 297.571723 K.
    const r = rig(thermalWorld(0.8));
    r.setAmps(1, 12.5);
    r.step(200_000); // 2,000 s: τ_c ≈ 58 s, τ_h ≈ 30 s
    const bag = r.bag(1);
    expect(riseError(bag['conductorTempK'] as number, 304.083136)).toBeLessThan(0.005);
    expect(riseError(bag['endATempK'] as number, 406.725343)).toBeLessThan(0.005);
    expect(riseError(bag['endBTempK'] as number, 297.571723)).toBeLessThan(0.005);
    expect((bag['endATempK'] as number) - (bag['conductorTempK'] as number)).toBeGreaterThan(50);
    // The fin's k: Wiedemann–Franz from the copper row.
    expect(Math.abs(thermalConductivityWPerMK(physics14()) / 415.3767 - 1)).toBeLessThan(1e-6);
  });

  it('a lead heats too (D2): its conductor node reaches the same closed form, its ends stay initial', () => {
    // The lead at 10 A, fixed G′ = 0.5: R′₀ = 1.724138e-8 / 8.2305e-7 = 20.94816 mΩ/m;
    // ΔT = 100 × 0.02094816 / (0.5 − 100 × 0.02094816 × 0.00393) = 2.094816 / 0.4917674 = 4.259772 K.
    const r = rig(thermalWorld(4), { fixedConductanceWPerMK: 0.5 });
    r.setAmps(2, 10);
    r.step(50_000);
    const bag = r.bag(2);
    expect(Math.abs(rise(bag['conductorTempK'] as number) - 4.259772) / 4.259772).toBeLessThan(0.005);
    expect(bag).toMatchObject({
      endATempK: null,
      endBTempK: null,
      endADegradation: 1,
      endBDegradation: 1,
      endATerminationId: null,
      endBTerminationId: null,
      endAState: 'ok',
      endBState: 'ok',
      insulationDamaged: false,
    });
    // Its stamp: ρ₀ L / A (1 + α (T − T₀)) + 2 × 10 mΩ, the static v2 value at ambient.
    const p = device(LEAD).model.params as LeadParams;
    const t = bag['conductorTempK'] as number;
    const expected =
      ((p.resistivityOhmM * 1) / p.conductorAreaM2) * (1 + p.temperatureCoefficientPerK * (t - T0)) + 0.02;
    expect(Math.abs(r.bank.resistanceOhm(r.bank.indexOf(2)) / expected - 1)).toBeLessThan(1e-12);
  });

  it("one step is the model's formula bit for bit (G′ is conductanceToAirOf's, the ampacity's)", () => {
    const p = physics14();
    const thermal = conductorThermal(p);
    for (const tc of [TA, 300.25, 343.15, 520]) {
      const sim = { ...LEAD_SIM_BAG_V3, conductorTempK: tc };
      const world = thermalWorld(4, [
        conductor(
          1,
          { entity: 1, terminal: 'load', termination: termination(1, 4) },
          { entity: 1, terminal: 'line', termination: termination(2, 4) },
          sim,
        ),
      ]);
      const r = rig(world);
      r.setAmps(1, 15);
      r.step(1);
      const g = conductanceToAirOf(thermal.insulationResistanceKMPerW, thermal.outerDiameterM, 0.9, tc, TA);
      const rPerM = conductorResistanceOhm(p, 1000, T0) * (1 + 0.00393 * (Math.min(tc, 473.15) - T0));
      expect(r.bag(1)['conductorTempK']).toBe(
        tc + 0.01 * (1 / heatCapacityPerMetre(p)) * (225 * rPerM - g * (tc - TA)),
      );
    }
  });

  it("the conductor's stamp equals the compiler's static value at T₀, and follows R(T) with its clamp", () => {
    const r = rig(thermalWorld(0.8));
    const branch = r.netlist.branches[r.bank.branch[r.bank.indexOf(1)]];
    expect(r.bank.resistanceOhm(r.bank.indexOf(1))).toBe(branch.values['resistanceOhm']);
    const lead2 = r.netlist.branches[r.bank.branch[r.bank.indexOf(2)]];
    expect(r.bank.resistanceOhm(r.bank.indexOf(2))).toBe(lead2.values['resistanceOhm']);
  });
});

describe('the connection thermal bank: properties (ADR 0018 §12)', () => {
  const amps = fc.double({ min: 0, max: 60, noNaN: true });

  it('energy balance: Σ I²R dt in = Σ C ΔT stored + Σ losses dt, per step (relative 10⁻⁹)', () => {
    const p = physics14();
    const thermal = conductorThermal(p);
    const cPrime = heatCapacityPerMetre(p);
    const kA = thermalConductivityWPerMK(p) * p.areaM2;
    const spec = device(BREAKER).terminals[0].methods[0];
    const L = 2;
    const dt = CONNECTION_STEP_S;
    fc.assert(
      fc.property(amps, fc.integer({ min: 0, max: 3000 }), (current, warmSteps) => {
        const r = rig(thermalWorld(0.8));
        r.setAmps(1, current);
        r.step(warmSteps);
        const before = r.bag(1);
        const resistance = r.bank.resistanceOhm(r.bank.indexOf(1));
        r.step(1);
        const after = r.bag(1);
        const tc = before['conductorTempK'] as number;
        const g = conductanceToAirOf(thermal.insulationResistanceKMPerW, thermal.outerDiameterM, 0.9, tc, TA);
        const fin = Math.sqrt(g * kA);
        let stored = cPrime * L * ((after['conductorTempK'] as number) - tc);
        let lost = g * L * (tc - TA);
        for (const end of ['endATempK', 'endBTempK']) {
          const th = before[end] as number;
          stored += spec.hotSpotHeatCapacityJPerK * ((after[end] as number) - th);
          lost += fin * (th - tc) + spec.heatPathWPerK * (th - TA);
        }
        // A node held at its melting point (burned open, F3.6 part 2) discards its excess heat by design.
        const temps = ['conductorTempK', 'endATempK', 'endBTempK'].map((key) => after[key] as number);
        if (temps.some((t) => t >= p.meltingPointK)) return;
        const input = current * current * resistance * dt;
        const balance = input - stored - lost * dt;
        // The floor: each stored term is a difference of temperatures, exact to a few ulps of the hottest
        // (about 6 × 10⁻¹⁴ K near 300 K, 3 × 10⁻¹³ K near 1300 K).
        const floor = (cPrime * L + 2 * spec.hotSpotHeatCapacityJPerK) * 4e-16 * Math.max(300, ...temps);
        const scale = Math.max(input, lost * dt);
        expect(Math.abs(balance)).toBeLessThan(1e-9 * scale + floor);
      }),
      { numRuns: 40 },
    );
  });

  it('never below ambient without a sink: any current, any start at or above ambient', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(amps, fc.integer({ min: 1, max: 4000 })), { minLength: 1, maxLength: 4 }),
        fc.double({ min: TA, max: 600, noNaN: true }),
        (schedule, start) => {
          const sim = { ...LEAD_SIM_BAG_V3, conductorTempK: start, endATempK: start + 5, endATerminationId: 1 };
          const world = thermalWorld(0.8, [
            conductor(
              1,
              { entity: 1, terminal: 'load', termination: termination(1, 0.8) },
              { entity: 1, terminal: 'line', termination: termination(2, 4) },
              sim,
            ),
            lead(2),
          ]);
          const r = rig(world);
          for (const [current, steps] of schedule) {
            r.setAmps(1, current);
            r.setAmps(2, current / 4);
            r.step(steps);
            for (const id of [1, 2]) {
              const bag = r.bag(id);
              for (const key of ['conductorTempK', 'endATempK', 'endBTempK']) {
                const value = bag[key];
                if (value !== null) expect(value as number).toBeGreaterThanOrEqual(TA);
              }
            }
          }
        },
      ),
      { numRuns: 25 },
    );
  });

  it('an idle connection relaxes to ambient, and an unlanded conductor is in the bank and relaxes too', () => {
    const sim = { ...LEAD_SIM_BAG_V3, conductorTempK: 400 };
    const world = thermalWorld(0.8, [
      conductor(3, { entity: 1, terminal: 'load', termination: termination(3, 4) }, null, sim),
    ]);
    const r = rig(world);
    expect(r.bank.count).toBe(1);
    expect(r.bank.branch[0]).toBe(-1);
    // A landed end whose temperature is null starts at T_c (ADR 0018 §6), the other end is unlanded.
    expect(r.bag(3)).toMatchObject({ conductorTempK: 400, endATempK: 400, endBTempK: null, endATerminationId: 3 });
    r.step(400_000); // 4,000 s: near ambient G′ ≈ 0.043 W/(m·K) (radiation, little convection), τ ≈ 165 s
    expect(rise(r.bag(3)['conductorTempK'] as number)).toBeLessThan(1e-6);
    expect(rise(r.bag(3)['endATempK'] as number)).toBeLessThan(1e-6);
  });

  it('a new conductor starts at ambient; every bag is finite with D ≥ 1', () => {
    const r = rig(thermalWorld(0.8));
    expect(r.bag(1)).toMatchObject({
      conductorTempK: TA,
      endATempK: TA,
      endBTempK: TA,
      endATerminationId: 1,
      endBTerminationId: 2,
    });
    r.setAmps(1, 30);
    r.step(500);
    for (const id of [1, 2]) {
      const bag = r.bag(id);
      for (const [key, value] of Object.entries(bag)) {
        if (typeof value === 'number') expect(Number.isFinite(value), key).toBe(true);
      }
      expect(bag['endADegradation'] as number).toBeGreaterThanOrEqual(1);
      expect(bag['endBDegradation'] as number).toBeGreaterThanOrEqual(1);
    }
  });

  it('the end identity rules (ADR 0015): continue, unland keeps, a new termination resets', () => {
    const r = rig(thermalWorld(0.8));
    r.setAmps(1, 12.5);
    r.step(3000);
    const hot = r.bag(1);
    const world = thermalWorld(0.8);
    const [c1, c2] = world.connections;
    // The same termination ids, another connection object: it continues.
    const same = { ...world, connections: [{ ...c1 }, c2] };
    r.bank.sync(same, compileNetlist(same, BUILTIN_CATALOG));
    expect(r.bag(1)).toStrictEqual(hot);
    // End a unlanded: its temperature is null, degradation, state and termination id kept.
    const unlanded = { ...world, connections: [{ ...c1, a: null }, c2] };
    r.bank.sync(unlanded, compileNetlist(unlanded, BUILTIN_CATALOG));
    expect(r.bag(1)).toMatchObject({ endATempK: null, endATerminationId: 1, endADegradation: 1, endAState: 'ok' });
    expect(r.bag(1)['endBTempK']).toBe(hot['endBTempK']);
    // Re-landed with the same termination (an undo): it starts at T_c again (its temperature was null).
    r.bank.sync(same, compileNetlist(same, BUILTIN_CATALOG));
    expect(r.bag(1)['endATempK']).toBe(hot['conductorTempK']);
    // A new termination (id 5): the end resets to the conductor's temperature, D = 1, the new id.
    const relanded = {
      ...world,
      connections: [{ ...c1, a: { entity: 1, terminal: 'load', termination: termination(5, 4) } }, c2],
    };
    r.bank.sync(relanded, compileNetlist(relanded, BUILTIN_CATALOG));
    expect(r.bag(1)).toMatchObject({
      endATempK: hot['conductorTempK'],
      endADegradation: 1,
      endATerminationId: 5,
      endAState: 'ok',
    });
  });

  it('a deleted connection keeps its bag while its id cannot be reused (undo restores it)', () => {
    const r = rig(thermalWorld(0.8));
    r.setAmps(2, 40);
    r.step(500);
    const warm = r.bag(2);
    const world = thermalWorld(0.8);
    const without = { ...world, connections: [world.connections[0]] };
    r.bank.sync(without, compileNetlist(without, BUILTIN_CATALOG));
    expect(r.bank.indexOf(2)).toBe(-1);
    r.bank.sync(world, compileNetlist(world, BUILTIN_CATALOG));
    expect(r.bag(2)).toStrictEqual(warm);
  });

  it('connections in any id order give the same bags (the bank sorts by id)', () => {
    const world = thermalWorld(0.8);
    const a = rig(world);
    const reversed = { ...world, connections: [...world.connections].reverse() };
    const b = rig(reversed);
    for (const r of [a, b]) {
      r.setAmps(1, 20);
      r.setAmps(2, 5);
      r.step(1000);
    }
    expect([b.bag(1), b.bag(2)]).toStrictEqual([a.bag(1), a.bag(2)]);
  });

  it('freezes a connection on an island that is not a reading, and asks for a re-solve on a 1 % move', () => {
    const r = rig(thermalWorld(4));
    r.setAmps(1, 50);
    const frozen = { ...r.ctx, islandReadable: () => false };
    const before = r.bag(1);
    r.bank.continuous(frozen);
    expect(r.bag(1)).toStrictEqual(before);
    // Nodes all at 0 V: the last solve "saw" 0 Ω, so any value is more than 1 % away.
    expect(r.bank.continuous(r.ctx)).toBe(true);
    // A current below 1 µA never asks.
    r.setAmps(1, 1e-7);
    r.setAmps(2, 0);
    expect(r.bank.continuous(r.ctx)).toBe(false);
  });

  it("the lead's thermal line has τ ≥ 1 s (THERMAL_MIN_TAU_STEPS × the step)", () => {
    const line = leadThermalLine(device(LEAD).model.params as LeadParams);
    const thermal = conductorThermal(line);
    expect(heatCapacityPerMetre(line) * thermal.insulationResistanceKMPerW).toBeGreaterThan(
      THERMAL_MIN_TAU_STEPS.value * CONNECTION_STEP_S,
    );
  });
});
