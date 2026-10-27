# units (`@controls/units`)

Framework-free domain library (`type:domain`). Today it only holds `APP_VERSION` in `src/lib/version.ts`, which `pnpm version:sync` generates from the root `package.json`. Don't edit that file by hand. Unit and quantity helpers arrive from P1.

Must not depend on Angular, the DOM, Electron or any non-`type:domain` lib, because `sim-cli` has to run it in plain Node. Tests: `pnpm nx test units`.
