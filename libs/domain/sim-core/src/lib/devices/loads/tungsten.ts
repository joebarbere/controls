import type { SourcedConstant } from '../../constants';

/*
 * Tungsten's electrical resistivity against temperature (plan F2.5, the incandescent lamp's R(T)).
 * Piecewise linear between sourced points, so only `+ − × ÷` (decision D6: no transcendental).
 */

/**
 * The points (K, µΩ·cm), ascending in temperature. Measured on tungsten filament wire by H. A. Jones
 * and I. Langmuir, "The characteristics of tungsten filaments as functions of temperature", General
 * Electric Review 30 (1927), pp. 310–319, 354–361 and 408–412, the classic lamp-engineering data.
 * Every other 100 K step is kept below 3600 K (and every step up to 600 K, where the curve bends most);
 * interpolating linearly between them is within about 0.5 % of the full table. Physical measurements,
 * not a standard's table.
 */
export const TUNGSTEN_RESISTIVITY: {
  readonly kind: SourcedConstant['kind'];
  readonly source: string;
  readonly unit: string;
  readonly temperaturesK: readonly number[];
  readonly microOhmCm: readonly number[];
} = Object.freeze({
  kind: 'real-world',
  unit: 'µΩ·cm',
  source:
    'H. A. Jones and I. Langmuir, "The characteristics of tungsten filaments as functions of temperature", General Electric Review 30 (1927), pp. 310–319, 354–361 and 408–412: the resistivity of tungsten filament wire from 300 K to 3600 K. A subset of their points; linear interpolation between them.',
  temperaturesK: Object.freeze([
    300, 400, 500, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400, 2600, 2800, 3000, 3200, 3400, 3600,
  ]),
  microOhmCm: Object.freeze([
    5.65, 8.06, 10.56, 13.23, 19.0, 24.93, 30.98, 37.19, 43.55, 50.05, 56.67, 63.48, 70.39, 77.49, 84.7, 92.04, 99.54,
    107.2, 115.0,
  ]),
});

// Typed copies for the per-tick lookup: a frozen array of doubles holds them boxed, typed arrays don't.
const T = Float64Array.from(TUNGSTEN_RESISTIVITY.temperaturesK);
const RHO = Float64Array.from(TUNGSTEN_RESISTIVITY.microOhmCm);

/** The lowest and highest temperatures the table covers (K). Outside them it is extended linearly. */
export const TUNGSTEN_TABLE_MIN_K = T[0];
export const TUNGSTEN_TABLE_MAX_K = T[T.length - 1];

/** Every table point is a multiple of this (K), so a bucket of it lies inside one segment. */
const BUCKET_K = 100;
/**
 * The segment (1-based: between points k − 1 and k) for each 100 K bucket from 0 K up to the table's
 * top, so a lookup needs no loop: a per-tick loop over the table measured 16 bytes allocated per step
 * in the engine's allocation gate.
 */
const SEGMENT = Int32Array.from({ length: Math.ceil(T[T.length - 1] / BUCKET_K) + 1 }, (_, bucket) => {
  let k = 1;
  while (k < T.length - 1 && bucket * BUCKET_K >= T[k]) k++;
  return k;
});

/**
 * Tungsten's resistivity (µΩ·cm) at `kelvin`: linear between the table's points, and extended along
 * its first or last segment outside them (below 300 K: a bench at 20 °C is 293.15 K, 7 K below the
 * first point). Allocation-free and loop-free.
 */
export function tungstenResistivity(kelvin: number): number {
  const bucket = Math.floor(kelvin / BUCKET_K);
  const k = SEGMENT[bucket < 0 ? 0 : bucket >= SEGMENT.length ? SEGMENT.length - 1 : bucket];
  const t0 = T[k - 1];
  const r0 = RHO[k - 1];
  return r0 + ((RHO[k] - r0) * (kelvin - t0)) / (T[k] - t0);
}
