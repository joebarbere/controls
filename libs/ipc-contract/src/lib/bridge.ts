import type { AppInfo } from './app-info';

/**
 * The narrow, typed API the preload exposes on `window.controls` via contextBridge.
 * The renderer never sees `ipcRenderer` itself. Responses are `unknown` where the renderer must
 * re-validate them (`platform-electron` does), so a compromised main can't smuggle a bad shape in.
 */
export interface ControlsBridge {
  readonly getAppInfo: () => Promise<AppInfo>;
  /** `settings:get`: `{ settings, fallbackReason }` (see `SettingsGetResponseSchema`). */
  readonly getSettings: () => Promise<unknown>;
  /** `settings:set`: rejects if main refuses the document (invalid, too large). */
  readonly setSettings: (settings: unknown) => Promise<void>;
  /** `app:quit`. Main flushes the renderer (`app:flush-request`) before it really quits. */
  readonly quit: () => Promise<void>;
  /**
   * Subscribes to `app:flush-request` (main → renderer). The listener gets only the payload (to be
   * validated with `FlushRequestSchema`), never the IPC event. Returns an unsubscribe function.
   */
  readonly onFlushRequest: (listener: (request: unknown) => void) => () => void;
  /** `app:flush-ack`: answers a flush request (`FlushAckSchema`). */
  readonly ackFlush: (ack: unknown) => Promise<void>;
}

/** Global key the preload uses with `contextBridge.exposeInMainWorld`. */
export const BRIDGE_KEY = 'controls';
