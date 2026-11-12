import { Int } from '@controls/save-format';
import * as z from 'zod';

/*
 * The catalogue's one gauge table (catalogue v2, ADR 0015, ADR 0016). American Wire Gauge sizes are
 * integer designations: 18, 14, …, 1, then 1/0, 2/0, 3/0 and 4/0, which continue the sequence as 0, −1,
 * −2 and −3. Every gauge check (a terminal's `awgRange`, a stripper hole, a tool's `maxAwg`, a
 * conductor's size) compares these integers, never floating-point areas: the area needs a fractional
 * power (forbidden in simulator code, D6) and rounded areas could refuse equal gauges.
 *
 * A smaller designation is a **larger** conductor: 4/0 (−3) is the largest here, 40 the smallest.
 *
 * Diameters and areas are computed from the AWG definition, never copied from a table:
 * d(n) = 0.127 mm × 92^((36 − n)/39) (the 36 AWG diameter is 0.005 in and 4/0 is 0.46 in, with 39
 * equal geometric steps between them), A = π d²/4, as stated in NBS Handbook 100 (Copper Wire Tables,
 * 1966, §2; ASTM B258 is the current standard, paywalled). The values below were computed from that
 * formula and rounded to six significant figures; `gauge.spec.ts` recomputes every row. These are
 * solid-round sizes: a stranded conductor's area is the same nominal area (its lay factor is the
 * conductor entry's business, F3.1).
 */

/** The smallest designation in the table (4/0). */
export const MIN_AWG = -3;
/** The largest designation in the table (40 AWG). */
export const MAX_AWG = 40;

/** An AWG designation as an integer: 4/0 = −3, 3/0 = −2, 2/0 = −1, 1/0 = 0, then 1 … 40. */
export const Awg = Int.min(MIN_AWG).max(MAX_AWG).meta({
  id: 'Awg',
  description: 'An AWG size as an integer designation: 4/0 = -3, 3/0 = -2, 2/0 = -1, 1/0 = 0, then 1 to 40.',
});
export type Awg = z.infer<typeof Awg>;

/**
 * A range of conductor sizes, both ends included. `smallest` is the thinnest conductor (the larger
 * designation), `largest` the thickest: 22 to 10 AWG is `{ smallest: 22, largest: 10 }`.
 */
export const AwgRange = z.strictObject({ smallest: Awg, largest: Awg }).refine((r) => r.smallest >= r.largest, {
  message: 'smallest is the thinnest conductor: its designation must not be below largest (4/0 = -3)',
});
export type AwgRange = z.infer<typeof AwgRange>;

/** Whether the designation `awg` lies inside `range`. */
export function awgInRange(awg: number, range: AwgRange): boolean {
  return awg <= range.smallest && awg >= range.largest;
}

export interface GaugeRow {
  /** The integer designation (4/0 = −3). */
  readonly awg: number;
  /** How it is written: `14`, `1/0`, `4/0`. */
  readonly name: string;
  /** Solid-round diameter (mm), from the AWG formula. */
  readonly diameterMm: number;
  /** Cross-sectional area (mm²), π d²/4. */
  readonly areaMm2: number;
  /**
   * The same area as an integer in µm² (`areaMm2` × 10⁶, rounded once here), so a twist-on splice's
   * total-size check is exact integer arithmetic like every other gauge check (ADR 0018 §4.4). **Save
   * semantics:** a landing's refusal depends on it, so these values are pinned by `gauge.spec.ts` and
   * never change.
   */
  readonly areaUm2: number;
}

/** How a designation is written: `14`, `1/0` (0), `4/0` (−3). */
export function awgName(awg: number): string {
  return awg <= 0 ? `${1 - awg}/0` : `${awg}`;
}

/** The designation of a written size (`14` → 14, `4/0` → −3), or `undefined`. */
export function parseAwgName(name: string): number | undefined {
  const aught = /^([1-4])\/0$/.exec(name);
  if (aught) return 1 - Number(aught[1]);
  if (!/^[1-9][0-9]?$/.test(name)) return undefined;
  const awg = Number(name);
  return awg <= MAX_AWG ? awg : undefined;
}

const row = (awg: number, diameterMm: number, areaMm2: number): GaugeRow =>
  Object.freeze({ awg, name: awgName(awg), diameterMm, areaMm2, areaUm2: Math.round(areaMm2 * 1e6) });

/** Every AWG size from 4/0 to 40, in designation order (largest conductor first). */
export const AWG_GAUGES: readonly GaugeRow[] = Object.freeze([
  row(-3, 11.684, 107.219),
  row(-2, 10.4049, 85.0288),
  row(-1, 9.26583, 67.4309),
  row(0, 8.25146, 53.4751),
  row(1, 7.34814, 42.4077),
  row(2, 6.54371, 33.6308),
  row(3, 5.82734, 26.6705),
  row(4, 5.1894, 21.1506),
  row(5, 4.62129, 16.7732),
  row(6, 4.11538, 13.3018),
  row(7, 3.66485, 10.5488),
  row(8, 3.26364, 8.36556),
  row(9, 2.90636, 6.63419),
  row(10, 2.58819, 5.26115),
  row(11, 2.30485, 4.17229),
  row(12, 2.05253, 3.30877),
  row(13, 1.82783, 2.62398),
  row(14, 1.62773, 2.08091),
  row(15, 1.44953, 1.65023),
  row(16, 1.29085, 1.3087),
  row(17, 1.14953, 1.03784),
  row(18, 1.02369, 0.823047),
  row(19, 0.91162, 0.652706),
  row(20, 0.811821, 0.517619),
  row(21, 0.722947, 0.410491),
  row(22, 0.643803, 0.325534),
  row(23, 0.573323, 0.25816),
  row(24, 0.510559, 0.20473),
  row(25, 0.454666, 0.162359),
  row(26, 0.404892, 0.128756),
  row(27, 0.360567, 0.102108),
  // 28 and 29: the six-figure areas end in a decimal half. areaMm2 × 1e6 is exactly 80 975.5 for 28
  // (Math.round takes it up to 80 976) but 64 216.49999… for 29 in binary (down to 64 216), so they round
  // opposite ways. Deterministic and pinned in gauge.spec.ts; never "fix" one: areaUm2 is save semantics.
  row(28, 0.321094, 0.0809755),
  row(29, 0.285942, 0.0642165),
  row(30, 0.254639, 0.050926),
  row(31, 0.226763, 0.0403862),
  row(32, 0.201938, 0.0320277),
  row(33, 0.179831, 0.0253991),
  row(34, 0.160144, 0.0201424),
  row(35, 0.142612, 0.0159737),
  row(36, 0.127, 0.0126677),
  row(37, 0.113097, 0.0100459),
  row(38, 0.100716, 0.00796679),
  row(39, 0.0896898, 0.00631795),
  row(40, 0.0798711, 0.00501036),
]);

/** The row of a designation, or `undefined` outside 4/0 … 40. */
export function gaugeRow(awg: number): GaugeRow | undefined {
  return Number.isInteger(awg) && awg >= MIN_AWG && awg <= MAX_AWG ? AWG_GAUGES[awg - MIN_AWG] : undefined;
}

/** The gauge table's source (realism charter): the AWG definition, paraphrased. */
export const AWG_GAUGE_SOURCE =
  'NBS Handbook 100, Copper Wire Tables (1966), §2: the AWG diameters follow d = 0.127 mm × 92^((36 − n)/39) (36 AWG = 0.005 in, 4/0 = 0.46 in, 39 geometric steps), with 1/0 to 4/0 continuing the sequence as 0 to −3; areas are π d²/4. The current standard is ASTM B258 (paywalled, not read). Computed from the formula, not copied from any conductor table.';
