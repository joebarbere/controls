import { ApplicationConfig, inject, provideBrowserGlobalErrorListeners, type Provider } from '@angular/core';
import { SETTINGS_SERVICE } from '@controls/feature-settings';
import { PLATFORM } from './platform.token';

/** Settings persist through the host platform: a file in userData (Electron) or localStorage (web harness). */
export const provideSettingsFromPlatform = (): Provider => ({
  provide: SETTINGS_SERVICE,
  useFactory: () => inject(PLATFORM).settings,
});

export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), provideSettingsFromPlatform()],
};
