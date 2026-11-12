import { CURRENT_SCHEMA_VERSION, LEAD_SIM_BAG_V3 } from '@controls/save-format';
import fc from 'fast-check';
import { leadConductorResistanceOhm, leadResistanceOhm } from './lead';
import { initialBags, type LeadParams, MODEL_KINDS } from './model-kinds';

/** The catalogue's 1 m 18 AWG copper test lead: A from the AWG formula, ρ and α from IACS. */
const copper: LeadParams = {
  lengthMm: 1000,
  conductorAreaM2: 8.2305e-7, // 18 AWG: π d²/4 with d = 0.127 mm × 92^(18/39)
  resistivityOhmM: 1 / 58e6, // IACS: 1/58 Ω·mm²/m
  temperatureCoefficientPerK: 0.00393,
  referenceTemperatureK: 293.15,
  contactResistanceOhm: 0.01, // per end
  // The thermal params (F3.6 part 1): copper, a 0.8 mm PVC wall.
  linearAlphaMaxK: 473.15,
  densityKgM3: 8890,
  specificHeatJPerKgK: 385,
  insulationThicknessMm: 0.8,
  insulationConductivityWPerMK: 0.18,
  surfaceEmissivity: 0.9,
};

/** ρ L / A at 20 °C: 1/58e6 Ω·m × 1 m / 8.2305e-7 m² ≈ 20.95 mΩ (solid wire; stranded leads read about 10 % more). */
const R20 = 1 / 58e6 / 8.2305e-7;

describe('lead resistance (resistivity × length ÷ area, with a temperature coefficient)', () => {
  it('is ρ L / A at the reference temperature', () => {
    expect(leadConductorResistanceOhm(copper, 293.15)).toBeCloseTo(R20, 15);
    expect(R20).toBeCloseTo(0.02095, 5);
    expect(leadResistanceOhm(copper, 293.15)).toBeCloseTo(R20 + 0.02, 15);
  });

  it('rises by α per kelvin above the reference', () => {
    // 50 K above 20 °C: × (1 + 0.00393 × 50) = × 1.1965.
    expect(leadConductorResistanceOhm(copper, 343.15)).toBeCloseTo(R20 * 1.1965, 15);
  });

  it('scales with length and inversely with area (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.double({ min: 1e-8, max: 1e-3, noNaN: true }),
        (lengthMm, area) => {
          const params = { ...copper, lengthMm, conductorAreaM2: area };
          const r = leadConductorResistanceOhm(params, copper.referenceTemperatureK);
          const doubled = leadConductorResistanceOhm(
            { ...params, lengthMm: lengthMm * 2 },
            copper.referenceTemperatureK,
          );
          expect(doubled / r).toBeCloseTo(2, 12);
          expect(r).toBeGreaterThan(0);
          expect(leadResistanceOhm(params, copper.referenceTemperatureK)).toBe(r + 2 * copper.contactResistanceOhm);
        },
      ),
    );
  });
});

describe('the v2 → v3 migration’s lead bag (ADR 0015)', () => {
  it('equals the lead kind’s initial sim bag while schemaVersion 3 is current', () => {
    // `save-format`'s v2 → v3 step holds the bag as a frozen literal so it never reads the catalogue.
    // While v3 is the current version the two must agree, or a migrated lead would fail the load
    // check. Once a later version changes the lead kind's keys, this test moves to that version's
    // migration (the v3 literal itself never changes).
    expect(CURRENT_SCHEMA_VERSION).toBe(3);
    expect(LEAD_SIM_BAG_V3).toStrictEqual(initialBags(MODEL_KINDS['lead']).sim);
    expect(initialBags(MODEL_KINDS['lead']).state).toStrictEqual({});
  });
});
