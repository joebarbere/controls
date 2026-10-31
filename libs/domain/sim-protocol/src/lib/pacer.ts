import { BEHIND_CLEAR_RATIO, BEHIND_RAISE_RATIO, EFFECTIVE_SPEED_WINDOW_MS, MAX_LEAD_WALL_MS } from './timing';

/*
 * The pacing policy (ADR 0011 §2): a pure class that turns wall time into integer tick targets.
 * The main thread owns the clock (D1); `SimHost` calls `target` from its pacing loop with the wall
 * time read through its injected clock. Wall-clock floats decide only which integer tick to advance
 * to: everything that reaches the bus, the log, the worker and the hash is an integer tick.
 */

/** One pacing decision. */
export interface PaceDecision {
  /** The tick to advance the bus and the worker to, or `null` to stay. */
  readonly advanceTo: number | null;
  /** Ticks dropped this call because the worker's progress capped the target (no catch-up spiral). */
  readonly dropped: number;
}

/**
 * Targets for one speed and anchor. `desired = anchorTick + floor((now − anchorWall) × speed)`,
 * capped at `progress + speed × maxLeadWallMs` so the commanded tick never runs far ahead of what
 * the worker has shown. Time lost to the cap is dropped by re-anchoring, so a slow plant degrades
 * to its achievable speed instead of spiralling.
 */
export class Pacer {
  private speedValue = 0;
  private anchorTick = 0;
  private anchorWallMs = 0;

  constructor(private readonly maxLeadWallMs = MAX_LEAD_WALL_MS) {}

  /** The requested speed (0 paused, 1, 10 or 60). */
  get speed(): number {
    return this.speedValue;
  }

  /** Sets the speed and re-anchors at (`tick`, `nowMs`): `sim.setSpeed`, `sim.resume`, a step, a resume from suspend. */
  setSpeed(speed: number, nowMs: number, tick: number): void {
    if (!Number.isFinite(speed) || speed < 0) throw new RangeError(`speed must be finite and ≥ 0, got ${speed}`);
    this.speedValue = speed;
    this.anchor(nowMs, tick);
  }

  /** Re-anchors at (`tick`, `nowMs`) without changing the speed. */
  anchor(nowMs: number, tick: number): void {
    if (!Number.isSafeInteger(tick) || tick < 0)
      throw new RangeError(`anchor tick must be a safe integer ≥ 0, got ${tick}`);
    this.anchorTick = tick;
    this.anchorWallMs = nowMs;
  }

  /**
   * The pacing step at wall time `nowMs`, with the worker's `progress` (the latest snapshot's tick)
   * and the bus's `current` tick. Never returns a tick at or below `current`.
   */
  target(nowMs: number, progress: number, current: number): PaceDecision {
    const speed = this.speedValue;
    if (speed <= 0) return { advanceTo: null, dropped: 0 };
    const elapsed = Math.max(0, nowMs - this.anchorWallMs);
    const desired = this.anchorTick + Math.floor(elapsed * speed);
    const capped = Math.min(desired, progress + Math.floor(speed * this.maxLeadWallMs));
    const commanded = Math.max(capped, current);
    if (desired > commanded) this.anchor(nowMs, commanded); // drop the lost time
    return { advanceTo: capped > current ? capped : null, dropped: Math.max(0, desired - commanded) };
  }
}

/** One window's measurement. */
export interface SpeedSample {
  /** Δtick ÷ Δwall (ms) over the window: the achieved multiple of real time. */
  readonly effective: number;
  /** "Falling behind" after this window (with hysteresis). */
  readonly behind: boolean;
}

/**
 * The effective speed and the "falling behind" flag (ADR 0011 §2): Δtick ÷ Δwall over a window of
 * {@link EFFECTIVE_SPEED_WINDOW_MS}; behind when below {@link BEHIND_RAISE_RATIO} of the requested
 * speed for two windows in a row, cleared after one window at {@link BEHIND_CLEAR_RATIO} or better.
 * Held (reset) while suspended or held, and whenever the requested speed changes.
 */
export class SpeedMeter {
  private windowStartMs: number | null = null;
  private windowStartTick = 0;
  private slowWindows = 0;
  private behindValue = false;
  private effectiveValue = 0;

  constructor(private readonly windowMs = EFFECTIVE_SPEED_WINDOW_MS) {}

  get behind(): boolean {
    return this.behindValue;
  }

  get effective(): number {
    return this.effectiveValue;
  }

  /** Starts a fresh window (a speed change, a resume, a re-anchor after a step). Keeps `behind` cleared. */
  reset(nowMs: number, tick: number, effective = 0): void {
    this.windowStartMs = nowMs;
    this.windowStartTick = tick;
    this.slowWindows = 0;
    this.behindValue = false;
    this.effectiveValue = effective;
  }

  /**
   * Records the worker's progress at `nowMs` while running at `speed`. Returns the window's result
   * when a window closed, else `null`.
   */
  sample(nowMs: number, progress: number, speed: number): SpeedSample | null {
    if (this.windowStartMs === null) {
      this.reset(nowMs, progress, speed);
      return null;
    }
    const wall = nowMs - this.windowStartMs;
    if (wall < this.windowMs) return null;
    const effective = Math.max(0, progress - this.windowStartTick) / wall;
    this.effectiveValue = effective;
    this.windowStartMs = nowMs;
    this.windowStartTick = progress;
    if (speed <= 0) {
      this.slowWindows = 0;
      this.behindValue = false;
    } else if (effective < BEHIND_RAISE_RATIO * speed) {
      this.slowWindows++;
      if (this.slowWindows >= 2) this.behindValue = true;
    } else {
      this.slowWindows = 0;
      if (effective >= BEHIND_CLEAR_RATIO * speed) this.behindValue = false;
    }
    return { effective, behind: this.behindValue };
  }
}
