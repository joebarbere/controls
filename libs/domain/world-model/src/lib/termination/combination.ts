import { awgInRange, awgName, gaugeRow, type TwistOnCombination } from '@controls/catalog';

/*
 * A twist-on splice's rated combinations (ADR 0018 §4.4): a count range, a size range and a total-size
 * range, checked with exact integer arithmetic on the gauge table's `areaUm2`. A command concern: a
 * landing outside the bounds is refused (`combination-out-of-range`), so the engine never sees one.
 *
 * A splice is built one conductor at a time, so the **lower** bounds can't be checked while it is
 * being made: a landing is refused when the splice would hold more conductors than the rating, a
 * conductor outside the size range, or more total size than the maximum; and, once it holds at least
 * `minConductors`, less total size than the minimum (a nut too large to grip what is in it). Unlanding
 * is never refused, so a splice can be left under its minimum; the engine treats every splice it sees
 * as made (ADR 0018 §4.4, with r = 1), an abstraction recorded in the simulation caveats.
 */

/**
 * Why the conductors `awgs` (every conductor the splice would hold, the new one included) are outside
 * `combination`, or `null` if they fit.
 */
export function combinationProblem(combination: TwistOnCombination, awgs: readonly number[]): string | null {
  const n = awgs.length;
  if (n > combination.maxConductors) {
    return `The splice is rated for at most ${combination.maxConductors} conductors, not ${n}`;
  }
  let total = 0;
  for (const awg of awgs) {
    if (!awgInRange(awg, combination.awg)) {
      return `A ${awgName(awg)} AWG conductor is outside the splice's rated sizes (${awgName(combination.awg.smallest)} to ${awgName(combination.awg.largest)} AWG)`;
    }
    total += gaugeRow(awg)?.areaUm2 ?? 0;
  }
  if (total > combination.totalAreaUm2.max) {
    return `The conductors' total size (${total} µm²) is above the splice's rated maximum (${combination.totalAreaUm2.max} µm²)`;
  }
  if (n >= combination.minConductors && total < combination.totalAreaUm2.min) {
    return `The conductors' total size (${total} µm²) is below the splice's rated minimum (${combination.totalAreaUm2.min} µm²)`;
  }
  return null;
}
