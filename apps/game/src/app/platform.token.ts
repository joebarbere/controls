import { InjectionToken } from '@angular/core';
import type { Platform } from '@controls/platform-api';
import { ElectronPlatform, findBridge } from '@controls/platform-electron';
import { WebPlatform } from '@controls/platform-web';

/** The host platform. Features inject this token and never a concrete implementation. */
export const PLATFORM = new InjectionToken<Platform>('controls.platform', {
  providedIn: 'root',
  factory: () => {
    const bridge = findBridge();
    return bridge ? new ElectronPlatform(bridge) : new WebPlatform();
  },
});
