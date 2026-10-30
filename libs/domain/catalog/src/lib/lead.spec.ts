import fc from 'fast-check';
import { leadConductorResistanceOhm, leadResistanceOhm } from './lead';
import type { LeadParams } from './model-kinds';

const copper: LeadParams = {
  lengthMm: 1000,
  conductorAreaM2: 1e-6,
  resistivityOhmM: 1 / 58e6, // IACS: 1/58 Ω·mm²/m
  temperatureCoefficientPerK: 0.00393,
  referenceTemperatureK: 293.15,
  contactResistanceOhm: 0.005,
};

describe('lead resistance (resistivity × length ÷ area, with a temperature coefficient)', () => {
  it('is ρ L / A at the reference temperature', () => {
    expect(leadConductorResistanceOhm(copper, 293.15)).toBeCloseTo(0.0172413793103448, 15);
    expect(leadResistanceOhm(copper, 293.15)).toBeCloseTo(0.0272413793103448, 15);
  });

  it('rises by α per kelvin above the reference', () => {
    // 50 K above 20 °C: × (1 + 0.00393 × 50) = × 1.1965.
    expect(leadConductorResistanceOhm(copper, 343.15)).toBeCloseTo(0.0172413793103448 * 1.1965, 15);
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
