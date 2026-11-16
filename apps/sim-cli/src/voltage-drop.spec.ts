import {
  BUILTIN_CATALOG,
  conductanceToAirWPerMK,
  conductorPhysics,
  conductorResistanceOhm,
  conductorThermal,
  type DeviceDefinition,
} from '@controls/catalog';
import { createWorld } from '@controls/save-format';
import { createGame, type Game } from '@controls/scripting-api';

/*
 * P3 phase acceptance, the circuit half of "voltage drop over 30 m of 14 AWG matches a hand calculation"
 * (ADR 0018 §12, thermal golden 5; the unit half is `libs/domain/sim-core/src/lib/netlist/conductor.spec.ts`,
 * one 30 m solid copper 14 AWG conductor at 20 °C, its solved drop = I × R within 0.5 %).
 *
 * The circuit: the split-phase stand-in's L1–N (its sourced impedance included), 30 m of 14/2 NM-B
 * (`cable.sorrelby-nmb-14-2`: 60 m of conductor out and back, its bare EGC idle), and the 120 V 1500 W
 * heater, with four ideal ('auto', Trainee) terminations. Headless only, in an empty world: the cable's
 * two ends are free (no enclosure), each conductor landed straight from the free end's tail.
 *
 * **Hand calculation, first solve (every conductor at the 20 °C ambient, 293.15 K):**
 *
 * - Conductor: 14 AWG, d = 0.127 mm · 92^((36 − 14)/39) = 0.127 · 92^(22/39) = 1.62773 mm,
 *   A = π/4 · d² = 2.08091 mm². Annealed copper ρ₀ = 1/58 µΩ·m = 1.7241379 × 10⁻⁸ Ω·m at 20 °C (IEC 60028,
 *   100 % IACS). R(30 m) = ρ₀ L / A = 1.7241379e-8 × 30 / 2.08091e-6 = 0.248565 Ω, so out and back
 *   2R = 0.497131 Ω (solid: lay factor 1).
 * - Source: 25 kVA, 2 % impedance, X/R 2 on the 240 V winding: |Z| = 0.02 × 240² / 25 000 = 46.08 mΩ,
 *   R = |Z| / √5 = 20.608 mΩ, X = 41.216 mΩ; L1–N takes half: r_s = 10.304 mΩ, x_s = 20.608 mΩ.
 * - Contacts: four 'auto' ends at their method's R₀, 0.3 mΩ each (the stand-in's pressure plates and the
 *   heater's): 1.2 mΩ. Their own heating (a few kelvin at most) moves them by about 1 %, 10⁻⁶ of the loop.
 * - Heater: 120² / 1500 = 9.6 Ω (constant; nichrome's coefficient is taken as 0, `resistive.ts`).
 * - Loop: R = 9.6 + 0.497131 + 0.0012 + 0.010304 = 10.108635 Ω, X = 0.020608 Ω,
 *   |Z| = √(10.108635² + 0.020608²) = 10.108656 Ω; I = 120 / 10.108656 = **11.8710 A**;
 *   the run's drop I × 2R = 11.8710 × 0.497131 = **5.9014 V**, 4.92 % of 120 V. (The plan's 11.8724 A and
 *   5.9021 V leave the four contacts out, −0.012 %.)
 *
 * **Hand calculation, thermal steady state** (ADR 0018 §3.5, "conductor in a circuit"): the two NM-B
 * conductors are thermally independent in free air (D7) and carry the same current, so one scalar
 * fixed point in T_c:
 *
 *   I(T_c) = 120 / |Z(T_c)|, Z(T_c) = r_s + 2 R(T_c) + 1.2 mΩ + 9.6 + j x_s,
 *   T_c = T_a + I(T_c)² R′(T_c) / G′(T_c),
 *
 * with R′(T) = ρ₀ (1 + α (T − T₀)) / A (α = 0.00393 /K) and G′(T) the §3.2 surface model (insulation
 * conduction, then convection 1.32 (ΔT/D)^¼ and radiation εσ(T_s² + T_a²)(T_s + T_a), one fixed-point
 * step for T_s), from the conductor entry's own insulation; iterated in the test to 10⁻¹² K (a
 * spreadsheet's job). It settles near T_c ≈ 303.1 K (a 9.95 K rise), I ≈ 11.850 A and a drop of about
 * 6.12 V (ADR 0018 §12 golden 5; the test computes the exact values).
 *
 * Tolerances: 0.5 % of the current and the drop; 0.5 % of the **rise** for the temperature (§3.5).
 */

const TA = 293.15;
const RUN_MM = 30_000;
const R_S = 0.010304;
const X_S = 0.020608;
const CONTACTS = 4 * 0.0003;
const HEATER = 9.6;

const ref = (id: string) => ({ id, version: 1 });
const relative = (actual: number, expected: number) => Math.abs(actual - expected) / Math.abs(expected);
const free = (x: number, y: number, z: number) => ({
  kind: 'free',
  positionMm: { x, y, z },
  entity: null,
  fixture: null,
  tool: null,
});

/** The supply (1) and the heater (2), joined by 30 m of 14/2 NM-B: black (1) L1 → a, white (2) N → b. */
function thirtyMetreRun(): Game {
  const game = createGame({ world: createWorld({ seed: 0, difficulty: 'trainee' }) });
  game.execOrThrow('entity.place', {
    ref: ref('utility.larkmoor-split-phase-25kva'),
    positionMm: { x: 0, y: 0, z: 0 },
  });
  game.execOrThrow('entity.place', { ref: ref('heater.hearthvale-120v-1500w'), positionMm: { x: 3000, y: 0, z: 0 } });
  // The cable coiled out of the way: free at both ends, cut to 30 m (the route's floor is 3.1 m).
  game.execOrThrow('cable.add', {
    ref: ref('cable.sorrelby-nmb-14-2'),
    a: null,
    b: null,
    route: [free(100, 600, 200), free(3200, 600, 200)],
    lengthMm: RUN_MM,
    tailsMm: { a: 600, b: 800 },
    tool: ref('tool.veltmark-dc-8'),
  });
  for (const end of ['a', 'b'] as const) {
    game.execOrThrow('cable.strip', { id: 1, end, jacketMm: 500, tool: ref('tool.veltmark-ws-nm12') });
  }
  const land = (id: number, end: 'a' | 'b', entity: number, terminal: string) =>
    game.execOrThrow('wire.land', { id, end, at: { entity, terminal, termination: 'auto' } });
  land(1, 'a', 1, 'l1');
  land(1, 'b', 2, 'a');
  land(2, 'a', 1, 'n');
  land(2, 'b', 2, 'b');
  return game;
}

/** The loop current at conductor temperature `tc` (the series loop above, as a phasor magnitude). */
function loopCurrent(rConductor: number): number {
  const r = R_S + 2 * rConductor + CONTACTS + HEATER;
  return 120 / Math.sqrt(r * r + X_S * X_S);
}

describe('30 m of 14/2 NM-B on the stand-in supply: the voltage drop by hand (P3 phase acceptance)', () => {
  const nm = BUILTIN_CATALOG.device(ref('conductor.sorrelby-nm-14-solid')) as DeviceDefinition;
  const physics = conductorPhysics(BUILTIN_CATALOG, nm);
  if (physics === undefined) throw new Error('conductor physics');

  it('the conductor: A = π/4 · (0.127 mm · 92^(22/39))² = 2.08091 mm², R(30 m, 20 °C) = 0.248565 Ω', () => {
    const d = 0.127 * Math.pow(92, 22 / 39);
    const areaMm2 = (Math.PI / 4) * d * d;
    expect(relative(areaMm2, 2.08091)).toBeLessThan(1e-5);
    expect(relative(physics.areaM2 * 1e6, areaMm2)).toBeLessThan(1e-5);
    expect(relative(conductorResistanceOhm(physics, RUN_MM, TA), 0.248565)).toBeLessThan(1e-5);
  });

  it('first solve, conductors at ambient: I = 11.8710 A, drop 5.9014 V (4.92 %) within 0.5 %', () => {
    const game = thirtyMetreRun();
    const black = game.connection(1)?.values ?? {};
    const white = game.connection(2)?.values ?? {};
    expect(black['status']).toBe('solved');
    expect(black['conductorTempK']).toBe(TA);
    expect(relative(black['conductorResistanceOhm'] as number, 0.248565)).toBeLessThan(1e-5);
    const amps = black['currentA'] as number;
    const drop = (black['conductorDropV'] as number) + (white['conductorDropV'] as number);
    // By hand (above): 11.8710 A, 5.9014 V; and the same from the loop with the catalogue's R.
    expect(relative(amps, 11.871)).toBeLessThan(0.005);
    expect(relative(drop, 5.9014)).toBeLessThan(0.005);
    expect(relative(amps, loopCurrent(0.248565))).toBeLessThan(0.005);
    expect(relative(drop, amps * 2 * 0.248565)).toBeLessThan(0.005);
    expect(drop / 120).toBeGreaterThan(0.0485);
    expect(drop / 120).toBeLessThan(0.0495);
    // The heater's own reading: 120 V less the run's and the source's drops.
    const heater = game.device(2)?.values ?? {};
    expect(relative(heater['currentA'] as number, amps)).toBeLessThan(1e-9);
    expect(relative(heater['voltageV'] as number, amps * HEATER)).toBeLessThan(1e-9);
    // The bare EGC carries nothing.
    expect(game.connection(3)?.values['currentA']).toBe(0);
  });

  it('thermal steady state: the conductor temperature and the drop match the closed-form fixed point within 0.5 %', () => {
    const thermal = conductorThermal(physics);
    // The scalar fixed point (ADR 0018 §3.5), by successive substitution: contracts by about 0.04 a step.
    let tc = TA + 10;
    for (let k = 0; k < 200; k++) {
      const amps = loopCurrent(conductorResistanceOhm(physics, RUN_MM, tc));
      const next =
        TA + (amps * amps * conductorResistanceOhm(physics, 1000, tc)) / conductanceToAirWPerMK(thermal, tc, TA);
      if (Math.abs(next - tc) < 1e-12) break;
      tc = next;
    }
    const handAmps = loopCurrent(conductorResistanceOhm(physics, RUN_MM, tc));
    const handDrop = handAmps * 2 * conductorResistanceOhm(physics, RUN_MM, tc);
    // ADR 0018 §12 golden 5's figures: T_c ≈ 303.098 K, I ≈ 11.850 A, drop ≈ 6.121 V.
    expect(tc - TA).toBeGreaterThan(9.5);
    expect(tc - TA).toBeLessThan(10.5);
    expect(relative(handAmps, 11.85)).toBeLessThan(0.001);
    expect(relative(handDrop, 6.121)).toBeLessThan(0.002);
    const game = thirtyMetreRun();
    // τ = C′/G′ is about a minute for 14 AWG in free air; 30 min is 30 τ.
    game.advanceTo(1_800_000);
    const black = game.connection(1)?.values ?? {};
    const white = game.connection(2)?.values ?? {};
    for (const rec of [black, white]) {
      expect(Math.abs((rec['conductorTempK'] as number) - tc) / (tc - TA)).toBeLessThan(0.005);
    }
    const amps = black['currentA'] as number;
    const drop = (black['conductorDropV'] as number) + (white['conductorDropV'] as number);
    expect(relative(amps, handAmps)).toBeLessThan(0.005);
    expect(relative(drop, handDrop)).toBeLessThan(0.005);
    // Warmer copper drops more: about 3.7 % above the first solve's.
    expect(drop).toBeGreaterThan(5.9014 * 1.03);
  });
});
