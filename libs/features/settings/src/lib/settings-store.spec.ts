import { TestBed } from '@angular/core/testing';
import { NotificationService } from '@controls/feature-shell';
import type { SettingsDocument, SettingsLoadResult, SettingsService } from '@controls/platform-api';
import { PLACEHOLDER_DEFAULT_SETTINGS } from './defaults';
import { MemorySettingsService, SETTINGS_SERVICE } from './settings-service';
import { SAVE_DEBOUNCE_MS, SettingsStore } from './settings-store';

class FakeService implements SettingsService {
  saved: SettingsDocument[] = [];
  constructor(private readonly result: SettingsLoadResult | Error) {}
  async load(): Promise<SettingsLoadResult> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
  async save(settings: SettingsDocument): Promise<void> {
    this.saved.push(settings);
  }
}

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
    const stored = { ...PLACEHOLDER_DEFAULT_SETTINGS, units: { display: 'metric' as const } };
    const { store, notifications } = setup(new FakeService({ settings: stored }));
    expect(store.settings()).toEqual(PLACEHOLDER_DEFAULT_SETTINGS);
    await store.loaded;
    expect(store.settings().units.display).toBe('metric');
    expect(notifications.toasts()).toEqual([]);
  });

  it.each(['corrupt', 'unknown-version'] as const)('falls back to defaults with a warning when %s', async (reason) => {
    const { store, notifications } = setup(
      new FakeService({ settings: PLACEHOLDER_DEFAULT_SETTINGS, fallbackReason: reason }),
    );
    await store.loaded;
    expect(store.settings()).toEqual(PLACEHOLDER_DEFAULT_SETTINGS);
    expect(notifications.toasts()).toEqual([
      expect.objectContaining({ level: 'warning', message: expect.stringContaining('defaults') }),
    ]);
  });

  it('does not warn on first run (nothing stored yet)', async () => {
    const { store, notifications } = setup(new MemorySettingsService());
    await store.loaded;
    expect(notifications.toasts()).toEqual([]);
  });

  it('warns when loading throws', async () => {
    const { store, notifications } = setup(new FakeService(new Error('io')));
    await store.loaded;
    expect(notifications.toasts()).toHaveLength(1);
  });

  it('patches one section and saves once after the debounce', async () => {
    const service = new FakeService({ settings: PLACEHOLDER_DEFAULT_SETTINGS });
    const { store } = setup(service);
    await store.loaded;
    vi.useFakeTimers();
    store.update('audio', { master: 10 });
    store.update('audio', { effects: 20 });
    expect(store.settings().audio).toEqual({ master: 10, effects: 20, ambience: 60 });
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1);
    expect(service.saved).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(service.saved).toEqual([store.settings()]);
  });

  it('flush writes a pending change immediately and is a no-op otherwise', async () => {
    const service = new FakeService({ settings: PLACEHOLDER_DEFAULT_SETTINGS });
    const { store } = setup(service);
    await store.loaded;
    await store.flush();
    expect(service.saved).toHaveLength(0);
    store.update('units', { display: 'metric' });
    await store.flush();
    expect(service.saved).toHaveLength(1);
  });

  it('restores defaults but keeps the workspace layout', async () => {
    const { store } = setup(new MemorySettingsService());
    await store.loaded;
    const layout = { inspector: { size: 400, collapsed: true }, bottom: { size: 150, collapsed: false } };
    store.update('workspace', { layout });
    store.update('controls', { invertY: true });
    store.resetToDefaults();
    expect(store.settings().controls.invertY).toBe(false);
    expect(store.settings().workspace.layout).toEqual(layout);
  });

  it('reflects theme and motion overrides on <html>', async () => {
    const { store } = setup(new MemorySettingsService());
    await store.loaded;
    const root = document.documentElement;
    TestBed.tick();
    expect(root.dataset['theme']).toBeUndefined();
    store.update('interface', { theme: 'dark', motion: 'reduce' });
    TestBed.tick();
    expect(root.dataset['theme']).toBe('dark');
    expect(root.dataset['motion']).toBe('reduce');
    store.update('interface', { theme: 'system', motion: 'system' });
    TestBed.tick();
    expect(root.dataset['theme']).toBeUndefined();
    expect(root.dataset['motion']).toBeUndefined();
  });

  it('notifies when saving fails', async () => {
    const service = new FakeService({ settings: PLACEHOLDER_DEFAULT_SETTINGS });
    service.save = () => Promise.reject(new Error('disk full'));
    const { store, notifications } = setup(service);
    await store.loaded;
    vi.useFakeTimers();
    store.update('units', { display: 'metric' });
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(notifications.toasts()).toEqual([expect.objectContaining({ level: 'error' })]);
  });
});

describe('MemorySettingsService', () => {
  it('reports missing until something is saved, then returns it', async () => {
    const service = new MemorySettingsService();
    await expect(service.load()).resolves.toEqual({
      settings: PLACEHOLDER_DEFAULT_SETTINGS,
      fallbackReason: 'missing',
    });
    const changed = { ...PLACEHOLDER_DEFAULT_SETTINGS, region: { id: 'nec' as const } };
    await service.save(changed);
    await expect(service.load()).resolves.toEqual({ settings: changed });
  });
});
