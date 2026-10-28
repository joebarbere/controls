import { FLUSH_BEFORE_QUIT_TIMEOUT_MS, IpcChannel, type FlushRequest } from '@controls/ipc-contract';
import {
  FlushCoordinator,
  QuitGuard,
  type FlushTarget,
  type GuardedWindow,
  type PreventableEvent,
  type QuittableApp,
} from './flush-before-quit';

const APP_URL = 'app://game/index.html';

/** A fake WebContents that records the requests it was sent. */
function target(id = 1, state: { destroyed?: boolean; crashed?: boolean; sendThrows?: boolean } = {}) {
  const sent: FlushRequest[] = [];
  const t: FlushTarget & { sent: FlushRequest[] } = {
    id,
    sent,
    isDestroyed: () => !!state.destroyed,
    isCrashed: () => !!state.crashed,
    send: (channel, request) => {
      expect(channel).toBe(IpcChannel.FlushRequest);
      if (state.sendThrows) throw new Error('Object has been destroyed');
      sent.push(request);
    },
  };
  return t;
}

const ackFrom = (id: number, url = APP_URL) => ({ sender: { id }, senderFrame: { url } });

describe('FlushCoordinator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends a request and settles on the matching ack', async () => {
    const coordinator = new FlushCoordinator();
    const t = target(3);
    const outcome = coordinator.request(t);
    expect(t.sent).toEqual([{ requestId: 1 }]);
    coordinator.acknowledge(ackFrom(3), { requestId: 1, ok: true });
    await expect(outcome).resolves.toBe('flushed');
    expect(coordinator.pendingCount).toBe(0);
  });

  it('reports a renderer-side failure as failed', async () => {
    const coordinator = new FlushCoordinator();
    const outcome = coordinator.request(target());
    coordinator.acknowledge(ackFrom(1), { requestId: 1, ok: false });
    await expect(outcome).resolves.toBe('failed');
  });

  it('times out when the renderer never answers, so quitting is never blocked', async () => {
    const coordinator = new FlushCoordinator();
    const outcome = coordinator.request(target());
    await vi.advanceTimersByTimeAsync(FLUSH_BEFORE_QUIT_TIMEOUT_MS - 1);
    expect(coordinator.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toBe('timeout');
    expect(coordinator.pendingCount).toBe(0);
    // A late ack is refused rather than settling anything.
    expect(() => coordinator.acknowledge(ackFrom(1), { requestId: 1, ok: true })).toThrow('unknown-request');
  });

  it('does not wait for a destroyed or crashed renderer, or one that is destroyed mid-send', async () => {
    const coordinator = new FlushCoordinator();
    await expect(coordinator.request(target(1, { destroyed: true }))).resolves.toBe('gone');
    await expect(coordinator.request(target(1, { crashed: true }))).resolves.toBe('gone');
    await expect(coordinator.request(target(1, { sendThrows: true }))).resolves.toBe('gone');
    expect(coordinator.pendingCount).toBe(0);
  });

  it.each([
    ['another origin', ackFrom(1, 'https://evil.example/')],
    ['a look-alike host', ackFrom(1, 'app://gamex/index.html')],
    ['file://', ackFrom(1, 'file:///etc/passwd')],
    ['no frame', { sender: { id: 1 }, senderFrame: null }],
  ])('refuses an ack from an untrusted sender (%s) and keeps waiting', async (_name, event) => {
    const coordinator = new FlushCoordinator();
    const outcome = coordinator.request(target());
    expect(() => coordinator.acknowledge(event, { requestId: 1, ok: true })).toThrow(/untrusted origin/);
    expect(coordinator.pendingCount).toBe(1);
    coordinator.acknowledge(ackFrom(1), { requestId: 1, ok: true });
    await expect(outcome).resolves.toBe('flushed');
  });

  it('refuses an ack from a different WebContents than the one asked', () => {
    const coordinator = new FlushCoordinator();
    void coordinator.request(target(1));
    expect(() => coordinator.acknowledge(ackFrom(2), { requestId: 1, ok: true })).toThrow('unknown-request');
    expect(coordinator.pendingCount).toBe(1);
  });

  it('refuses a malformed ack without echoing it', () => {
    const coordinator = new FlushCoordinator();
    void coordinator.request(target());
    let message = '';
    try {
      coordinator.acknowledge(ackFrom(1), { requestId: 1, ok: 'do-not-echo' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('app:flush-ack refused (invalid).');
    expect(() => coordinator.acknowledge(ackFrom(1), { requestId: 99, ok: true })).toThrow('unknown-request');
    expect(coordinator.pendingCount).toBe(1);
  });
});

/** Fake BrowserWindow and app wired to a coordinator, with helpers to fire their events. */
function harness() {
  const coordinator = new FlushCoordinator();
  const closeListeners = new Map<GuardedWindow, (e: PreventableEvent) => void>();
  const windows: (GuardedWindow & { closed: boolean; webContents: ReturnType<typeof target> })[] = [];
  let beforeQuit: ((e: PreventableEvent) => void) | undefined;
  const quitted: boolean[] = [];
  const event = () => {
    const e = { prevented: false, preventDefault: () => void (e.prevented = true) };
    return e;
  };
  const app: QuittableApp = {
    on: (_name, listener) => (beforeQuit = listener),
    quit: () => {
      const e = event();
      beforeQuit?.(e);
      if (e.prevented) return;
      for (const w of windows) fire(w); // Electron closes every window as part of quitting
      quitted.push(true);
    },
  };
  /** Emits `close`; the window closes unless a listener prevents it. */
  const fire = (w: (typeof windows)[number]) => {
    if (w.closed) return;
    const e = event();
    closeListeners.get(w)?.(e);
    if (!e.prevented) w.closed = true;
  };
  const log = vi.fn();
  const guard = new QuitGuard(app, () => windows.filter((w) => !w.closed), coordinator, log);
  guard.install();
  const addWindow = (id: number) => {
    const w = {
      closed: false,
      webContents: target(id),
      on: (_name: 'close', listener: (e: PreventableEvent) => void) => closeListeners.set(w, listener),
      close: () => fire(w),
      isDestroyed: () => w.closed,
    };
    windows.push(w);
    guard.guardWindow(w);
    return w;
  };
  const ackAll = (ok = true) => {
    for (const w of windows)
      for (const r of w.webContents.sent.splice(0)) coordinator.acknowledge(ackFrom(w.webContents.id), { ...r, ok });
  };
  return { app, addWindow, ackAll, quitted, log, coordinator };
}

describe('QuitGuard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('holds a window close until the renderer has flushed', async () => {
    const h = harness();
    const w = h.addWindow(1);
    w.close();
    expect(w.closed).toBe(false);
    expect(w.webContents.sent).toHaveLength(1);
    h.ackAll();
    await vi.runAllTimersAsync();
    expect(w.closed).toBe(true);
  });

  it('asks once when close is requested twice while flushing', async () => {
    const h = harness();
    const w = h.addWindow(1);
    w.close();
    w.close();
    expect(w.webContents.sent).toHaveLength(1);
    h.ackAll();
    await vi.runAllTimersAsync();
    expect(w.closed).toBe(true);
  });

  it('holds app.quit() (menu Quit, Cmd+Q, window-all-closed) until every window has flushed', async () => {
    const h = harness();
    const a = h.addWindow(1);
    const b = h.addWindow(2);
    h.app.quit();
    expect(h.quitted).toEqual([]);
    expect(a.webContents.sent).toHaveLength(1);
    expect(b.webContents.sent).toHaveLength(1);
    h.app.quit(); // a second Cmd+Q while flushing neither re-asks nor quits early
    expect(a.webContents.sent).toHaveLength(1);
    expect(h.quitted).toEqual([]);
    h.ackAll();
    await vi.runAllTimersAsync();
    expect(h.quitted).toEqual([true]);
    expect(a.closed && b.closed).toBe(true);
    // Windows closing as part of the quit were not asked again.
    expect(a.webContents.sent).toHaveLength(0);
  });

  it('quits after the timeout when a renderer is hung, and logs it', async () => {
    const h = harness();
    h.addWindow(1);
    h.app.quit();
    await vi.advanceTimersByTimeAsync(FLUSH_BEFORE_QUIT_TIMEOUT_MS);
    expect(h.quitted).toEqual([true]);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('in time'));
  });

  it('closes a hung window after the timeout', async () => {
    const h = harness();
    const w = h.addWindow(1);
    w.close();
    await vi.advanceTimersByTimeAsync(FLUSH_BEFORE_QUIT_TIMEOUT_MS);
    expect(w.closed).toBe(true);
  });

  it('a window closed during a quit shares the quit’s flush', async () => {
    const h = harness();
    const w = h.addWindow(1);
    h.app.quit();
    w.close();
    expect(w.webContents.sent).toHaveLength(1);
    h.ackAll();
    await vi.runAllTimersAsync();
    expect(h.quitted).toEqual([true]);
    expect(w.closed).toBe(true);
  });

  it('quits at once when no window is open (window-all-closed after a flushed close)', async () => {
    const h = harness();
    const w = h.addWindow(1);
    w.close();
    h.ackAll();
    await vi.runAllTimersAsync();
    h.app.quit();
    await vi.runAllTimersAsync();
    expect(h.quitted).toEqual([true]);
  });

  it('quits even if a flush failed in the renderer', async () => {
    const h = harness();
    h.addWindow(1);
    h.app.quit();
    h.ackAll(false);
    await vi.runAllTimersAsync();
    expect(h.quitted).toEqual([true]);
  });
});
