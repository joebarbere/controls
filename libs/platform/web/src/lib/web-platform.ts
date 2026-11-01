import { parseStoredSettings, serialiseSettings, type AppInfo, type SettingsLoadResult } from '@controls/ipc-contract';
import {
  runFlushes,
  type AppLifecycle,
  type DialogService,
  type FileService,
  type PendingWritesFlush,
  type Platform,
  type SettingsService,
} from '@controls/platform-api';
import type { Settings } from '@controls/save-format';
import { APP_VERSION } from '@controls/units';
import { WebSaveStore } from './web-files';

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

/** The slice of `window` used to hear that the page is going away. */
export type PageHideTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/**
 * Flush before quit in the browser harness: registered flushes run on `pagehide` (tab closed,
 * reloaded or navigated away; unlike `beforeunload`, it also fires on mobile and with the
 * back/forward cache). The browser doesn't wait for promises, so this is best effort: the
 * synchronous `localStorage.setItem` behind a settings flush completes, an async write may not.
 */
export class WebAppLifecycle implements AppLifecycle {
  private readonly flushes = new Set<PendingWritesFlush>();
  private readonly onPageHide = () => void runFlushes(this.flushes);

  /** `target` defaults to `window`; without one (Node, workers) nothing ever fires. */
  constructor(private readonly target: PageHideTarget | undefined = pageHideTarget()) {}

  onBeforeQuit(flush: PendingWritesFlush): () => void {
    const entry: PendingWritesFlush = () => flush();
    if (this.flushes.size === 0) this.target?.addEventListener('pagehide', this.onPageHide);
    this.flushes.add(entry);
    return () => {
      if (!this.flushes.delete(entry)) return;
      if (this.flushes.size === 0) this.target?.removeEventListener('pagehide', this.onPageHide);
    };
  }
}

function pageHideTarget(): PageHideTarget | undefined {
  const candidate = globalThis as Partial<PageHideTarget>;
  return typeof candidate.addEventListener === 'function' ? (candidate as PageHideTarget) : undefined;
}

/** {@link Platform} for the browser dev harness (`pnpm start:web`, Playwright web e2e). */
export class WebPlatform implements Platform {
  readonly kind = 'web' as const;
  /** Browsers only let a script close windows it opened, so the harness has no Quit. */
  readonly canQuit = false;
  /** Crash recovery is the desktop host's (main reloads the window); not available in the browser harness. */
  readonly recoveredFromCrash = false;
  readonly settings: SettingsService = new WebSettingsService();
  readonly lifecycle: AppLifecycle = new WebAppLifecycle();
  /** Saves in the origin-private file system; Open uploads, Save As downloads (ADR 0009). */
  readonly files: FileService;
  readonly dialogs: DialogService;

  constructor(saves: WebSaveStore = new WebSaveStore()) {
    this.files = saves.files;
    this.dialogs = saves.dialogs;
  }

  async getAppInfo(): Promise<AppInfo> {
    return { appVersion: APP_VERSION, platform: 'web', arch: 'unknown', isPackaged: false, versions: {} };
  }

  quit(): void {
    // Intentionally a no-op: see canQuit.
  }
}
