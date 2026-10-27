/**
 * Length units. Canonical world geometry is **integer millimetres**, right-handed, +y up
 * (ADR 0004). The Three.js scene uses metres; the renderer converts with {@link mm} in one place.
 */

/** Millimetres → metres (scene units). `mm(35)` is 0.035. */
export const mm = (valueMm: number): number => valueMm / 1000;

/** Exact inches → millimetres (1 in = 25.4 mm by definition, NIST SP 811 Appendix B). Not rounded. */
export const inchesToMm = (inches: number): number => inches * 25.4;

/**
 * Rounds a finite length to integer millimetres, half away from zero, never returning `-0`
 * (the save format normalises `-0`; ADR 0004). Throws on NaN or ±Infinity.
 */
export function roundMm(valueMm: number): number {
  if (!Number.isFinite(valueMm)) throw new RangeError(`length must be finite, got ${valueMm}`);
  const r = Math.sign(valueMm) * Math.round(Math.abs(valueMm));
  return r === 0 ? 0 : r;
}

/** Metres (scene units) → integer millimetres, via {@link roundMm}. */
export const metresToMm = (metres: number): number => roundMm(metres * 1000);

/** True for a finite integer that is not `-0`: a valid world coordinate. */
export const isIntegerMm = (value: number): boolean => Number.isInteger(value) && !Object.is(value, -0);
