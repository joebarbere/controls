import fc from 'fast-check';
import { BUILTIN_CATALOG } from './builtin';
import { type ConductorResistanceData, conductorPhysics, conductorResistanceOhm } from './conductor';
import { AWG_GAUGES, gaugeRow } from './gauge';
import type { MaterialRow } from './tables';

/*
 * F3.1: conductor resistance is derived, never tabulated (ADR 0018 §2). Every golden below has its
 * hand calculation written out, and the tolerance is far inside the 0.5 % the plan allows.
 */

const material = (key: string) =>
  BUILTIN_CATALOG.tableRow({ table: 'materials', version: 1, key }) as unknown as MaterialRow;
const COPPER = material('copperAnnealed');
const ALUMINIUM = material('aluminiumAa8000');

/** The resistance data of `awg` in `metal`, solid (k_lay = 1) unless a lay factor is given. */
const data = (metal: MaterialRow, awg: number, layFactor = 1): ConductorResistanceData => ({
  resistivityOhmM: metal.resistivityOhmM,
  temperatureCoefficientPerK: metal.temperatureCoefficientPerK,
  referenceTemperatureK: metal.referenceTemperatureK,
  linearAlphaMaxK: metal.linearAlphaMaxK,
  areaM2: (gaugeRow(awg)?.areaMm2 as number) / 1e6,
  layFactor,
});

const T0 = 293.15;
/** |actual / expected − 1| ≤ rel. */
const expectRel = (actual: number, expected: number, rel = 1e-5) =>
  expect(Math.abs(actual / expected - 1), `${actual} vs ${expected}`).toBeLessThanOrEqual(rel);

describe('conductorResistanceOhm (F3.1, ADR 0018 §2)', () => {
  it('per metre at 20 °C, copper and aluminium, 18, 14, 12, 4 and 4/0 AWG: ρ₀ / A by hand', () => {
    // A from the AWG definition d = 0.127 mm · 92^((36 − n)/39), A = π d²/4 (AWG_GAUGES, 6 s.f.).
    // Copper ρ₀ = 1/58 Ω·mm²/m = 1.7241379e-8 Ω·m; aluminium (AA-8000, 61.0 % IACS) ρ₀ = 2.8264e-8 Ω·m.
    //   18 AWG  A = 0.823047 mm²: Cu 1.7241379e-8 / 0.823047e-6 = 20.94823 mΩ/m; Al 2.8264e-8 / 0.823047e-6 = 34.34069 mΩ/m
    //   14 AWG  A = 2.08091 mm²:  Cu 1.7241379e-8 / 2.08091e-6  = 8.285500 mΩ/m; Al 2.8264e-8 / 2.08091e-6  = 13.58252 mΩ/m
    //   12 AWG  A = 3.30877 mm²:  Cu 1.7241379e-8 / 3.30877e-6  = 5.210812 mΩ/m; Al 2.8264e-8 / 3.30877e-6  = 8.542147 mΩ/m
    //    4 AWG  A = 21.1506 mm²:  Cu 1.7241379e-8 / 21.1506e-6  = 0.8151721 mΩ/m; Al 2.8264e-8 / 21.1506e-6 = 1.336321 mΩ/m
    //  4/0 AWG  A = 107.219 mm²:  Cu 1.7241379e-8 / 107.219e-6  = 0.1608053 mΩ/m; Al 2.8264e-8 / 107.219e-6 = 0.2636100 mΩ/m
    const goldens: [number, number, number][] = [
      [18, 20.94823e-3, 34.34069e-3],
      [14, 8.2855e-3, 13.58252e-3],
      [12, 5.210812e-3, 8.542147e-3],
      [4, 0.8151721e-3, 1.336321e-3],
      [-3, 0.1608053e-3, 0.26361e-3],
    ];
    for (const [awg, copper, aluminium] of goldens) {
      expectRel(conductorResistanceOhm(data(COPPER, awg), 1000, T0), copper);
      expectRel(conductorResistanceOhm(data(ALUMINIUM, awg), 1000, T0), aluminium);
    }
  });

  it('30 m of 14 AWG solid copper at 20 °C is 0.248565 Ω (the plan’s voltage-drop golden)', () => {
    // R = ρ₀ L / A = 1.7241379e-8 Ω·m × 30 m / 2.08091e-6 m² = 5.172414e-7 / 2.08091e-6 = 0.2485650 Ω.
    expectRel(conductorResistanceOhm(data(COPPER, 14), 30_000, T0), 0.248565);
  });

  it('applies the lay factor and α, and holds R at its 200 °C value above the linear range', () => {
    // 4/0 stranded copper, k_lay 1.02: 0.1608053 mΩ/m × 1.02 = 0.1640214 mΩ/m.
    expectRel(conductorResistanceOhm(data(COPPER, -3, 1.02), 1000, T0), 0.1640214e-3);
    // 30 m of 14 AWG at 75 °C: 0.2485650 × (1 + 0.00393 × 55) = 0.2485650 × 1.21615 = 0.3022923 Ω.
    expectRel(conductorResistanceOhm(data(COPPER, 14), 30_000, 348.15), 0.3022923);
    // Clamp at T_lin = 473.15 K: (1 + 0.00393 × 180) = 1.7074, the same at 250 °C as at 200 °C.
    expectRel(conductorResistanceOhm(data(COPPER, 14), 30_000, 473.15), 0.248565 * 1.7074);
    expect(conductorResistanceOhm(data(COPPER, 14), 30_000, 523.15)).toBe(
      conductorResistanceOhm(data(COPPER, 14), 30_000, 473.15),
    );
    // Aluminium's α is 0.00403: 14 AWG Al per metre at 90 °C = 13.58252 mΩ/m × (1 + 0.00403 × 70) = 17.41415 mΩ/m.
    expectRel(conductorResistanceOhm(data(ALUMINIUM, 14), 1000, 363.15), 17.41415e-3);
  });

  it('aluminium over copper is ρ_Al / ρ_Cu = 1 / 0.610 = 1.63931, at every size', () => {
    for (const { awg } of AWG_GAUGES) {
      const ratio =
        conductorResistanceOhm(data(ALUMINIUM, awg), 1000, T0) / conductorResistanceOhm(data(COPPER, awg), 1000, T0);
      expectRel(ratio, 1.63931, 2e-6);
    }
  });

  it('decreases strictly with area: every larger gauge has less resistance (property, at any temperature)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: AWG_GAUGES.length - 2 }),
        fc.double({ min: 250, max: 600, noNaN: true }),
        (i, t) => {
          // AWG_GAUGES runs from 4/0 (largest area) to 40: row i is larger than row i + 1.
          const larger = conductorResistanceOhm(data(COPPER, AWG_GAUGES[i].awg), 1000, t);
          const smaller = conductorResistanceOhm(data(COPPER, AWG_GAUGES[i + 1].awg), 1000, t);
          expect(larger).toBeLessThan(smaller);
        },
      ),
    );
  });

  it('scales linearly with length: R(2L) = 2 R(L) exactly, R(kL) = k R(L) to rounding (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200_000 }),
        fc.integer({ min: 1, max: 50 }),
        fc.constantFrom(18, 14, 12, 4, -3),
        (lengthMm, k, awg) => {
          const one = conductorResistanceOhm(data(COPPER, awg, 1.02), lengthMm, 330);
          expect(conductorResistanceOhm(data(COPPER, awg, 1.02), 2 * lengthMm, 330)).toBe(2 * one);
          expectRel(conductorResistanceOhm(data(COPPER, awg, 1.02), k * lengthMm, 330), k * one, 1e-12);
        },
      ),
    );
  });
});

describe('conductorPhysics', () => {
  it('resolves a built-in conductor entry into SI data from its gauge, pinned rows and params', () => {
    const entry = BUILTIN_CATALOG.device({ id: 'conductor.tallowmere-thhn-14-solid', version: 1 });
    const physics = entry && conductorPhysics(BUILTIN_CATALOG, entry);
    expect(physics).toStrictEqual({
      awg: 14,
      stranding: 'solid',
      areaM2: 2.08091 / 1e6,
      diameterM: 1.62773 / 1000,
      layFactor: 1,
      resistivityOhmM: 1.724137931034483e-8,
      temperatureCoefficientPerK: 0.00393,
      referenceTemperatureK: 293.15,
      linearAlphaMaxK: 473.15,
      densityKgM3: 8890,
      specificHeatJPerKgK: 385,
      insulation: {
        thicknessM: 0.381 / 1000,
        conductivityWPerMK: 0.18,
        jacketThicknessM: 0.102 / 1000,
        jacketConductivityWPerMK: 0.25,
        emissivity: 0.9,
        ratedTempDryK: 363.15,
        ratedTempWetK: 363.15,
      },
    });
  });

  it('is undefined for a lead or a placed device', () => {
    const lead = BUILTIN_CATALOG.device({ id: 'lead.quillfern-test-1m', version: 1 });
    const lamp = BUILTIN_CATALOG.device({ id: 'lamp.lumivane-12v-5w', version: 1 });
    expect(lead && conductorPhysics(BUILTIN_CATALOG, lead)).toBeUndefined();
    expect(lamp && conductorPhysics(BUILTIN_CATALOG, lamp)).toBeUndefined();
  });
});
