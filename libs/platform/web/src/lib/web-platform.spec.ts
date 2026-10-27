import { AppInfoSchema, serialiseSettings } from '@controls/ipc-contract';
import { defaultSettings } from '@controls/save-format';
import { APP_VERSION } from '@controls/units';
import { WEB_SETTINGS_KEY, WebPlatform, WebSettingsService, type SettingsStorage } from './web-platform';

class MemoryStorage implements SettingsStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

describe('WebPlatform', () => {
  it('reports a schema-valid web app info with the build version', async () => {
    const info = await new WebPlatform().getAppInfo();
    expect(AppInfoSchema.parse(info)).toEqual(info);
    expect(info.appVersion).toBe(APP_VERSION);
  });

  it('cannot quit (a tab cannot close itself), and quit is a harmless no-op', () => {
    const platform = new WebPlatform();
    expect(platform.canQuit).toBe(false);
    expect(() => platform.quit()).not.toThrow();
  });
});

describe('WebSettingsService', () => {
  it('reports missing on first run, then round-trips what it saved', async () => {
    const storage = new MemoryStorage();
    const service = new WebSettingsService(() => storage);
    await expect(service.load()).resolves.toEqual({ settings: defaultSettings(), fallbackReason: 'missing' });
    const settings = { ...defaultSettings(), controls: { lookSensitivity: 1.5, invertY: true, keybindings: {} } };
    await service.save(settings);
    expect(storage.items.get(WEB_SETTINGS_KEY)).toBe(serialiseSettings(settings));
    await expect(service.load()).resolves.toEqual({ settings, fallbackReason: null });
  });

  it.each([
    ['corrupt JSON', '{{', 'corrupt'],
    ['a newer version', JSON.stringify({ ...defaultSettings(), settingsVersion: 2 }), 'unknown-version'],
  ])('falls back to defaults for %s', async (_name, stored, reason) => {
    const storage = new MemoryStorage();
    storage.setItem(WEB_SETTINGS_KEY, stored);
    await expect(new WebSettingsService(() => storage).load()).resolves.toEqual({
      settings: defaultSettings(),
      fallbackReason: reason,
    });
  });

  it('treats unavailable or throwing storage as a first run, and rejects saves it cannot make', async () => {
    const throwing: SettingsStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    await expect(new WebSettingsService(() => throwing).load()).resolves.toMatchObject({ fallbackReason: 'missing' });
    await expect(new WebSettingsService(() => throwing).save(defaultSettings())).rejects.toThrow('Quota');
    await expect(new WebSettingsService(() => undefined).save(defaultSettings())).rejects.toThrow('not available');
    await expect(new WebSettingsService(() => undefined).load()).resolves.toMatchObject({ fallbackReason: 'missing' });
  });
});
