import {
  AppInfoSchema,
  BRIDGE_KEY,
  fallbackReasonFor,
  FlushRequestSchema,
  SettingsGetResponseSchema,
  type AppInfo,
  type ControlsBridge,
  type SettingsLoadResult,
} from '@controls/ipc-contract';
import {
  runFlushes,
  type AppLifecycle,
  type PendingWritesFlush,
  type Platform,
  type SettingsService,
} from '@controls/platform-api';
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

/**
 * Flush before quit, renderer side. Subscribes to `app:flush-request` as soon as it is created, so
 * main gets an ack even when nothing is registered. On a valid request it runs every registered
 * flush, waits for all of them to settle, and answers with `app:flush-ack`. A malformed request is
 * ignored (main times out). Main enforces the deadline; there is no renderer-side timeout.
 */
export class ElectronAppLifecycle implements AppLifecycle {
  private readonly flushes = new Set<PendingWritesFlush>();

  constructor(private readonly bridge: ControlsBridge) {
    bridge.onFlushRequest((request) => void this.handleRequest(request));
  }

  onBeforeQuit(flush: PendingWritesFlush): () => void {
    // Wrapped, so registering the same function twice gives two independent registrations.
    const entry: PendingWritesFlush = () => flush();
    this.flushes.add(entry);
    return () => void this.flushes.delete(entry);
  }

  private async handleRequest(request: unknown): Promise<void> {
    const parsed = FlushRequestSchema.safeParse(request);
    if (!parsed.success) return;
    const ok = await runFlushes(this.flushes);
    await this.bridge.ackFlush({ requestId: parsed.data.requestId, ok }).catch(() => undefined);
  }
}

/** {@link Platform} backed by the typed preload bridge. Responses are re-validated renderer-side. */
export class ElectronPlatform implements Platform {
  readonly kind = 'electron' as const;
  readonly canQuit = true;
  readonly settings: SettingsService;
  readonly lifecycle: AppLifecycle;

  constructor(private readonly bridge: ControlsBridge) {
    this.settings = new ElectronSettingsService(bridge);
    this.lifecycle = new ElectronAppLifecycle(bridge);
  }

  async getAppInfo(): Promise<AppInfo> {
    return AppInfoSchema.parse(await this.bridge.getAppInfo());
  }

  /** Quits through main (`app:quit`), so it works on macOS too, where closing the window would not. */
  quit(): void {
    void this.bridge.quit();
  }
}
