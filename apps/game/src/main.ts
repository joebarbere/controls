// First: Zod without its eval probe, before any schema compiles (the CSP has no 'unsafe-eval').
import './zod-config';
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
