import {
  CRASH_LOOP_LIMIT,
  CRASH_LOOP_WINDOW_MS,
  CrashLoopLimiter,
  RendererRecovery,
  type RecoveryHost,
} from './crash-recovery';

/** A fake clock for the limiter. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

/** A fake host whose dialogs resolve when the test answers them. */
function host(state: { gone?: boolean } = {}) {
  const calls: string[] = [];
  let answerLoop: ((choice: 'retry' | 'quit') => void) | undefined;
  let answerHang: ((choice: 'wait' | 'reload') => void) | undefined;
  let hangSignal: AbortSignal | undefined;
  const h: RecoveryHost = {
    isGone: () => !!state.gone,
    reloadForRecovery: () => void calls.push('reload'),
    askAfterCrashLoop: () => {
      calls.push('ask-loop');
      return new Promise((resolve) => (answerLoop = resolve));
    },
    askWhenUnresponsive: (signal) => {
      calls.push('ask-hang');
      hangSignal = signal;
      return new Promise((resolve) => {
        answerHang = resolve;
        signal.addEventListener('abort', () => resolve('wait'));
      });
    },
    killRenderer: () => void calls.push('kill'),
    quit: () => void calls.push('quit'),
    log: () => undefined,
  };
  return {
    h,
    calls,
    answerLoop: async (choice: 'retry' | 'quit') => {
      answerLoop?.(choice);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    answerHang: async (choice: 'wait' | 'reload') => {
      answerHang?.(choice);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    hangSignal: () => hangSignal,
  };
}

describe('CrashLoopLimiter', () => {
  it('reloads under the limit and stops at the limit within the window', () => {
    const c = clock();
    const limiter = new CrashLoopLimiter(3, 60_000, c.now);
    expect(limiter.record()).toBe('reload');
    c.advance(1000);
    expect(limiter.record()).toBe('reload');
    c.advance(1000);
    expect(limiter.record()).toBe('stop');
  });

  it('forgets crashes once they leave the window', () => {
    const c = clock();
    const limiter = new CrashLoopLimiter(3, 60_000, c.now);
    limiter.record();
    c.advance(30_000);
    limiter.record();
    c.advance(30_000); // the first crash is now exactly the window old: out
    expect(limiter.count).toBe(1);
    expect(limiter.record()).toBe('reload');
    c.advance(29_999); // the second crash is 59 999 ms old: still in
    expect(limiter.record()).toBe('stop'); // three inside the last 60 s
  });

  it('starts over after reset', () => {
    const c = clock();
    const limiter = new CrashLoopLimiter(2, 60_000, c.now);
    limiter.record();
    expect(limiter.record()).toBe('stop');
    limiter.reset();
    expect(limiter.count).toBe(0);
    expect(limiter.record()).toBe('reload');
  });

  it('refuses a limit that is not a positive integer', () => {
    expect(() => new CrashLoopLimiter(0)).toThrow(RangeError);
    expect(() => new CrashLoopLimiter(1.5)).toThrow(RangeError);
  });

  it('defaults to the documented limit and window', () => {
    const c = clock();
    const limiter = new CrashLoopLimiter(undefined, undefined, c.now);
    for (let i = 1; i < CRASH_LOOP_LIMIT; i++) expect(limiter.record()).toBe('reload');
    expect(limiter.record()).toBe('stop');
    limiter.reset();
    for (let i = 1; i < CRASH_LOOP_LIMIT; i++) {
      expect(limiter.record()).toBe('reload');
      c.advance(CRASH_LOOP_WINDOW_MS);
    }
    expect(limiter.record()).toBe('reload'); // spread out: never a loop
  });
});

describe('RendererRecovery', () => {
  const limiter = (c = clock()) => new CrashLoopLimiter(3, 60_000, c.now);

  it('reloads after a crash and ignores a clean exit', () => {
    const f = host();
    const recovery = new RendererRecovery(f.h, limiter());
    recovery.onRenderProcessGone('clean-exit', 0);
    expect(f.calls).toEqual([]);
    recovery.onRenderProcessGone('crashed', 139);
    recovery.onRenderProcessGone('oom');
    expect(f.calls).toEqual(['reload', 'reload']);
  });

  it('does nothing for a window that is gone', () => {
    const f = host({ gone: true });
    new RendererRecovery(f.h, limiter()).onRenderProcessGone('crashed');
    expect(f.calls).toEqual([]);
  });

  it('stops reloading at the limit, asks once, and Retry reloads with the count reset', async () => {
    const f = host();
    const recovery = new RendererRecovery(f.h, limiter());
    recovery.onRenderProcessGone('crashed');
    recovery.onRenderProcessGone('crashed');
    recovery.onRenderProcessGone('crashed');
    expect(f.calls).toEqual(['reload', 'reload', 'ask-loop']);
    recovery.onRenderProcessGone('crashed'); // while the dialog is up: no second dialog, no reload
    expect(f.calls).toEqual(['reload', 'reload', 'ask-loop']);
    await f.answerLoop('retry');
    expect(f.calls).toEqual(['reload', 'reload', 'ask-loop', 'reload']);
    recovery.onRenderProcessGone('crashed'); // a fresh window of crashes
    expect(f.calls.at(-1)).toBe('reload');
  });

  it('Quit after a crash loop quits', async () => {
    const f = host();
    const recovery = new RendererRecovery(f.h, limiter());
    for (let i = 0; i < 3; i++) recovery.onRenderProcessGone('killed');
    await f.answerLoop('quit');
    expect(f.calls).toEqual(['reload', 'reload', 'ask-loop', 'quit']);
  });

  it('asks once while unresponsive; Reload kills the renderer', async () => {
    const f = host();
    const recovery = new RendererRecovery(f.h, limiter());
    recovery.onUnresponsive();
    recovery.onUnresponsive();
    expect(f.calls).toEqual(['ask-hang']);
    await f.answerHang('reload');
    expect(f.calls).toEqual(['ask-hang', 'kill']);
  });

  it('Wait keeps the renderer, and the page answering closes the dialog as Wait', async () => {
    const f = host();
    const recovery = new RendererRecovery(f.h, limiter());
    recovery.onUnresponsive();
    await f.answerHang('wait');
    recovery.onUnresponsive();
    recovery.onResponsive();
    expect(f.hangSignal()?.aborted).toBe(true);
    await f.answerHang('reload'); // too late: the dialog already closed as Wait
    expect(f.calls).toEqual(['ask-hang', 'ask-hang']);
  });

  it('a crash while the not-responding dialog is up closes it and reloads', async () => {
    const f = host();
    const recovery = new RendererRecovery(f.h, limiter());
    recovery.onUnresponsive();
    recovery.onRenderProcessGone('crashed');
    expect(f.hangSignal()?.aborted).toBe(true);
    await f.answerHang('reload');
    expect(f.calls).toEqual(['ask-hang', 'reload']);
  });
});
