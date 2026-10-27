# units (`@controls/units`)

Framework-free domain library (`type:domain`). Today it only holds `APP_VERSION` in `src/lib/version.ts`, which `pnpm version:sync` generates from the root `package.json`. Don't edit that file by hand. Unit and quantity helpers arrive from P1.

Must not depend on Angular, the DOM, Electron, Node built-ins or any non-`type:domain` lib, and must stay deterministic (no `Math.random` or wall clock), because `sim-cli`, the renderer and the sim worker all run it. Lint and typecheck enforce this ([workspace caveats](../../../docs/caveats/workspace.md)). Tests: `pnpm nx test units` (90 % coverage gate).
