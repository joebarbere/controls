# catalog (`@controls/catalog`)

Framework-free domain library (`type:domain`): the device catalogue (plan P2 decision D4): loading and validating `content/devices/*.json`, `catalogVersion`. Scaffolding only until the world v2 PR; `src/lib/package.ts` is a placeholder so the coverage gate has source to measure.

Must not depend on Angular, the DOM, Electron, Node built-ins or any non-`type:domain` lib, and must stay deterministic ([workspace caveats](../../../docs/caveats/workspace.md)). Tests: `pnpm nx test catalog` (90 % coverage gate).
