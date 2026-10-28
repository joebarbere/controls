/**
 * Frame-time measurement for the dev HUD. Allocation-free and clock-free: the render loop passes in
 * each frame's cost (and, for back-to-back frames, the interval since the previous one).
 *
 * The viewport renders on demand, so the gap between two frames is usually idle time, not frame
 * time. The HUD therefore reports what each frame **cost** (update + draw on the main thread), and
 * a frame rate only over frames that followed one another without a break (walking, orbit damping).
 * It reports the mean and worst per window (since the last `sample()`), so a slow first frame
 * (shader compilation) can't skew later readings the way a moving average would.
 */
export interface FrameTiming {
  /** Mean cost of the frames drawn in the window, ms (0 if none were). */
  readonly avgMs: number;
  /** Worst single frame cost in the window, ms. */
  readonly worstMs: number;
  /** Cost of the last frame drawn, ms (kept across windows, so an idle HUD still shows it). */
  readonly lastMs: number;
  /** 1000 / mean interval between back-to-back frames in the window; 0 when none ran back to back. */
  readonly fps: number;
  /** Frames drawn in the window. */
  readonly windowFrames: number;
  /** No frame was drawn in the window: the viewport is idle (rendering on demand). */
  readonly idle: boolean;
  /** Frames drawn since construction. */
  readonly frames: number;
}

export class FrameTimer {
  private costSum = 0;
  private worst = 0;
  private last = 0;
  private windowCount = 0;
  private intervalSum = 0;
  private intervalCount = 0;
  private count = 0;

  /**
   * Records a drawn frame that cost `costMs`. Pass `intervalMs` (time since the previous frame) only
   * when this frame directly followed it, as part of an animation; it feeds the frame rate.
   */
  record(costMs: number, intervalMs?: number): void {
    const cost = Math.max(0, costMs);
    this.last = cost;
    this.costSum += cost;
    if (cost > this.worst) this.worst = cost;
    this.windowCount++;
    this.count++;
    if (intervalMs !== undefined && intervalMs > 0) {
      this.intervalSum += intervalMs;
      this.intervalCount++;
    }
  }

  /** Timing for the current window, then starts a new one. */
  sample(): FrameTiming {
    const n = this.windowCount;
    const t: FrameTiming = {
      avgMs: n > 0 ? this.costSum / n : 0,
      worstMs: this.worst,
      lastMs: this.last,
      fps: this.intervalCount > 0 ? 1000 / (this.intervalSum / this.intervalCount) : 0,
      windowFrames: n,
      idle: n === 0,
      frames: this.count,
    };
    this.costSum = 0;
    this.worst = 0;
    this.windowCount = 0;
    this.intervalSum = 0;
    this.intervalCount = 0;
    return t;
  }
}
