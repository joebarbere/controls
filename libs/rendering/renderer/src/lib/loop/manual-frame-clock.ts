import type { FrameClock } from './render-loop';

/**
 * A {@link FrameClock} driven by hand, for tests: nothing happens until {@link tick} advances time
 * and runs the animation-frame callbacks (and timers) that are due. No real time or DOM involved.
 */
export class ManualFrameClock implements FrameClock {
  private time = 0;
  private nextHandle = 1;
  private readonly frameCallbacks = new Map<number, (timeMs: number) => void>();
  private readonly timers = new Map<number, { readonly at: number; readonly callback: () => void }>();

  /** Animation-frame callbacks waiting for the next tick. */
  get pendingFrames(): number {
    return this.frameCallbacks.size;
  }

  /** Timers not yet fired. */
  get pendingTimers(): number {
    return this.timers.size;
  }

  requestFrame(callback: (timeMs: number) => void): number {
    const handle = this.nextHandle++;
    this.frameCallbacks.set(handle, callback);
    return handle;
  }

  cancelFrame(handle: number): void {
    this.frameCallbacks.delete(handle);
  }

  now(): number {
    return this.time;
  }

  setTimer(callback: () => void, delayMs: number): number {
    const handle = this.nextHandle++;
    this.timers.set(handle, { at: this.time + delayMs, callback });
    return handle;
  }

  clearTimer(handle: number): void {
    this.timers.delete(handle);
  }

  /** Advances `ms` (one 60 Hz vsync by default), runs the frame callbacks requested before it, then due timers. */
  tick(ms = 16): void {
    this.time += ms;
    const due = [...this.frameCallbacks.values()];
    this.frameCallbacks.clear();
    due.forEach((callback) => callback(this.time));
    for (const [handle, timer] of [...this.timers]) {
      if (timer.at > this.time || !this.timers.has(handle)) continue;
      this.timers.delete(handle);
      timer.callback();
    }
  }

  /** Ticks `count` times. */
  ticks(count: number, ms = 16): void {
    for (let i = 0; i < count; i++) this.tick(ms);
  }

  /** Advances clock time without a vsync (work done inside a frame). */
  advance(ms: number): void {
    this.time += ms;
  }
}
