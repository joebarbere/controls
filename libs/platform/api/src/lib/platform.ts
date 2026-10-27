import type { AppInfo } from '@controls/ipc-contract';
import type { SettingsService } from './settings';

/**
 * Everything the game needs from its host. Features depend on this interface only;
 * apps inject a concrete implementation (Electron bridge or browser dev harness).
 * Grows in P1 (files, dialogs, updates).
 */
export interface Platform {
  readonly kind: 'electron' | 'web';
  getAppInfo(): Promise<AppInfo>;
  /** Persistent player settings (a file in userData on desktop, localStorage in the web harness). */
  readonly settings: SettingsService;
  /** Whether {@link quit} can end the app. A browser tab can't close itself, so the web harness hides Quit. */
  readonly canQuit: boolean;
  /** Ends the app. */
  quit(): void;
}
