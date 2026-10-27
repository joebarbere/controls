import type { AppInfo } from '@controls/ipc-contract';

/**
 * Everything the game needs from its host. Features depend on this interface only;
 * apps inject a concrete implementation (Electron bridge or browser dev harness).
 * Grows in P1 (files, dialogs, settings, updates).
 */
export interface Platform {
  readonly kind: 'electron' | 'web';
  getAppInfo(): Promise<AppInfo>;
  /** Whether {@link quit} can end the app. A browser tab can't close itself, so the web harness hides Quit. */
  readonly canQuit: boolean;
  /** Ends the app (closes the game window). */
  quit(): void;
}
