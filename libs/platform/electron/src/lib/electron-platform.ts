import {
  AppInfoSchema,
  BRIDGE_KEY,
  fallbackReasonFor,
  SettingsGetResponseSchema,
  type AppInfo,
  type ControlsBridge,
  type SettingsLoadResult,
} from '@controls/ipc-contract';
import type { Platform, SettingsService } from '@controls/platform-api';
import { defaultSettings, loadSettings, type Settings } from '@controls/save-format';

/** Reads the preload bridge, if this renderer was loaded by the Controls Electron shell. */
export function findBridge(globalObject: object = globalThis): ControlsBridge | undefined {
  return (globalObject as Record<string, ControlsBridge | undefined>)[BRIDGE_KEY];
}

/**
 * Settings over `settings:get` / `settings:set`. Main validates and writes atomically; the response
 * is validated again here, so a bad reply falls back to defaults instead of reaching the UI.
 */
export class ElectronSettingsService implements SettingsService {
  constructor(private readonly bridge: ControlsBridge) {}

  async load(): Promise<SettingsLoadResult> {
    try {
      const response = SettingsGetResponseSchema.parse(await this.bridge.getSettings());
      const { settings, error } = loadSettings(response.settings);
      if (error) return { settings, fallbackReason: fallbackReasonFor(error) };
      return { settings, fallbackReason: response.fallbackReason };
    } catch {
      return { settings: defaultSettings(), fallbackReason: 'corrupt' };
    }
  }

  save(settings: Settings): Promise<void> {
    return this.bridge.setSettings(settings);
  }
}

/** {@link Platform} backed by the typed preload bridge. Responses are re-validated renderer-side. */
export class ElectronPlatform implements Platform {
  readonly kind = 'electron' as const;
  readonly canQuit = true;
  readonly settings: SettingsService;

  constructor(private readonly bridge: ControlsBridge) {
    this.settings = new ElectronSettingsService(bridge);
  }

  async getAppInfo(): Promise<AppInfo> {
    return AppInfoSchema.parse(await this.bridge.getAppInfo());
  }

  /** Quits through main (`app:quit`), so it works on macOS too, where closing the window would not. */
  quit(): void {
    void this.bridge.quit();
  }
}
