# sim-protocol (`@controls/sim-protocol`)

Framework-free domain library (`type:domain`): the sim worker contract (plan F2.3b, ADR 0011): snapshot layout, codec, seqlock reader and writer, and the Zod message schemas; since F2.6 the `NetlistReadout` (node voltages against their island reference, branch currents, island status and band, read allocation-free for the overlays and the inspector) and `fakeSnapshotView` (snapshots from plain values through the codec, for tests and UI development). The renderer and features read snapshot types from here, never from `@controls/sim-worker`. Scaffolding only until F2.3b; `src/lib/package.ts` is a placeholder so the coverage gate has source to measure.

Must not depend on Angular, the DOM, Electron, Node built-ins or any non-`type:domain` lib, and must stay deterministic ([workspace caveats](../../../docs/caveats/workspace.md)). Tests: `pnpm nx test sim-protocol` (90 % coverage gate).
