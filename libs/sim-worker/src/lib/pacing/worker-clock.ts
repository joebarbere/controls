import type { SimDiagnostics } from '@controls/sim-protocol';

/*
 * The worker's only wall clock (ADR 0011 §2; the boundary PR exempts `src/lib/pacing/**` from the
 * determinism lint). It is read for three things: work slicing (yield every `WORK_SLICE_MS`),
 * publish throttling (`PUBLISH_MIN_WALL_MS`) and the unhashed diagnostics (§5.6). A reading never
 * reaches `sim-core`, a snapshot's hashed bytes, an event, an export or a save: the engine sees
 * only integer ticks. Without cross-origin isolation `performance.now()` is coarser, which affects
 * these diagnostics only.
 */

/** A monotonic wall clock in milliseconds. */
export interface WorkerClock {
  now(): number;
}

/** `performance.now()`, the worker's real clock. */
export const performanceClock: WorkerClock = { now: () => performance.now() };

/** The diagnostics window (§5.6: "over 1 s"). */
const WINDOW_MS = 1_000;

/**
 * Accumulates the diagnostics area's values from the run loop's work chunks. Each chunk reports
 * the wall time it took, the ticks it stepped and whether it solved. Averages are over the last
 * full second; nothing here changes what the engine computes.
 */
export class WorkerDiagnostics {
  private readonly values: SimDiagnostics = {
    lastSolveMs: 0,
    maxSolveMs: 0,
    meanTickUs: 0,
    ticksPerSecond: 0,
    busyFraction: 0,
    solveCount: 0,
    throttledPublishes: 0,
  };
  private windowStart: number;
  private windowBusyMs = 0;
  private windowTicks = 0;
  private windowMaxSolveMs = 0;

  constructor(private readonly clock: WorkerClock) {
    this.windowStart = clock.now();
  }

  /** The current values (a live object: copy before keeping). */
  get current(): Readonly<SimDiagnostics> {
    return this.values;
  }

  /**
   * A chunk of `ticks` steps took `wallMs`; `solves` is how many electrical solves it ran. Returns
   * whether a window closed (the values are worth writing).
   */
  chunk(wallMs: number, ticks: number, solves: number): boolean {
    this.windowBusyMs += wallMs;
    this.windowTicks += ticks;
    if (solves > 0) {
      const perSolve = wallMs / solves;
      this.values.lastSolveMs = perSolve;
      this.values.solveCount += solves;
      if (perSolve > this.windowMaxSolveMs) this.windowMaxSolveMs = perSolve;
    }
    return this.roll();
  }

  /** A cadence publish was skipped by the throttle. */
  throttled(): void {
    this.values.throttledPublishes++;
  }

  /** Closes the window if a second has passed; returns whether the values changed enough to write. */
  roll(): boolean {
    const now = this.clock.now();
    const elapsed = now - this.windowStart;
    if (elapsed < WINDOW_MS) return false;
    this.values.maxSolveMs = this.windowMaxSolveMs;
    this.values.meanTickUs = this.windowTicks > 0 ? (1000 * this.windowBusyMs) / this.windowTicks : 0;
    this.values.ticksPerSecond = (1000 * this.windowTicks) / elapsed;
    this.values.busyFraction = Math.min(1, this.windowBusyMs / elapsed);
    this.windowStart = now;
    this.windowBusyMs = 0;
    this.windowTicks = 0;
    this.windowMaxSolveMs = 0;
    return true;
  }
}
