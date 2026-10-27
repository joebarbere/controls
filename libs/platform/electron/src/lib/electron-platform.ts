import { AppInfoSchema, BRIDGE_KEY, type AppInfo, type ControlsBridge } from '@controls/ipc-contract';
import type { Platform } from '@controls/platform-api';

/** Reads the preload bridge, if this renderer was loaded by the Controls Electron shell. */
export function findBridge(globalObject: object = globalThis): ControlsBridge | undefined {
  return (globalObject as Record<string, ControlsBridge | undefined>)[BRIDGE_KEY];
}

/** {@link Platform} backed by the typed preload bridge. Responses are re-validated renderer-side. */
export class ElectronPlatform implements Platform {
  readonly kind = 'electron' as const;

  constructor(private readonly bridge: ControlsBridge) {}

  async getAppInfo(): Promise<AppInfo> {
    return AppInfoSchema.parse(await this.bridge.getAppInfo());
  }
}
