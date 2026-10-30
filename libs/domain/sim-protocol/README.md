# sim-protocol (`@controls/sim-protocol`)

Framework-free domain library (`type:domain`): the sim worker contract (plan F2.3b, ADR 0011): snapshot layout, codec, seqlock reader and writer, and the Zod message schemas. The renderer and features read snapshot types from here, never from `@controls/sim-worker`. Scaffolding only until F2.3b; `src/lib/package.ts` is a placeholder so the coverage gate has source to measure.

Must not depend on Angular, the DOM, Electron, Node built-ins or any non-`type:domain` lib, and must stay deterministic ([workspace caveats](../../../docs/caveats/workspace.md)). Tests: `pnpm nx test sim-protocol` (90 % coverage gate).
