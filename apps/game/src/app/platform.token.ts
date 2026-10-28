import { DOCUMENT, InjectionToken, inject } from '@angular/core';
import type { Platform } from '@controls/platform-api';
import { ElectronPlatform, findBridge } from '@controls/platform-electron';
import { WebPlatform } from '@controls/platform-web';

/** Window property for the E2E platform hook (`?e2e=1` only). */
const TEST_HOOK = '__controlsPlatform';

/** The host platform. Features inject this token and never a concrete implementation. */
export const PLATFORM = new InjectionToken<Platform>('controls.platform', {
  providedIn: 'root',
  factory: () => {
    const bridge = findBridge();
    const platform = bridge ? new ElectronPlatform(bridge) : new WebPlatform();
    exposeTestHook(platform, inject(DOCUMENT).defaultView);
    return platform;
  },
});

/**
 * `?e2e=1` only: exposes the save services on `window`, so `apps/game-e2e` can round-trip a save
 * through the real web store (OPFS in Chromium) before the Load/Continue UI exists. The desktop app
 * always loads `app://game/index.html` without a query, so this never runs there.
 */
function exposeTestHook(platform: Platform, view: Window | null): void {
  if (!view || new URLSearchParams(view.location.search).get('e2e') !== '1') return;
  (view as unknown as Record<string, unknown>)[TEST_HOOK] = { files: platform.files, dialogs: platform.dialogs };
}
