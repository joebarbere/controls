/**
 * On-demand frame scheduling for the viewport. GPU-free (the drawing is a callback), so the rule
 * "an idle viewport draws nothing, and every change draws" is unit-tested in Node with a fake clock.
 *
 * A frame runs only when something asked for one: {@link RenderLoop.requestRender} (any number of
 * calls before the frame coalesce into one), or the previous frame's `update` returning `true`
 * because an animation hasn't settled (a held walk key, orbit damping). With nothing pending, no
 * `requestAnimationFrame` is outstanding at all: the page's main thread is free, which is what makes
 * idle e2e round trips cheap under software WebGL and saves battery on real machines.
 */
import { FrameTimer, type FrameTiming } from '../stats/frame-timer';

/** The browser services the loop uses, injected so tests can drive frames and time by hand. */
export interface FrameClock {
  requestFrame(callback: (timeMs: number) => void): number;
  cancelFrame(handle: number): void;
  /** Monotonic milliseconds, the same time origin as the frame callback's timestamp. */
  now(): number;
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(handle: number): void;
}

export interface RenderLoopOptions {
  /**
   * Advances view state by `dtSeconds` (0 for a frame that follows idle time, so nothing jumps) and
   * returns whether it needs another frame: an animation that hasn't settled.
   */
  readonly update: (dtSeconds: number) => boolean;
  /** Draws the current scene. */
  readonly draw: () => void;
  readonly clock: FrameClock;
  /**
   * Called at most every `statsIntervalMs` while frames are drawn, and once more after the loop
   * goes idle (so a HUD can say so). Read the numbers with {@link RenderLoop.sampleTiming}.
   */
  readonly onStats?: () => void;
  readonly statsIntervalMs?: number;
}

/** A frame clock on a browser window (`requestAnimationFrame`, `performance.now`, `setTimeout`). */
export function windowFrameClock(view: Window): FrameClock {
  return {
    requestFrame: (cb) => view.requestAnimationFrame(cb),
    cancelFrame: (h) => view.cancelAnimationFrame(h),
    now: () => view.performance.now(),
    setTimer: (cb, ms) => view.setTimeout(cb, ms),
    clearTimer: (h) => view.clearTimeout(h),
  };
}

export const DEFAULT_STATS_INTERVAL_MS = 500;

export class RenderLoop {
  private readonly timer = new FrameTimer();
  private readonly statsIntervalMs: number;
  private handle: number | null = null;
  private statsTimer: number | null = null;
  /** The last frame asked for another (an animation), so the next one is back to back. */
  private continuing = false;
  private lastFrameMs = -1;
  private lastStatsMs = Number.NEGATIVE_INFINITY;
  private framesAtLastStats = 0;
  private drawn = 0;
  private disposed = false;
  private readonly frameWaiters: Array<{ until: number; resolve: () => void }> = [];
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly options: RenderLoopOptions) {
    this.statsIntervalMs = options.statsIntervalMs ?? DEFAULT_STATS_INTERVAL_MS;
  }

  /** Frames drawn since construction. */
  get frames(): number {
    return this.drawn;
  }

  /** Whether a frame is scheduled (the loop is not idle). */
  get pending(): boolean {
    return this.handle !== null;
  }

  /** Asks for one frame. Cheap and idempotent: calls before the frame runs coalesce into it. */
  requestRender(): void {
    if (this.disposed || this.handle !== null) return;
    this.handle = this.options.clock.requestFrame(this.onFrame);
  }

  /**
   * Updates and draws right now, in this task: after a resize (which clears the canvas, so waiting
   * for the next animation frame would show a blank one) and for a thumbnail (the drawing buffer is
   * only readable in the task that drew it). A frame already scheduled still runs.
   */
  renderNow(): void {
    if (this.disposed) return;
    if (this.runFrame(0)) this.requestRender();
  }

  /** Timing for the HUD since the last sample; starts a new window. */
  sampleTiming(): FrameTiming {
    return this.timer.sample();
  }

  /** Resolves after `count` more frames have been drawn, requesting them if nothing else does (tests). */
  afterFrames(count: number): Promise<void> {
    if (this.disposed || count <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.frameWaiters.push({ until: this.drawn + count, resolve });
      this.requestRender();
    });
  }

  /** Resolves once no frame is scheduled: everything requested so far has been drawn (tests). */
  whenIdle(): Promise<void> {
    if (this.disposed || this.handle === null) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.handle !== null) this.options.clock.cancelFrame(this.handle);
    this.handle = null;
    if (this.statsTimer !== null) this.options.clock.clearTimer(this.statsTimer);
    this.statsTimer = null;
    this.frameWaiters.splice(0).forEach((w) => w.resolve());
    this.idleWaiters.splice(0).forEach((resolve) => resolve());
  }

  private readonly onFrame = (timeMs: number): void => {
    this.handle = null;
    if (this.disposed) return;
    const backToBack = this.continuing && this.lastFrameMs >= 0;
    const intervalMs = backToBack ? Math.max(0, timeMs - this.lastFrameMs) : undefined;
    this.lastFrameMs = timeMs;
    this.continuing = this.runFrame(intervalMs === undefined ? 0 : intervalMs / 1000, intervalMs);
    if (this.continuing) this.requestRender();
    this.settleWaiters();
    this.maybeEmitStats();
  };

  /** One update + draw. Returns whether the update wants another frame. */
  private runFrame(dtSeconds: number, intervalMs?: number): boolean {
    const clock = this.options.clock;
    const start = clock.now();
    const more = this.options.update(dtSeconds);
    this.options.draw();
    this.timer.record(clock.now() - start, intervalMs);
    this.drawn++;
    return more;
  }

  private settleWaiters(): void {
    for (let i = this.frameWaiters.length - 1; i >= 0; i--) {
      const w = this.frameWaiters[i];
      if (this.drawn >= w.until) {
        this.frameWaiters.splice(i, 1);
        w.resolve();
      }
    }
    if (this.frameWaiters.length > 0) this.requestRender();
    if (this.handle === null && this.idleWaiters.length > 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  }

  private maybeEmitStats(): void {
    if (!this.options.onStats) return;
    if (this.options.clock.now() - this.lastStatsMs >= this.statsIntervalMs) this.emitStats();
    // Going idle: one more report after the interval, so the HUD shows "idle" rather than stale numbers.
    if (this.handle === null && this.statsTimer === null) this.armStatsTimer();
  }

  private armStatsTimer(): void {
    this.statsTimer = this.options.clock.setTimer(() => {
      this.statsTimer = null;
      if (this.disposed) return;
      const drewSince = this.drawn !== this.framesAtLastStats;
      this.emitStats();
      // Frames drawn since the last report: report again, until a window with none (idle).
      if (drewSince && this.handle === null) this.armStatsTimer();
    }, this.statsIntervalMs);
  }

  private emitStats(): void {
    this.lastStatsMs = this.options.clock.now();
    this.framesAtLastStats = this.drawn;
    this.options.onStats?.();
  }
}
