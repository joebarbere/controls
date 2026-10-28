import { ApplicationConfig, inject, provideBrowserGlobalErrorListeners, type Provider } from '@angular/core';
import { provideKeybindingOverridesFromSettings, SETTINGS_SERVICE } from '@controls/feature-settings';
import { SAVE_DIALOGS, SAVE_FILES } from '@controls/feature-saves';
import { APP_LIFECYCLE } from '@controls/feature-shell';
import { provideSandboxLevel } from './levels';
import { PLATFORM } from './platform.token';

/** Settings persist through the host platform: a file in userData (Electron) or localStorage (web harness). */
export const provideSettingsFromPlatform = (): Provider => ({
  provide: SETTINGS_SERVICE,
  useFactory: () => inject(PLATFORM).settings,
});

/** Buffered writes (debounced settings, autosave) flush before the window closes or the app quits. */
export const provideLifecycleFromPlatform = (): Provider => ({
  provide: APP_LIFECYCLE,
  useFactory: () => inject(PLATFORM).lifecycle,
});

/** Saves go to the host's save directory and pickers (F1.8b, ADR 0009): main's userData/saves, or OPFS. */
export const provideSaveIoFromPlatform = (): Provider[] => [
  { provide: SAVE_FILES, useFactory: () => inject(PLATFORM).files },
  { provide: SAVE_DIALOGS, useFactory: () => inject(PLATFORM).dialogs },
];

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideSettingsFromPlatform(),
    provideLifecycleFromPlatform(),
    provideSaveIoFromPlatform(),
    // Keybinding overrides live in settings (`controls.keybindings`), F1.4.
    provideKeybindingOverridesFromSettings(),
    // New sandbox loads content/levels/workshop.json (F1.9).
    provideSandboxLevel(),
  ],
};
