# units (`@controls/units`)

Framework-free domain library (`type:domain`). It holds `APP_VERSION` in `src/lib/version.ts`, which `pnpm version:sync` generates from the root `package.json` (don't edit that file by hand), and the length helpers in `src/lib/length.ts`. World geometry is integer millimetres. `mm()` converts to scene metres, `metresToMm()` and `roundMm()` convert back (half away from zero, never `-0`), and `inchesToMm()` and `isIntegerMm()` round out the set.

Must not depend on Angular, the DOM, Electron, Node built-ins or any non-`type:domain` lib, and must stay deterministic (no `Math.random` or wall clock), because `sim-cli`, the renderer and the sim worker all run it. Lint and typecheck enforce this ([workspace caveats](../../../docs/caveats/workspace.md)). Tests: `pnpm nx test units` (90 % coverage gate).
