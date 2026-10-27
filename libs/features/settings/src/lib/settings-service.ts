import { InjectionToken } from '@angular/core';
import type { SettingsLoadResult, SettingsService } from '@controls/platform-api';
import { defaultSettings, type Settings } from '@controls/save-format';

/**
 * Keeps settings in memory for the life of the page. For tests and for hosts with no storage;
 * apps/game provides the platform's persistent service instead.
 */
export class MemorySettingsService implements SettingsService {
  constructor(private stored?: Settings) {}

  async load(): Promise<SettingsLoadResult> {
    return this.stored
      ? { settings: this.stored, fallbackReason: null }
      : { settings: defaultSettings(), fallbackReason: 'missing' };
  }

  async save(settings: Settings): Promise<void> {
    this.stored = settings;
  }
}

/** Where settings are loaded from and saved to. apps/game provides `platform.settings`. */
export const SETTINGS_SERVICE = new InjectionToken<SettingsService>('controls.settings', {
  providedIn: 'root',
  factory: () => new MemorySettingsService(),
});
