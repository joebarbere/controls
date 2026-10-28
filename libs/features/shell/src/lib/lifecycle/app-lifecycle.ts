import { InjectionToken } from '@angular/core';
import { NOOP_LIFECYCLE, type AppLifecycle } from '@controls/platform-api';

/**
 * The host's flush-before-quit hooks (`Platform.lifecycle`). Features with buffered writes register
 * a flush (`SettingsStore` now, autosave in F1.8b). apps/game provides the platform's; the default
 * never calls back, which is what component specs want.
 */
export const APP_LIFECYCLE = new InjectionToken<AppLifecycle>('controls.appLifecycle', {
  providedIn: 'root',
  factory: () => NOOP_LIFECYCLE,
});
