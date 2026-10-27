import fc from 'fast-check';
import { inchesToMm, isIntegerMm, metresToMm, mm, roundMm } from './length';

describe('mm', () => {
  it('converts millimetres to metres', () => {
    expect(mm(35)).toBe(0.035);
    expect(mm(0)).toBe(0);
    expect(mm(-1500)).toBe(-1.5);
  });
});

describe('inchesToMm', () => {
  it('uses the exact 25.4 mm inch', () => {
    expect(inchesToMm(1)).toBe(25.4);
    expect(inchesToMm(16)).toBeCloseTo(406.4, 10);
  });
});

describe('roundMm', () => {
  it('rounds half away from zero', () => {
    expect(roundMm(2.5)).toBe(3);
    expect(roundMm(-2.5)).toBe(-3);
    expect(roundMm(2.49)).toBe(2);
  });

  it('never returns -0', () => {
    expect(Object.is(roundMm(-0.4), 0)).toBe(true);
    expect(Object.is(roundMm(-0), 0)).toBe(true);
  });

  it('rejects non-finite input', () => {
    expect(() => roundMm(Number.NaN)).toThrow(RangeError);
    expect(() => roundMm(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('always yields a valid integer-mm value and is idempotent', () => {
    fc.assert(
      fc.property(fc.double({ min: -1e9, max: 1e9, noNaN: true }), (x) => {
        const r = roundMm(x);
        expect(isIntegerMm(r)).toBe(true);
        expect(roundMm(r)).toBe(r);
        expect(Math.abs(r - x)).toBeLessThanOrEqual(0.5);
      }),
    );
  });
});

describe('metresToMm', () => {
  it('round-trips integer millimetres through scene metres', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), (v) => {
        expect(metresToMm(mm(v))).toBe(v === 0 ? 0 : v);
      }),
    );
  });
});

describe('isIntegerMm', () => {
  it('accepts integers and rejects fractions, -0 and non-finite values', () => {
    expect(isIntegerMm(12)).toBe(true);
    expect(isIntegerMm(0)).toBe(true);
    expect(isIntegerMm(-0)).toBe(false);
    expect(isIntegerMm(1.5)).toBe(false);
    expect(isIntegerMm(Number.NaN)).toBe(false);
  });
});
