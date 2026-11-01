/**
 * Renderer process crash recovery (ADR 0011 §10). When a window's renderer process dies, main reloads
 * the window at the recovery URL, where the menu offers Continue from the latest good autosave. A
 * crash loop (too many crashes in a short time) stops reloading and asks the player to Retry or Quit.
 * A renderer that stops responding gets a Wait or Reload prompt; Reload kills it, which is then a
 * crash like any other.
 *
 * Main never writes a save here: the recovery point is whatever the save directory already holds,
 * so the crash path can't lose or overwrite an autosave.
 *
 * No `electron` import: `main.ts` passes in the window's operations, so the unit tests drive it.
 */

/** Crashes within {@link CRASH_LOOP_WINDOW_MS} that stop the reloading: the third reload is not tried. */
export const CRASH_LOOP_LIMIT = 3;
/** The crash-loop window (numerical choice: long enough for a game that crashes on load to count). */
export const CRASH_LOOP_WINDOW_MS = 60_000;

/** Counts crashes in a sliding window. `now` is injected so the tests use a fake clock. */
export class CrashLoopLimiter {
  private crashes: number[] = [];

  constructor(
    private readonly limit: number = CRASH_LOOP_LIMIT,
    private readonly windowMs: number = CRASH_LOOP_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
  }

  /** Records a crash: `reload` while under the limit, `stop` once `limit` crashes fall inside the window. */
  record(): 'reload' | 'stop' {
    const at = this.now();
    this.crashes = [...this.crashes.filter((t) => at - t < this.windowMs), at];
    return this.crashes.length >= this.limit ? 'stop' : 'reload';
  }

  /** Forgets every crash (the player chose Retry). */
  reset(): void {
    this.crashes = [];
  }

  /** Crashes still inside the window (for tests). */
  get count(): number {
    const at = this.now();
    return this.crashes.filter((t) => at - t < this.windowMs).length;
  }
}

/** The `render-process-gone` reasons (Electron's `RenderProcessGoneDetails.reason`). */
export type RenderProcessGoneReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'launch-failed'
  | 'integrity-failure'
  | 'memory-eviction';

/** What the recovery needs from a window and from main. */
export interface RecoveryHost {
  /** The window (or its `WebContents`) is destroyed or closing: nothing to recover. */
  isGone(): boolean;
  /** Loads the recovery URL in the window. */
  reloadForRecovery(): void;
  /** Crash loop: a native dialog. Resolves with the player's choice. */
  askAfterCrashLoop(): Promise<'retry' | 'quit'>;
  /** Not responding: a native dialog, closed as `wait` if `signal` aborts (the page answered again). */
  askWhenUnresponsive(signal: AbortSignal): Promise<'wait' | 'reload'>;
  /** Kills the hung renderer (`forcefullyCrashRenderer`), which then reports `render-process-gone`. */
  killRenderer(): void;
  quit(): void;
  log(message: string): void;
}

/** One window's crash recovery. `main.ts` wires the `WebContents` events to these methods. */
export class RendererRecovery {
  private prompting = false;
  private unresponsive: AbortController | null = null;

  constructor(
    private readonly host: RecoveryHost,
    private readonly limiter: CrashLoopLimiter = new CrashLoopLimiter(),
  ) {}

  /** `render-process-gone`. Only a crash counts: a clean exit (the window closing) is not one. */
  onRenderProcessGone(reason: RenderProcessGoneReason, exitCode?: number): void {
    this.onResponsive(); // a dead renderer is not a hung one
    if (reason === 'clean-exit' || this.host.isGone()) return;
    this.host.log(`renderer process gone (${reason}${exitCode === undefined ? '' : `, exit ${exitCode}`})`);
    if (this.prompting) return; // the crash-loop dialog is already up; its answer decides
    if (this.limiter.record() === 'reload') {
      this.host.reloadForRecovery();
      return;
    }
    this.prompting = true;
    this.host.log(`crash loop: ${CRASH_LOOP_LIMIT} crashes within ${CRASH_LOOP_WINDOW_MS} ms, not reloading`);
    void this.host
      .askAfterCrashLoop()
      .catch(() => 'quit' as const)
      .then((choice) => {
        this.prompting = false;
        if (choice === 'quit') return this.host.quit();
        this.limiter.reset();
        if (!this.host.isGone()) this.host.reloadForRecovery();
      });
  }

  /** `unresponsive`: asks once whether to wait or reload, unless the page answers first. */
  onUnresponsive(): void {
    if (this.prompting || this.unresponsive !== null || this.host.isGone()) return;
    const controller = new AbortController();
    this.unresponsive = controller;
    this.host.log('renderer unresponsive');
    void this.host
      .askWhenUnresponsive(controller.signal)
      .catch(() => 'wait' as const)
      .then((choice) => {
        if (this.unresponsive !== controller) return; // answered again, or crashed, meanwhile
        this.unresponsive = null;
        if (choice === 'reload' && !controller.signal.aborted && !this.host.isGone()) this.host.killRenderer();
      });
  }

  /** `responsive`: the page answered again, so the not-responding dialog closes as Wait. */
  onResponsive(): void {
    const controller = this.unresponsive;
    this.unresponsive = null;
    controller?.abort();
  }
}
