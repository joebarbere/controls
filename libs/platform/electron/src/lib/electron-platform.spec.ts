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
    ...overrides,
  };
}

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
