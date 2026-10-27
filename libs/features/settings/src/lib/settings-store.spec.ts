import { TestBed } from '@angular/core/testing';
import { NotificationService } from '@controls/feature-shell';
import type { SettingsLoadResult, SettingsService } from '@controls/platform-api';
import { defaultSettings, type Settings } from '@controls/save-format';
import { MemorySettingsService, SETTINGS_SERVICE } from './settings-service';
import { SAVE_DEBOUNCE_MS, SettingsStore } from './settings-store';

class FakeService implements SettingsService {
  saved: Settings[] = [];
  private release: (() => void) | undefined;
  constructor(
    private readonly result: SettingsLoadResult | Error,
    gated = false,
  ) {
    if (gated) this.gate = new Promise<void>((resolve) => (this.release = resolve));
  }
  private gate: Promise<void> = Promise.resolve();
  /** Lets a gated load finish. */
  finishLoad(): void {
    this.release?.();
  }
  async load(): Promise<SettingsLoadResult> {
    await this.gate;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
  async save(settings: Settings): Promise<void> {
    this.saved.push(settings);
  }
}

const ok = (settings: Settings = defaultSettings()): SettingsLoadResult => ({ settings, fallbackReason: null });

function setup(service: SettingsService) {
  TestBed.configureTestingModule({ providers: [{ provide: SETTINGS_SERVICE, useValue: service }] });
  return { store: TestBed.inject(SettingsStore), notifications: TestBed.inject(NotificationService) };
}

describe('SettingsStore', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete document.documentElement.dataset['theme'];
    delete document.documentElement.dataset['motion'];
  });

  it('applies the stored settings once loaded, without a notification', async () => {
    const stored = {
      ...defaultSettings(),
      display: { units: 'metric', theme: 'system', reducedMotion: 'system' },
    } as const;
    const { store, notifications } = setup(new FakeService(ok(stored)));
    expect(store.settings()).toEqual(defaultSettings());
    await store.loaded;
    expect(store.settings().display.units).toBe('metric');
    expect(notifications.toasts()).toEqual([]);
  });

  it.each(['corrupt', 'unknown-version'] as const)('warns when the stored file was %s', async (reason) => {
    const { store, notifications } = setup(new FakeService({ settings: defaultSettings(), fallbackReason: reason }));
    await store.loaded;
    expect(store.settings()).toEqual(defaultSettings());
    expect(notifications.toasts()).toEqual([
      expect.objectContaining({ level: 'warning', message: expect.stringContaining('defaults') }),
    ]);
  });

  it('does not warn on first run (nothing stored yet)', async () => {
    const { store, notifications } = setup(new MemorySettingsService());
    await store.loaded;
    expect(notifications.toasts()).toEqual([]);
  });

  it('warns and uses defaults when loading throws', async () => {
    const { store, notifications } = setup(new FakeService(new Error('io')));
    await store.loaded;
    expect(store.settings()).toEqual(defaultSettings());
    expect(notifications.toasts()).toHaveLength(1);
  });

  it('keeps edits made before the load finishes (no lost-update race) and saves them once loaded', async () => {
    const stored = { ...defaultSettings(), audio: { master: 0.2, effects: 0.3, ambience: 0.4, interface: 0.5 } };
    const service = new FakeService(ok(stored), true);
    const { store } = setup(service);
    store.update('display', { theme: 'dark' }); // the player acts before storage answers
    store.update('audio', { master: 0.9 });
    await vi.waitFor(() => expect(service.saved).toHaveLength(0)); // nothing written while loading
    service.finishLoad();
    await store.loaded;
    expect(store.settings().display.theme).toBe('dark');
    expect(store.settings().audio).toEqual({ master: 0.9, effects: 0.3, ambience: 0.4, interface: 0.5 });
    await vi.waitFor(() => expect(service.saved.at(-1)).toEqual(store.settings()), { timeout: SAVE_DEBOUNCE_MS * 4 });
  });

  it('never saves before the load has finished, even when the debounce fires', async () => {
    vi.useFakeTimers();
    const service = new FakeService(ok(), true);
    const { store } = setup(service);
    store.update('display', { units: 'metric' });
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 3);
    expect(service.saved).toHaveLength(0);
    service.finishLoad();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.saved).toHaveLength(1);
    expect(service.saved[0].display.units).toBe('metric');
  });

  it('patches one section and saves once after the debounce', async () => {
    const service = new FakeService(ok());
    const { store } = setup(service);
    await store.loaded;
    vi.useFakeTimers();
    store.update('audio', { master: 0.1 });
    store.update('audio', { effects: 0.2 });
    expect(store.settings().audio).toEqual({ master: 0.1, effects: 0.2, ambience: 1, interface: 1 });
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 1);
    expect(service.saved).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(service.saved).toEqual([store.settings()]);
  });

  it('flush writes a pending change immediately and is a no-op otherwise', async () => {
    const service = new FakeService(ok());
    const { store } = setup(service);
    await store.loaded;
    await store.flush();
    expect(service.saved).toHaveLength(0);
    store.update('display', { units: 'metric' });
    await store.flush();
    expect(service.saved).toHaveLength(1);
  });

  it('restores on-screen defaults but keeps the layout and keybindings', async () => {
    const { store } = setup(new MemorySettingsService());
    await store.loaded;
    const layout = { kind: 'split-panes', version: 1 };
    store.update('workspace', { layout });
    store.update('controls', { invertY: true, keybindings: { 'palette.open': 'Mod+K' } });
    store.resetToDefaults();
    expect(store.settings().controls).toEqual({
      lookSensitivity: 1,
      invertY: false,
      keybindings: { 'palette.open': 'Mod+K' },
    });
    expect(store.settings().workspace.layout).toEqual(layout);
  });

  it('reflects theme and motion overrides on <html>', async () => {
    const { store } = setup(new MemorySettingsService());
    await store.loaded;
    const root = document.documentElement;
    TestBed.tick();
    expect(root.dataset['theme']).toBeUndefined();
    store.update('display', { theme: 'dark', reducedMotion: 'reduce' });
    TestBed.tick();
    expect(root.dataset['theme']).toBe('dark');
    expect(root.dataset['motion']).toBe('reduce');
    store.update('display', { reducedMotion: 'full' });
    TestBed.tick();
    expect(root.dataset['motion']).toBe('full');
    store.update('display', { theme: 'system', reducedMotion: 'system' });
    TestBed.tick();
    expect(root.dataset['theme']).toBeUndefined();
    expect(root.dataset['motion']).toBeUndefined();
  });

  it('notifies when saving fails', async () => {
    const service = new FakeService(ok());
    service.save = () => Promise.reject(new Error('disk full'));
    const { store, notifications } = setup(service);
    await store.loaded;
    vi.useFakeTimers();
    store.update('display', { units: 'metric' });
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(notifications.toasts()).toEqual([expect.objectContaining({ level: 'error' })]);
  });
});

describe('MemorySettingsService', () => {
  it('reports missing until something is saved, then returns it', async () => {
    const service = new MemorySettingsService();
    await expect(service.load()).resolves.toEqual({ settings: defaultSettings(), fallbackReason: 'missing' });
    const changed = {
      ...defaultSettings(),
      gameplay: { defaultDifficulty: 'trainee' as const, region: 'nec' as const },
    };
    await service.save(changed);
    await expect(service.load()).resolves.toEqual({ settings: changed, fallbackReason: null });
  });
});
