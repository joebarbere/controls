import type { AppInfo } from '@controls/ipc-contract';
import type { Platform } from '@controls/platform-api';
import { APP_VERSION } from '@controls/units';

/** {@link Platform} for the browser dev harness (`pnpm start:web`, Playwright web e2e). */
export class WebPlatform implements Platform {
  readonly kind = 'web' as const;

  async getAppInfo(): Promise<AppInfo> {
    return { appVersion: APP_VERSION, platform: 'web', arch: 'unknown', isPackaged: false, versions: {} };
  }
}
