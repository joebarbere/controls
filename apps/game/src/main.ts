// Zod's jitless mode is set by the `polyfills` entry (`zod-config.ts`), which runs before this bundle.
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
