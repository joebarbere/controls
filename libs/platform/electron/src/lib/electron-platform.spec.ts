import type { ControlsBridge } from '@controls/ipc-contract';
import { defaultSettings } from '@controls/save-format';
import { ElectronPlatform, findBridge } from './electron-platform';

const info = {
  appVersion: '0.1.0',
  platform: 'linux',
  arch: 'x64',
  isPackaged: true,
  versions: { electron: '45.0.0' },
} as const;

function bridge(overrides: Partial<ControlsBridge> = {}): ControlsBridge {
  return {
    getAppInfo: async () => ({ ...info }),
    getSettings: async () => ({ settings: defaultSettings(), fallbackReason: null }),
    setSettings: async () => undefined,
    quit: async () => undefined,
    onFlushRequest: () => () => undefined,
    ackFlush: async () => undefined,
    ...overrides,
  };
}

/** A bridge whose `app:flush-request` can be fired by the test, recording the acks. */
function flushBridge() {
  let listener: ((request: unknown) => void) | undefined;
  const acks: unknown[] = [];
  let acked: () => void = () => undefined;
  const b = bridge({
    onFlushRequest: (l) => ((listener = l), () => (listener = undefined)),
    ackFlush: async (ack) => {
      acks.push(ack);
      acked();
    },
  });
  /** Fires a request and resolves when the platform has acked it. */
  const request = (payload: unknown) =>
    new Promise<void>((resolve) => {
      acked = resolve;
      listener?.(payload);
    });
  return { bridge: b, acks, request, fire: (payload: unknown) => listener?.(payload) };
}

describe('ElectronAppLifecycle (flush before quit)', () => {
  it('acks a request at once when nothing is registered', async () => {
    const h = flushBridge();
    new ElectronPlatform(h.bridge);
    await h.request({ requestId: 4 });
    expect(h.acks).toEqual([{ requestId: 4, ok: true }]);
  });

  it('runs every registered flush and acks only after all have settled', async () => {
    const h = flushBridge();
    const platform = new ElectronPlatform(h.bridge);
    const done: string[] = [];
    let release: () => void = () => undefined;
    platform.lifecycle.onBeforeQuit(() => void done.push('sync'));
    platform.lifecycle.onBeforeQuit(
      () =>
        new Promise<void>((resolve) => {
          release = () => (done.push('async'), resolve());
        }),
    );
    const acked = h.request({ requestId: 1 });
    await Promise.resolve();
    expect(h.acks).toEqual([]); // still waiting for the async flush
    release();
    await acked;
    expect(done).toEqual(['sync', 'async']);
    expect(h.acks).toEqual([{ requestId: 1, ok: true }]);
  });

  it('acks ok: false when a flush fails, after the others ran', async () => {
    const h = flushBridge();
    const platform = new ElectronPlatform(h.bridge);
    const other = vi.fn();
    platform.lifecycle.onBeforeQuit(async () => Promise.reject(new Error('disk full')));
    platform.lifecycle.onBeforeQuit(other);
    await h.request({ requestId: 2 });
    expect(other).toHaveBeenCalledOnce();
    expect(h.acks).toEqual([{ requestId: 2, ok: false }]);
  });

  it('stops calling a flush once it is unregistered', async () => {
    const h = flushBridge();
    const platform = new ElectronPlatform(h.bridge);
    const flush = vi.fn();
    const off = platform.lifecycle.onBeforeQuit(flush);
    off();
    await h.request({ requestId: 3 });
    expect(flush).not.toHaveBeenCalled();
  });

  it('ignores a malformed request (main times out instead)', async () => {
    const h = flushBridge();
    const platform = new ElectronPlatform(h.bridge);
    const flush = vi.fn();
    platform.lifecycle.onBeforeQuit(flush);
    for (const bad of [undefined, {}, { requestId: -1 }, { requestId: 1, extra: 1 }]) h.fire(bad);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flush).not.toHaveBeenCalled();
    expect(h.acks).toEqual([]);
  });

  it('swallows a refused ack', async () => {
    let listener: ((request: unknown) => void) | undefined;
    const ackFlush = vi.fn(async () => Promise.reject(new Error('app:flush-ack refused (unknown-request).')));
    new ElectronPlatform(bridge({ onFlushRequest: (l) => ((listener = l), () => undefined), ackFlush }));
    listener?.({ requestId: 9 });
    await vi.waitFor(() => expect(ackFlush).toHaveBeenCalledOnce());
  });
});

describe('ElectronPlatform', () => {
  it('returns validated app info from the bridge', async () => {
    await expect(new ElectronPlatform(bridge()).getAppInfo()).resolves.toEqual(info);
  });

  it('rejects a malformed bridge response', async () => {
    const bad = bridge({ getAppInfo: async () => ({ nope: true }) as never });
    await expect(new ElectronPlatform(bad).getAppInfo()).rejects.toThrow();
  });

  it('quits through app:quit', () => {
    const quit = vi.fn(async () => undefined);
    const platform = new ElectronPlatform(bridge({ quit }));
    expect(platform.canQuit).toBe(true);
    platform.quit();
    expect(quit).toHaveBeenCalledOnce();
  });

  it('finds the bridge only when the preload installed it', () => {
    expect(findBridge({})).toBeUndefined();
    const b = bridge();
    expect(findBridge({ controls: b })).toBe(b);
  });
});

describe('ElectronSettingsService', () => {
  it('passes through valid settings and main’s fallback reason', async () => {
    const settings = { ...defaultSettings(), display: { units: 'metric', theme: 'light', reducedMotion: 'full' } };
    const platform = new ElectronPlatform(
      bridge({ getSettings: async () => ({ settings, fallbackReason: 'corrupt' }) }),
    );
    await expect(platform.settings.load()).resolves.toEqual({ settings, fallbackReason: 'corrupt' });
  });

  it.each([
    ['a malformed response', async () => ({ wrong: true })],
    ['a rejected call', async () => Promise.reject(new Error('ipc'))],
  ])('falls back to defaults on %s', async (_name, getSettings) => {
    const platform = new ElectronPlatform(bridge({ getSettings }));
    await expect(platform.settings.load()).resolves.toEqual({ settings: defaultSettings(), fallbackReason: 'corrupt' });
  });

  it('re-validates the settings and reports a newer version', async () => {
    const getSettings = async () => ({ settings: { ...defaultSettings(), settingsVersion: 3 }, fallbackReason: null });
    const platform = new ElectronPlatform(bridge({ getSettings }));
    await expect(platform.settings.load()).resolves.toEqual({
      settings: defaultSettings(),
      fallbackReason: 'unknown-version',
    });
  });

  it('saves through settings:set and surfaces a refusal', async () => {
    const setSettings = vi.fn(async () => undefined);
    await new ElectronPlatform(bridge({ setSettings })).settings.save(defaultSettings());
    expect(setSettings).toHaveBeenCalledWith(defaultSettings());
    const refusing = bridge({ setSettings: async () => Promise.reject(new Error('settings:set refused (invalid).')) });
    await expect(new ElectronPlatform(refusing).settings.save(defaultSettings())).rejects.toThrow('refused');
  });
});
