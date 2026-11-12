import {
  BUILTIN_CATALOG,
  type ConductorPhysics,
  conductorPhysics,
  conductorResistanceOhm,
  type DeviceDefinition,
} from '@controls/catalog';
import fc from 'fast-check';
import {
  BARE_CONDUCTOR_EMISSIVITY,
  H_CONV_COEFF,
  LN_SERIES_TERMS,
  LN_SQRT_STEPS,
  NM_CABLE_AMPACITY_TEMP_K,
  RATING_AMBIENT_K,
  STEFAN_BOLTZMANN,
  SURFACE_ITERATIONS,
} from './constants';
import {
  conductanceToAirWPerMK,
  conductorThermal,
  derivedAmpacityA,
  lnRatio,
  surfaceCoefficientWPerM2K,
} from './conductor-thermal';

/*
 * F3.1's derived ampacity (D6, ADR 0018 §3.2 and §9): free air, a single conductor, 30 °C rating
 * ambient, the insulation's rating, convection plus radiation, one surface iteration. Hand
 * calculations are written out; tolerances are on the rise over ambient (ADR 0018 §3.5) or on the
 * current, never looser than 0.5 %. No NEC table value appears here: the cross-check is against an
 * independent physics recomputation, as ADR 0018 §9 fixes.
 */

const entry = (id: string): DeviceDefinition => {
  const device = BUILTIN_CATALOG.device({ id, version: 1 });
  if (!device) throw new Error(id);
  return device;
};
const physicsOf = (id: string): ConductorPhysics => {
  const physics = conductorPhysics(BUILTIN_CATALOG, entry(id));
  if (!physics) throw new Error(id);
  return physics;
};
const CONDUCTORS = BUILTIN_CATALOG.devices.filter((d) => d.model.kind === 'conductor');
const rel = (actual: number, expected: number) => Math.abs(actual / expected - 1);
const T90 = 363.15;
const T30 = RATING_AMBIENT_K.value;

describe('thermal constants', () => {
  it('are sourced and labelled', () => {
    expect([RATING_AMBIENT_K.value, RATING_AMBIENT_K.kind]).toStrictEqual([303.15, 'real-world']);
    expect([NM_CABLE_AMPACITY_TEMP_K.value, NM_CABLE_AMPACITY_TEMP_K.kind]).toStrictEqual([333.15, 'real-world']);
    expect(NM_CABLE_AMPACITY_TEMP_K.source).toMatch(/334\.80/);
    expect(H_CONV_COEFF.value).toBe(1.32);
    expect(STEFAN_BOLTZMANN.value).toBe(5.670374419e-8);
    expect([BARE_CONDUCTOR_EMISSIVITY.value, BARE_CONDUCTOR_EMISSIVITY.kind]).toStrictEqual([0.5, 'game-design']);
    expect(BARE_CONDUCTOR_EMISSIVITY.source).toMatch(/^game-design: /);
    for (const c of [SURFACE_ITERATIONS, LN_SQRT_STEPS, LN_SERIES_TERMS]) {
      expect(c.kind).toBe('numerical');
      expect(c.source).toMatch(/^numerical: /);
    }
    expect([SURFACE_ITERATIONS.value, LN_SQRT_STEPS.value, LN_SERIES_TERMS.value]).toStrictEqual([1, 4, 6]);
  });
});

describe('lnRatio', () => {
  it('is within 2e-11 of Math.log over 1.0001–8 (property) and exactly 0 at 1', () => {
    expect(lnRatio(1)).toBe(0);
    fc.assert(
      fc.property(fc.double({ min: 1.0001, max: 8, noNaN: true }), (x) => {
        expect(rel(lnRatio(x), Math.log(x))).toBeLessThan(2e-11);
      }),
    );
  });

  it('pins vectors (bit-identical in every engine: only + − × ÷ and Math.sqrt)', () => {
    expect(rel(lnRatio(2), Math.LN2)).toBeLessThan(1e-14);
    expect(rel(lnRatio(8), 3 * Math.LN2)).toBeLessThan(1e-14);
    expect(rel(lnRatio(Math.E), 1)).toBeLessThan(1e-13);
    expect(rel(lnRatio(1.0001), Math.log(1.0001))).toBeLessThan(2e-11);
  });
});

describe('the conductor heat path (ADR 0018 §3.2)', () => {
  // 14 AWG solid copper THHN, 0.381 mm PVC (k 0.18) under 0.102 mm nylon (k 0.25), ε 0.9.
  const thhn14 = conductorThermal(physicsOf('conductor.tallowmere-thhn-14-solid'));

  it('R′_ins and D by hand: two cylinders in series', () => {
    // r₀ = 1.62773 / 2 = 0.813865 mm; r₁ = 1.194865 mm; r₂ = 1.296865 mm (D = 2.59373 mm).
    // ln(r₁/r₀) / (2π · 0.18) = ln(1.468137) / 1.130973 = 0.383994 / 1.130973 = 0.339525
    // ln(r₂/r₁) / (2π · 0.25) = ln(1.085365) / 1.570796 = 0.081917 / 1.570796 = 0.052150
    // R′_ins = 0.391675 K·m/W (ADR 0018 §12 golden 3: 0.391676 from the unrounded diameter).
    expect(rel(thhn14.insulationResistanceKMPerW, 0.391676)).toBeLessThan(1e-5);
    expect(thhn14.outerDiameterM).toBeCloseTo(2.59373e-3, 9);
    expect(thhn14.emissivity).toBe(0.9);
  });

  it('golden 3 (ADR 0018 §12): at T_c = 70 °C in 20 °C air, G′ = 0.166061 W/(m·K) and I = 28.9403 A', () => {
    // h₀ = h(343.15) = 1.32 (50 / 2.59373e-3)^¼ + 0.9 σ (343.15² + 293.15²)(343.15 + 293.15) = 22.168052
    // R′_s = 1 / (h₀ π D) = 5.536029; T_s = 293.15 + 50 × 5.536029 / (0.391676 + 5.536029) = 339.846229
    // h₁ = h(339.846229) = 21.797264, R′_s = 5.630202; G′ = 1 / (0.391676 + 5.630202) = 0.166061
    // R′(343.15) = 8.285500 mΩ/m × (1 + 0.00393 × 50) = 9.913601 mΩ/m; I = √(50 × 0.166061 / 9.913601e-3) = 28.9403 A.
    expect(rel(surfaceCoefficientWPerM2K(thhn14, 343.15, 293.15), 22.168052)).toBeLessThan(1e-5);
    expect(rel(surfaceCoefficientWPerM2K(thhn14, 339.846229, 293.15), 21.797264)).toBeLessThan(1e-5);
    expect(rel(conductanceToAirWPerMK(thhn14, 343.15, 293.15), 0.166061)).toBeLessThan(1e-5);
    expect(rel(derivedAmpacityA(thhn14, { ratingTempK: 343.15, ambientK: 293.15 }), 28.9403)).toBeLessThan(1e-5);
  });

  it('a bare conductor has no insulation resistance, the metal’s diameter and BARE_CONDUCTOR_EMISSIVITY', () => {
    const physics = { ...physicsOf('conductor.tallowmere-thhn-14-solid'), insulation: null };
    const bare = conductorThermal(physics);
    expect([bare.insulationResistanceKMPerW, bare.outerDiameterM, bare.emissivity]).toStrictEqual([
      0,
      physics.diameterM,
      0.5,
    ]);
    // With R′_ins = 0 the surface is the conductor: G′ = h(T_c) π D exactly.
    expect(conductanceToAirWPerMK(bare, 343.15, 293.15)).toBeCloseTo(
      surfaceCoefficientWPerM2K(bare, 343.15, 293.15) * Math.PI * physics.diameterM,
      12,
    );
  });

  it('radiation is always on: h at zero rise is ε σ (2 T_a²)(2 T_a), never 0', () => {
    expect(surfaceCoefficientWPerM2K(thhn14, 293.15, 293.15)).toBeCloseTo(0.9 * 5.670374419e-8 * 4 * 293.15 ** 3, 12);
    expect(surfaceCoefficientWPerM2K(thhn14, 280, 293.15)).toBeGreaterThan(0); // below ambient: no convection term
  });
});

describe('derivedAmpacityA (D6, ADR 0018 §9): free air, 30 °C ambient, single conductor', () => {
  const at = (id: string, ratingTempK = T90) =>
    derivedAmpacityA(conductorThermal(physicsOf(id)), { ratingTempK, ambientK: T30 });

  it('matches ADR 0018’s prototype values (14 AWG THHN 31.77 A, at 60 °C 21.90 A, 12 AWG 42.8 A, 4/0 446.89 A)', () => {
    expect(rel(at('conductor.tallowmere-thhn-14-solid'), 31.77)).toBeLessThan(0.001);
    expect(rel(at('conductor.tallowmere-thhn-14-solid', 333.15), 21.9)).toBeLessThan(0.001);
    expect(rel(at('conductor.tallowmere-thhn-12-solid'), 42.8)).toBeLessThan(0.001);
    expect(rel(at('conductor.tallowmere-thhn-4-0-stranded'), 446.89)).toBeLessThan(0.0005);
  });

  it('pins the aluminium and MTW figures at 0.1 % (Al 4 AWG 120.38 A, Al 4/0 358.40 A, MTW 18 AWG 18.82 A)', () => {
    expect(rel(at('conductor.quorvale-xhhw2-al-4-compact'), 120.38)).toBeLessThan(0.001);
    expect(rel(at('conductor.quorvale-xhhw2-al-4-0-compact'), 358.4)).toBeLessThan(0.001);
    expect(rel(at('conductor.tallowmere-mtw-18'), 18.82)).toBeLessThan(0.001);
  });

  it('is within ±20 % of electrical-realism-reviewer’s independent recomputation (14 AWG THHN 32.17 A, 4/0 427.4 A)', () => {
    expect(rel(at('conductor.tallowmere-thhn-14-solid'), 32.17)).toBeLessThan(0.2);
    expect(rel(at('conductor.tallowmere-thhn-4-0-stranded'), 427.4)).toBeLessThan(0.2);
  });

  it('NM-B: a conductor of an NM cable is rated at 60 °C (Art. 334.80), never 90 °C; the two calls differ', () => {
    const thermal = conductorThermal(physicsOf('conductor.tallowmere-thhn-14-solid'));
    const at90 = derivedAmpacityA(thermal, { ratingTempK: T90, ambientK: T30 });
    const nm = derivedAmpacityA(thermal, { ratingTempK: NM_CABLE_AMPACITY_TEMP_K.value, ambientK: T30 });
    expect(nm).toBeLessThan(at90);
    expect(rel(nm, 21.9)).toBeLessThan(0.001);
  });

  it('refuses a rating at or below the ambient', () => {
    const thermal = conductorThermal(physicsOf('conductor.tallowmere-thhn-14-solid'));
    expect(() => derivedAmpacityA(thermal, { ratingTempK: T30, ambientK: T30 })).toThrow(RangeError);
  });

  it('self-consistency: driving the derived current, the integrated heat balance settles at the rating within 0.5 % of the rise', () => {
    // C′ dT/dt = I² R′(T) − G′(T) (T − T_a), forward Euler at dt = 0.05 s from T_a until it settles.
    for (const device of CONDUCTORS) {
      const physics = physicsOf(device.id);
      const thermal = conductorThermal(physics);
      const ratingK = physics.insulation?.ratedTempDryK ?? T90;
      const current = derivedAmpacityA(thermal, { ratingTempK: ratingK, ambientK: T30 });
      const heatCapacity = physics.densityKgM3 * physics.specificHeatJPerKgK * physics.areaM2;
      let t = T30;
      for (let step = 0; step < 2_000_000; step++) {
        const power =
          current * current * conductorResistanceOhm(physics, 1000, t) -
          conductanceToAirWPerMK(thermal, t, T30) * (t - T30);
        const next = t + (0.05 * power) / heatCapacity;
        if (Math.abs(next - t) < 1e-11) break;
        t = next;
      }
      expect(Math.abs(t - ratingK) / (ratingK - T30), device.id).toBeLessThan(0.005);
    }
  });

  it('cross-check, per insulation type: within ±20 % of an independent Churchill–Chu plus radiation balance', () => {
    // An independent recomputation (test-only, so Math.log and Math.pow are fine): the surface balance
    // solved to convergence, (T_c − T_s) / R′_ins = π D [h_CC (T_s − T_a) + ε σ (T_s⁴ − T_a⁴)], with
    // Churchill and Chu's (1975) horizontal-cylinder correlation
    //   Nu = {0.60 + 0.387 Ra^(1/6) / [1 + (0.559/Pr)^(9/16)]^(8/27)}², Ra = g β ΔT D³ / (ν α),
    // and air properties at the film temperature, linear between 300 K and 350 K (textbook air tables:
    // ν 15.89 → 20.92 mm²/s, α 22.5 → 29.9 mm²/s, k 26.3 → 30.0 mW/(m·K)), β = 1/T_f.
    const lerp = (a: number, b: number, tf: number) => a + ((b - a) * (tf - 300)) / 50;
    const churchillChu = (d: number, ts: number, ta: number) => {
      const tf = (ts + ta) / 2;
      const nu = lerp(15.89e-6, 20.92e-6, tf);
      const alpha = lerp(22.5e-6, 29.9e-6, tf);
      const k = lerp(26.3e-3, 30.0e-3, tf);
      const ra = (9.80665 * (1 / tf) * (ts - ta) * d ** 3) / (nu * alpha);
      const pr = nu / alpha;
      const nusselt = (0.6 + (0.387 * ra ** (1 / 6)) / (1 + (0.559 / pr) ** (9 / 16)) ** (8 / 27)) ** 2;
      return (nusselt * k) / d;
    };
    const independent = (physics: ConductorPhysics, tc: number, ta: number) => {
      const ins = physics.insulation;
      if (ins === null) throw new Error('insulated only');
      const r0 = physics.diameterM / 2;
      const r1 = r0 + ins.thicknessM;
      const r2 = r1 + (ins.jacketThicknessM ?? 0);
      const rIns =
        Math.log(r1 / r0) / (2 * Math.PI * ins.conductivityWPerMK) +
        (ins.jacketThicknessM === null ? 0 : Math.log(r2 / r1) / (2 * Math.PI * (ins.jacketConductivityWPerMK ?? 1)));
      const d = 2 * r2;
      const loss = (ts: number) =>
        Math.PI * d * (churchillChu(d, ts, ta) * (ts - ta) + ins.emissivity * 5.670374419e-8 * (ts ** 4 - ta ** 4));
      let lo = ta + 1e-9;
      let hi = tc;
      for (let i = 0; i < 200; i++) {
        const ts = (lo + hi) / 2;
        if ((tc - ts) / rIns > loss(ts)) lo = ts;
        else hi = ts;
      }
      const q = (tc - lo) / rIns;
      return Math.sqrt(q / conductorResistanceOhm(physics, 1000, tc));
    };
    const worst: Record<string, number> = {};
    // Insulated entries only: a bare conductor (NM-B's EGC) has no insulation row to group or rate it by.
    for (const device of CONDUCTORS.filter((d) => d.conductor?.insulation !== null)) {
      const physics = physicsOf(device.id);
      const derived = derivedAmpacityA(conductorThermal(physics), { ratingTempK: T90, ambientK: T30 });
      const check = independent(physics, T90, T30);
      const key = device.conductor?.insulation?.key as string;
      worst[key] = Math.max(worst[key] ?? 0, rel(derived, check));
    }
    expect(Object.keys(worst).sort()).toStrictEqual(['mtw', 'thhnThwn2', 'xhhw2']);
    for (const [key, error] of Object.entries(worst)) expect(error, key).toBeLessThan(0.2);
  });

  it('rises with size and falls with the rating temperature’s distance to ambient (property)', () => {
    const thermal = conductorThermal(physicsOf('conductor.tallowmere-thhn-12-solid'));
    fc.assert(
      fc.property(
        fc.double({ min: 305, max: 420, noNaN: true }),
        fc.double({ min: 0.5, max: 30, noNaN: true }),
        (tr, step) => {
          const lower = derivedAmpacityA(thermal, { ratingTempK: tr, ambientK: T30 });
          const higher = derivedAmpacityA(thermal, { ratingTempK: tr + step, ambientK: T30 });
          expect(higher).toBeGreaterThan(lower);
        },
      ),
    );
    const sizes = ['14', '12', '10'].map((n) => at(`conductor.tallowmere-thhn-${n}-solid`));
    expect([...sizes].sort((a, b) => a - b)).toStrictEqual(sizes);
  });
});
