import type { AppInfo } from './app-info';

/**
 * The narrow, typed API the preload exposes on `window.controls` via contextBridge.
 * The renderer never sees `ipcRenderer` itself.
 */
export interface ControlsBridge {
  readonly getAppInfo: () => Promise<AppInfo>;
}

/** Global key the preload uses with `contextBridge.exposeInMainWorld`. */
export const BRIDGE_KEY = 'controls';
