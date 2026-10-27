import { parseStoredSettings, serialiseSettings, type AppInfo, type SettingsLoadResult } from '@controls/ipc-contract';
import type { Platform, SettingsService } from '@controls/platform-api';
import type { Settings } from '@controls/save-format';
import { APP_VERSION } from '@controls/units';

/** localStorage key for the web harness settings document. */
export const WEB_SETTINGS_KEY = 'controls.settings';

/** The slice of the Web Storage API used here. */
export type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Settings in localStorage for the browser harness. Storage can be missing or throw (private
 * modes, quotas, disabled storage), so every access is guarded: an unreadable store loads defaults,
 * and a failed write rejects so the UI can say so.
 */
export class WebSettingsService implements SettingsService {
  constructor(private readonly storage: () => SettingsStorage | undefined = () => globalThis.localStorage) {}

  async load(): Promise<SettingsLoadResult> {
    let text: string | null;
    try {
      text = this.storage()?.getItem(WEB_SETTINGS_KEY) ?? null;
    } catch {
      text = null; // storage unavailable: behave like a first run
    }
    return parseStoredSettings(text);
  }

  async save(settings: Settings): Promise<void> {
    const storage = this.storage();
    if (!storage) throw new Error('Browser storage is not available.');
    storage.setItem(WEB_SETTINGS_KEY, serialiseSettings(settings));
  }
}

/** {@link Platform} for the browser dev harness (`pnpm start:web`, Playwright web e2e). */
export class WebPlatform implements Platform {
  readonly kind = 'web' as const;
  /** Browsers only let a script close windows it opened, so the harness has no Quit. */
  readonly canQuit = false;
  readonly settings: SettingsService = new WebSettingsService();

  async getAppInfo(): Promise<AppInfo> {
    return { appVersion: APP_VERSION, platform: 'web', arch: 'unknown', isPackaged: false, versions: {} };
  }

  quit(): void {
    // Intentionally a no-op: see canQuit.
  }
}
