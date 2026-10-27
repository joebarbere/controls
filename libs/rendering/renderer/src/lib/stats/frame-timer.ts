/**
 * Frame-time measurement for the dev HUD. Fed a monotonic timestamp each frame; allocation-free.
 * Reports the mean and worst frame over the current window (since the last `sample()`), so a slow
 * first frame (shader compilation) can't skew later readings the way a moving average would.
 */
export interface FrameTiming {
  /** Mean frame time over the window, ms (0 if the window is empty). */
  readonly avgMs: number;
  /** Worst single frame in the window, ms. */
  readonly worstMs: number;
  /** 1000 / avgMs. */
  readonly fps: number;
  /** Frames counted since construction. */
  readonly frames: number;
}

export class FrameTimer {
  private last = -1;
  private windowSum = 0;
  private windowCount = 0;
  private worst = 0;
  private count = 0;

  /** Records a frame at `nowMs`. Returns the frame's duration (0 for the first frame). */
  tick(nowMs: number): number {
    if (this.last < 0) {
      this.last = nowMs;
      return 0;
    }
    const dt = Math.max(0, nowMs - this.last);
    this.last = nowMs;
    this.windowSum += dt;
    this.windowCount++;
    if (dt > this.worst) this.worst = dt;
    this.count++;
    return dt;
  }

  /** Timing for the current window, then starts a new one. */
  sample(): FrameTiming {
    const avg = this.windowCount > 0 ? this.windowSum / this.windowCount : 0;
    const t = { avgMs: avg, worstMs: this.worst, fps: avg > 0 ? 1000 / avg : 0, frames: this.count };
    this.windowSum = 0;
    this.windowCount = 0;
    this.worst = 0;
    return t;
  }
}
