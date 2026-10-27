import { InjectionToken } from '@angular/core';
import type { SettingsDocument, SettingsLoadResult, SettingsService } from '@controls/platform-api';
import { PLACEHOLDER_DEFAULT_SETTINGS } from './defaults';

/**
 * Keeps settings in memory for the life of the page. The default until the platform
 * implementations land. TODO(F1.8a): apps/game provides the Electron or web `SettingsService`.
 */
export class MemorySettingsService implements SettingsService {
  constructor(private stored?: SettingsDocument) {}

  async load(): Promise<SettingsLoadResult> {
    return this.stored
      ? { settings: this.stored }
      : { settings: PLACEHOLDER_DEFAULT_SETTINGS, fallbackReason: 'missing' };
  }

  async save(settings: SettingsDocument): Promise<void> {
    this.stored = settings;
  }
}

/** Where settings are loaded from and saved to. */
export const SETTINGS_SERVICE = new InjectionToken<SettingsService>('controls.settings', {
  providedIn: 'root',
  factory: () => new MemorySettingsService(),
});
