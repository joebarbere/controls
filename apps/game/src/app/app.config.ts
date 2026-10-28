import { ApplicationConfig, inject, provideBrowserGlobalErrorListeners, type Provider } from '@angular/core';
import { provideKeybindingOverridesFromSettings, SETTINGS_SERVICE } from '@controls/feature-settings';
import { APP_LIFECYCLE } from '@controls/feature-shell';
import { provideSandboxLevel } from './levels';
import { PLATFORM } from './platform.token';

/** Settings persist through the host platform: a file in userData (Electron) or localStorage (web harness). */
export const provideSettingsFromPlatform = (): Provider => ({
  provide: SETTINGS_SERVICE,
  useFactory: () => inject(PLATFORM).settings,
});

/** Buffered writes (debounced settings, later autosave) flush before the window closes or the app quits. */
export const provideLifecycleFromPlatform = (): Provider => ({
  provide: APP_LIFECYCLE,
  useFactory: () => inject(PLATFORM).lifecycle,
});

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideSettingsFromPlatform(),
    provideLifecycleFromPlatform(),
    // Keybinding overrides live in settings (`controls.keybindings`), F1.4.
    provideKeybindingOverridesFromSettings(),
    // New sandbox loads content/levels/workshop.json (F1.9).
    provideSandboxLevel(),
  ],
};
