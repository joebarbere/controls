# world-model (`@controls/world-model`)

Framework-free domain library (`type:domain`): the world document's operations and determinism primitives (plan F1.2, [ADR 0007](../../../docs/decisions/0007-world-document-v1.md), [ADR 0006](../../../docs/decisions/0006-command-system.md)). Types (`World`, `Entity`, `PositionMm`, `OrientationMdeg`, …) are inferred from `@controls/save-format`; never hand-written.

- **World commands:** `entity.place`, `entity.move`, `entity.rotate`, `entity.delete` (undoable, integer mm and millidegrees, ids from `nextEntityId`).
- **Sessions:** `createWorldRegistry()` (world + edit + view commands), `createWorldBus(world)`, `toReplayLog(initialWorld, bus)`, `replayLog(log)` → world and hash.
- **Hash:** `canonicalJson`, `worldHash(world)` (SHA-256, lower-case hex), `hashWorldDocument(json)` for untrusted input. `sha256`, `sha256Hex`, `utf8Encode` are written from FIPS 180-4.
- **Snapping and placement (F1.7):** `snap()`, `snapToBest()` and `placeOnTargets()` (cursor point → exact `entity.place` / `entity.move` arguments) in integer mm with sourced constants, `orientationForFrame()` / `orientationForNormal()`, and the built-in prop table (`BUILTIN_PROPS`, `builtinProp()`, `propFootprint()`). The renderer's ghost and scripts call the same functions.
- **Fixtures and levels (F1.9):** the built-in fixture table (`FIXTURE_SPECS`, `fixtureSpec()`), `fixtureSnapTarget()` / `fixtureFocusNormal()` and `worldSnapTargets(world)` (what the mouse and scripts snap to), `loadLevel(json)` and `newGameWorld(level, { seed, difficulty })`.
- **PRNG:** `Sfc32`, `deriveStream(seed, key)` with `commandStreamKey(seq)` / `entityStreamKey(id)`.

Tests: `pnpm nx test world-model` (90 % coverage gate).
