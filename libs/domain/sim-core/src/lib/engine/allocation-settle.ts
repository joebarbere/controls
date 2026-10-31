/*
 * The allocation gates' settling rule (#66), shared by `allocation.spec.ts` and
 * `allocation-loads.spec.ts`. Node-free on purpose: the measurement itself (V8's sampling heap
 * profiler through `node:inspector`) stays in the specs, and this module only decides how many
 * windows to measure and what the gate compares. Not exported from the library.
 */

/** The last this many windows must agree before the gate counts. */
export const SETTLED_WINDOWS = 4;
/** ... within this many bytes per step of each other. */
export const SETTLED_SPREAD = 2;
/** Never more than this many times the window count in all. */
export const MAX_WINDOWS_FACTOR = 3;

/** The median of `xs` (the mean of the middle two for an even count). */
export function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface SettledWindows {
  /** The median of the counted windows: what the gate compares. */
  readonly perStep: number;
  /** Every window measured, in order (the failure message lists them all). */
  readonly all: readonly number[];
  /** The counted windows: the last `windowCount` of `all`. */
  readonly counted: readonly number[];
}

/**
 * Measures windows with `measureWindow` (bytes per step for one window) until there are at least
 * `windowCount` and the last `SETTLED_WINDOWS` (or `windowCount`, if fewer) lie within
 * `SETTLED_SPREAD` of each other, or `MAX_WINDOWS_FACTOR` × `windowCount` have been measured; then
 * takes the median of the last `windowCount`. A steady allocation settles at once and is measured in
 * full, so this can't hide one; only a falling sequence (tier-up still finishing) keeps it going.
 */
export function settledWindows(windowCount: number, measureWindow: () => number): SettledWindows {
  const all: number[] = [];
  const settledCount = Math.min(SETTLED_WINDOWS, windowCount);
  const settled = () => {
    const last = all.slice(-settledCount);
    return Math.max(...last) - Math.min(...last) <= SETTLED_SPREAD;
  };
  while (all.length < windowCount || (!settled() && all.length < MAX_WINDOWS_FACTOR * windowCount)) {
    all.push(measureWindow());
  }
  const counted = all.slice(-windowCount);
  return { perStep: median(counted), all, counted };
}
