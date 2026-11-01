import type { AppInfo } from '@controls/ipc-contract';
import type { DialogService, FileService } from './files';
import type { AppLifecycle } from './lifecycle';
import type { SettingsService } from './settings';

/**
 * Everything the game needs from its host. Features depend on this interface only;
 * apps inject a concrete implementation (Electron bridge or browser dev harness).
 * Grows in P1 (updates still to come).
 */
export interface Platform {
  readonly kind: 'electron' | 'web';
  getAppInfo(): Promise<AppInfo>;
  /** Persistent player settings (a file in userData on desktop, localStorage in the web harness). */
  readonly settings: SettingsService;
  /** Whether {@link quit} can end the app. A browser tab can't close itself, so the web harness hides Quit. */
  readonly canQuit: boolean;
  /** Ends the app. Flushes registered with {@link AppLifecycle.onBeforeQuit} run first. */
  quit(): void;
  /**
   * The host restarted this page after its renderer process crashed (ADR 0011 §10), so the menu
   * offers Continue from the latest autosave. Electron: main reloads with the recovery query. The
   * web harness has no such host: always `false` (a browser shows its own crash page).
   */
  readonly recoveredFromCrash: boolean;
  /** Flush-before-quit hooks for features with buffered writes (settings now, autosave from F1.8b). */
  readonly lifecycle: AppLifecycle;
  /** Saves in the host's save directory, behind opaque handles (ADR 0009). */
  readonly files: FileService;
  /** Open and Save As pickers for files outside the save directory. */
  readonly dialogs: DialogService;
}
