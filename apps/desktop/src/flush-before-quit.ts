import { FLUSH_BEFORE_QUIT_TIMEOUT_MS, FlushAckSchema, IpcChannel, type FlushRequest } from '@controls/ipc-contract';
import { assertTrustedSender, type IpcSender } from './ipc-handlers';

/**
 * Flush before quit: before a window closes or the app quits, main asks the renderer to finish its
 * pending writes (`app:flush-request`) and waits for `app:flush-ack`, or for a timeout, so a hung or
 * crashed renderer can't block quitting. Generic on purpose: debounced settings use it now, and
 * F1.8b's autosave-on-quit hooks into the same renderer-side registry (`Platform.lifecycle`).
 *
 * No `electron` import: `main.ts` passes in `app` and the windows, so the unit tests drive it.
 */

/** The part of a `WebContents` the coordinator needs. */
export interface FlushTarget {
  readonly id: number;
  isDestroyed(): boolean;
  isCrashed(): boolean;
  send(channel: typeof IpcChannel.FlushRequest, request: FlushRequest): void;
}

/** `flushed`: acknowledged ok. `failed`: acknowledged, a flush failed. `timeout`: no ack in time. `gone`: no live renderer. */
export type FlushOutcome = 'flushed' | 'failed' | 'timeout' | 'gone';

/** The part of an `IpcMainInvokeEvent` an ack is checked against. */
export interface FlushAckEvent extends IpcSender {
  readonly sender: { readonly id: number };
}

interface PendingFlush {
  readonly targetId: number;
  readonly settle: (outcome: FlushOutcome) => void;
}

/** Sends flush requests and matches acks to them (by request id **and** the asking `WebContents`). */
export class FlushCoordinator {
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingFlush>();

  constructor(private readonly timeoutMs: number = FLUSH_BEFORE_QUIT_TIMEOUT_MS) {}

  /** Asks `target` to flush. Never rejects: every path ends in a {@link FlushOutcome}. */
  request(target: FlushTarget): Promise<FlushOutcome> {
    if (target.isDestroyed() || target.isCrashed()) return Promise.resolve('gone');
    const requestId = this.nextRequestId++;
    return new Promise<FlushOutcome>((resolve) => {
      const timer = setTimeout(() => settle('timeout'), this.timeoutMs);
      const settle = (outcome: FlushOutcome) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(outcome);
      };
      this.pending.set(requestId, { targetId: target.id, settle });
      try {
        target.send(IpcChannel.FlushRequest, { requestId });
      } catch {
        settle('gone'); // destroyed between the check and the send
      }
    });
  }

  /**
   * `app:flush-ack` handler. Refuses an untrusted origin, a malformed payload, and an ack for a
   * request that is unknown, already settled or was sent to another `WebContents`. Errors carry a
   * reason only, never the payload.
   */
  acknowledge(event: FlushAckEvent, payload: unknown): void {
    assertTrustedSender(event);
    const parsed = FlushAckSchema.safeParse(payload);
    if (!parsed.success) throw new Error('app:flush-ack refused (invalid).');
    const pending = this.pending.get(parsed.data.requestId);
    if (!pending || pending.targetId !== event.sender.id) throw new Error('app:flush-ack refused (unknown-request).');
    pending.settle(parsed.data.ok ? 'flushed' : 'failed');
  }

  /** Requests still waiting for an ack (for tests). */
  get pendingCount(): number {
    return this.pending.size;
  }
}

/** A preventable Electron event (`close`, `before-quit`). */
export interface PreventableEvent {
  preventDefault(): void;
}

/** The part of a `BrowserWindow` the guard needs. */
export interface GuardedWindow {
  readonly webContents: FlushTarget;
  on(event: 'close', listener: (event: PreventableEvent) => void): unknown;
  close(): void;
  isDestroyed(): boolean;
}

/** The part of Electron's `app` the guard needs. */
export interface QuittableApp {
  on(event: 'before-quit', listener: (event: PreventableEvent) => void): unknown;
  quit(): void;
}

/**
 * Holds back window close and app quit until the renderer has flushed. Covers every path:
 * - closing a window (title-bar button, Cmd+W, `window.close()`): its `close` event;
 * - the menu's Quit (`app:quit` → `app.quit()`), Cmd+Q, the Dock and `window-all-closed` → `app.quit()`:
 *   `before-quit`, which flushes every window still open.
 * Each path prevents the default once, flushes, then repeats the close or quit, which passes.
 */
export class QuitGuard {
  private quitState: 'running' | 'flushing' | 'quitting' = 'running';
  /** In-flight flush per window, so a close during a quit (or a double click) asks once. */
  private readonly flushing = new WeakMap<GuardedWindow, Promise<FlushOutcome>>();
  /** Windows that have flushed and may now close. */
  private readonly released = new WeakSet<GuardedWindow>();

  constructor(
    private readonly app: QuittableApp,
    private readonly windows: () => readonly GuardedWindow[],
    private readonly coordinator: FlushCoordinator,
    private readonly log: (message: string) => void = (message) => console.warn(message),
  ) {}

  /** Hooks `before-quit`. Call once, after the single-instance lock is held. */
  install(): void {
    this.app.on('before-quit', (event) => {
      if (this.quitState === 'quitting') return;
      event.preventDefault();
      if (this.quitState === 'flushing') return; // a second Cmd+Q while flushing: the first one quits
      this.quitState = 'flushing';
      const open = this.windows().filter((w) => !w.isDestroyed());
      void Promise.all(open.map((w) => this.flush(w))).then(() => {
        this.quitState = 'quitting';
        for (const w of open) this.released.add(w);
        this.app.quit();
      });
    });
  }

  /** Hooks a window's `close`. Call for every window, right after creating it. */
  guardWindow(window: GuardedWindow): void {
    window.on('close', (event) => {
      if (this.quitState === 'quitting' || this.released.has(window)) return;
      event.preventDefault();
      if (this.flushing.has(window)) return;
      void this.flush(window).then(() => {
        this.released.add(window);
        // A quit that started meanwhile closes the window itself.
        if (this.quitState === 'running' && !window.isDestroyed()) window.close();
      });
    });
  }

  private flush(window: GuardedWindow): Promise<FlushOutcome> {
    let inFlight = this.flushing.get(window);
    if (!inFlight) {
      inFlight = this.coordinator.request(window.webContents).then((outcome) => {
        this.flushing.delete(window);
        if (outcome === 'timeout') this.log('Renderer did not finish its pending writes in time; closing anyway.');
        return outcome;
      });
      this.flushing.set(window, inFlight);
    }
    return inFlight;
  }
}
