import type { Provider } from '@angular/core';
import { SANDBOX_LEVEL } from '@controls/feature-session';
// Level data is content (`content/levels/`, data only). The bundler inlines the JSON, so New sandbox
// needs no fetch and works the same under `app://` (Electron) and the web harness. Session validates it
// through the normal world loader, exactly as `pnpm sim hash content/levels/workshop.json` does.
import workshop from '@controls/content/levels/workshop.json';

/** New sandbox loads the workshop level (F1.9). */
export const provideSandboxLevel = (): Provider => ({ provide: SANDBOX_LEVEL, useValue: workshop });
