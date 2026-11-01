import { formatQuantity } from './netlist-model';

/*
 * The trace plot's model (plan F2.6), framework-free: a trace's (tick, value) samples laid out as
 * SVG polylines in a fixed box, with the axis ranges and a text summary. Drawn sample-and-hold (a
 * step at each solve: between solves the engine holds its solution). `NaN` (no reading) breaks the
 * line, never draws as 0.
 */

/** The plot box, in SVG user units. */
export const PLOT = Object.freeze({ width: 280, height: 96 });

export interface TraceLayout {
  /** One `points` string per unbroken run of readings, stepped (sample and hold). */
  readonly lines: readonly string[];
  /** The time axis, in s of sim time (1 tick = 1 ms). */
  readonly t0: number;
  readonly t1: number;
  /** The value axis: 0 to the largest reading (1 when there is none). */
  readonly max: number;
  /** The largest reading and its time, or `null` without a reading. */
  readonly peak: { readonly value: number; readonly t: number } | null;
  /** The newest sample's value (`NaN`: no reading) and time, or `null` without samples. */
  readonly latest: { readonly value: number; readonly t: number } | null;
}

/** Lays `samples` ((tick, value) pairs, ticks non-decreasing) out in {@link PLOT}. */
export function layoutTrace(samples: Float64Array): TraceLayout {
  const n = samples.length >> 1;
  if (n === 0) return { lines: [], t0: 0, t1: 0, max: 1, peak: null, latest: null };
  const tick0 = samples[0];
  const tick1 = samples[2 * (n - 1)];
  let peak: { value: number; t: number } | null = null;
  for (let i = 0; i < n; i++) {
    const v = samples[2 * i + 1];
    if (Number.isFinite(v) && (peak === null || v > peak.value)) peak = { value: v, t: samples[2 * i] / 1000 };
  }
  const max = peak !== null && peak.value > 0 ? peak.value : 1;
  const span = Math.max(1, tick1 - tick0);
  const lines: string[] = [];
  let run: string[] = [];
  let heldY = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[2 * i + 1];
    if (!Number.isFinite(v)) {
      if (run.length > 0) lines.push(run.join(' '));
      run = [];
      continue;
    }
    const x = ((samples[2 * i] - tick0) / span) * PLOT.width;
    const y = PLOT.height - (Math.max(0, v) / max) * PLOT.height;
    // Sample and hold: a solve's value holds until the next solve, so the line steps at each solve.
    if (run.length > 0) run.push(`${round(x)},${heldY}`);
    run.push(`${round(x)},${round(y)}`);
    heldY = round(y);
  }
  if (run.length > 0) lines.push(run.join(' '));
  return {
    lines,
    t0: tick0 / 1000,
    t1: tick1 / 1000,
    max,
    peak,
    latest: { value: samples[2 * n - 1], t: tick1 / 1000 },
  };
}

/** The plot's text alternative: what a screen reader hears, and the caption under the plot. */
export function describeTrace(layout: TraceLayout, unit: string): string {
  if (layout.latest === null) return 'No samples yet.';
  const now = Number.isFinite(layout.latest.value) ? formatQuantity(layout.latest.value, unit) : 'no reading';
  const peak =
    layout.peak === null ? 'no reading' : `${formatQuantity(layout.peak.value, unit)} at ${seconds(layout.peak.t)}`;
  return `Peak ${peak}; last solve at ${seconds(layout.latest.t)}: ${now}.`;
}

/** A time in s to the millisecond (a tick). */
export const seconds = (t: number): string => `${t.toFixed(3)} s`;

const round = (v: number): number => Math.round(v * 10) / 10;
