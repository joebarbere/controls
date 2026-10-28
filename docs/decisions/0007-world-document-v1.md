# ADR 0007: World document v1 and determinism

**Status:** Accepted (F1.8a; PRNG and hash implemented in F1.2); amended in F1.9 (fixtures and levels)
**Date:** 2026-10-27 (Phase 1)
**Sources:** plan §4.4, §4.6, §4.8; [ADR 0004](0004-save-format.md); [phase 1 plan](../../plans/phase-1-game-shell.md) F1.2, F1.8, "Kickoff decisions"

## Context

[ADR 0004](0004-save-format.md) chose the `.ctrl` container and the rules (Zod as the source of truth, integer `schemaVersion`, total migration chain, lossless JSON, catalogue refs, `extensions`). P1 needs the first concrete documents before the command system (F1.2) can build on them, plus the determinism choices that the documents encode: how entity ids are allocated, how orientation is stored, which PRNG the seed feeds, how the world is hashed, what stands in for catalogue entries before the catalogue exists, and what `tick` means before the P2 sim clock. Everything decided here is frozen once v0.2.0 ships.

## Decisions

### Documents and versions

- One **`schemaVersion`** covers the whole save: `manifest.json`, `world.json` and `replay.log` all carry `schemaVersion: 1` and are bumped together (a document that didn't change gets an identity step). **Settings** have their own **`settingsVersion`**, because they live outside saves and change on a different rhythm.
- Every persisted object is a **strict** object: unknown keys are rejected, not silently stripped. Unknown data belongs in an `extensions` bag (on the world, each entity, the manifest and settings), which round-trips untouched.
- **No optional fields.** Absence is `null` where it's meaningful, so there's no `undefined`-vs-missing ambiguity. A test walks the exported JSON Schema to enforce it.
- All numbers are finite and `-0` is normalised to `0` at parse time. Strings must be well-formed UTF-16 (no unpaired surrogates), because the container encodes JSON as UTF-8, which would replace them.

### `WorldV1`

`{ schemaVersion, seed, tick, nextEntityId, regionId, difficulty, assisted, entities, extensions }`. Each entity is `{ id, ref: { id, version }, transform: { positionMm: { x, y, z }, orientationMdeg: { yaw, pitch, roll } }, extensions }`. `regionId` is `"nec"` only; `difficulty` is `trainee | apprentice | journeyman | realistic`. Settings hold the defaults for new games, and each world stores its actual values.

### Entity id allocation

- Ids are positive integers from the world's **`nextEntityId`** counter, never `crypto.randomUUID` or the clock. Placing an entity takes the counter's value and increments it.
- The counter is world state. **Undoing `entity.place` restores the previous counter**, so "undo everything returns the initial hash" holds (F1.2). Deleting never decrements it, and undoing a delete reinserts the entity with its **same id**. An id can therefore be reused only after the entity that held it has been undone out of existence, never while it exists.
- `entities` is sorted by strictly ascending `id`, and every id is below `nextEntityId`. Each world therefore has exactly one serialised form.

### Positions

Integer millimetres (ADR 0004: right-handed, +y up), bounded to **±10 km**. That bound keeps the sum of squared differences of any two points below 2^53, so distance comparisons in integer maths stay exact.

### Orientation encoding

**Intrinsic Tait-Bryan angles in integer millidegrees:** yaw about +y, then pitch about the new +x, then roll about the new +z, each normalised to `[0, 360000)`.

- Integers are exact, hash-stable and lossless in JSON. Rotation commands compose by modular integer addition per axis, which is deterministic on every platform.
- 0.001° is fine enough: at a 50 m lever arm it moves a point by about 0.87 mm, which is below the 1 mm position grid.
- The triple, not the rotation, is the state. Two triples can describe the same rotation (gimbal lock at pitch 90°/270°), so they hash differently. That's acceptable because the same commands always produce the same triple. The renderer converts the triple to a quaternion at draw time.
- **Rejected:** float quaternions (drift under composition, `q` and `−q` are the same rotation, so there's no canonical form); 3×3 float matrices (9 floats, drift, orthonormality to enforce); integer degrees (too coarse for free placement); quarter turns only (too restrictive for props).

### Built-in prop references

Until the catalogue lands (P2–P3), props use catalogue refs **`prop.<name>` at version 1** (`prop.box`, `prop.crate`, `prop.spool`, `prop.bench`, …), drawn by procedural renderer recipes (F1.9). The manifest's `catalogVersion` is **0**, meaning "no catalogue". The schema doesn't restrict which ids exist; resolving a ref is the loader's job in `world-model`. When the catalogue arrives it either ships `prop.*` entries at version 1 with the same ids (no migration), or a migration rewrites the refs.

### Sim tick before P2

`tick` is an integer that exists from v1 and **stays 0 throughout P1**. Every replay entry records the tick at which it ran (0 in P1). Ticks never go backwards and start at the initial world's tick. The P2 sim clock advances it without a schema change.

### PRNG

- The world `seed` is an unsigned 32-bit integer.
- The generator is **sfc32** (Small Fast Chaotic, 128-bit state, 32-bit output), from Chris Doty-Humphrey's public-domain PractRand suite. It is reimplemented in `world-model` from the published algorithm description using `Math.imul` and `>>> 0`, not copied from any implementation. It passes PractRand and needs only 32-bit integer operations, which are exact and fast in JavaScript.
- **No PRNG state is persisted in v1.** Each consumer derives an independent stream from `(seed, stream key)`. The key is stable data such as the command `seq` or an entity id, mixed into the seed with a 32-bit integer finaliser, and the first outputs are discarded as a warm-up. So undo, redo, save and load never need to rewind a generator. F1.2 fixes the key derivation and pins golden output vectors in tests ([ADR 0006](0006-command-system.md#randomness), `deriveStream` in `@controls/world-model`). If a long-lived stream is ever needed, it arrives in a later `schemaVersion` with a migration that derives its initial state from the seed.
- **Rejected:** `Math.random` (banned in domain code), mulberry32 (32-bit state, short period), PCG32 (64-bit multiply, so `BigInt` or emulation in JavaScript), xoshiro128\*\* (fine, but no advantage over sfc32 here).

### Canonical world hash

- `world.hash` (F1.2) is computed over the **parsed world document only**. View state, settings and the replay log never affect it.
- The input is **canonical JSON**: object keys sorted by UTF-16 code units, recursively; arrays kept in order; no whitespace; strings escaped as `JSON.stringify` does; numbers formatted by ECMAScript `Number::toString` (what `JSON.stringify` uses, and what RFC 8785 specifies). `-0` is already normalised by the schema. For our value domain (finite numbers, well-formed strings, no `undefined`) this matches RFC 8785.
- The canonical string is UTF-8 encoded and hashed with **SHA-256** (FIPS 180-4), implemented in pure TypeScript from the standard. The result is a lowercase hex string. WebCrypto is async and banned in domain code. A non-cryptographic hash would make accidental collisions plausible across bug reports.
- F1.2 tests that the hash is identical in Node and Chromium.

### Replay log

`replay.log` is a single JSON document `{ schemaVersion, initialWorld, entries }`, not JSON Lines: the container is rewritten whole on every save, so appending buys nothing.

- Entries are `{ seq, tick, id, args }`. `seq` counts from 0 without gaps, `id` is a dotted command id (`category.verb`, camelCase segments), and `args` is the command's parsed arguments as a JSON object.
- `initialWorld` is a full world snapshot the log starts from. Replaying the entries against it must reproduce the saved world's hash. This keeps replay self-contained even when level content (for example the workshop) changes between versions.
- **Command ids and argument shapes are part of the save format.** Renaming a command or changing its `args` needs a `schemaVersion` bump and a log migration.

### Manifest

`{ format: "controls.ctrl", schemaVersion, appVersion, catalogVersion, extensions }`. `appVersion` is `APP_VERSION` from `@controls/units`. There is **no timestamp**: container bytes must be deterministic, and the file's modification time already says when it was saved.

### Loading

`migrate*` (and `loadSettings`) are the only entry points for untrusted JSON:

1. Refuse non-objects, nesting deeper than 64 levels (checked iteratively, before Zod recurses) and own `"__proto__"` keys (which `z.record` would silently drop).
2. Read the version. A version newer than the build is refused with a typed `newer-than-build` error, never half-loaded.
3. Validate at the document's own version, then migrate `n → n+1`, validating after every step.

They never throw. Errors are typed and carry bounded, value-free issue lists.

### Fixtures and levels (F1.9)

The workshop's floor, stud wall, backboard, backplate, DIN rails and bench must be in the world (so they're in `world.hash`, a save says which level it is, and headless scripts snap against the same surfaces as the mouse), but they aren't things the player places.

- **Decision: a `fixtures` list in `WorldV1`, next to `entities`.** Each fixture is `{ id, ref, transform, extensions }`: a string id in the view-target grammar (lower-case words joined by hyphens, at most 64 characters, never starting with `entity-`), a built-in catalogue ref (`prop.stud-wall@1`, …), the same integer-mm / millidegree transform as an entity, and an `extensions` bag. The list is sorted by id in UTF-16 code-unit order, so each world still has one serialised form. **No command creates, moves or deletes a fixture**, and fixtures take no entity ids.
- **Sizes and snap targets are code, positions are data.** `FIXTURE_SPECS` in `@controls/world-model` sizes each built-in fixture (game-design values with a `source`; real-world dimensions come from the sourced snap constants), and `fixtureSnapTarget(fixture)` derives the world-space snap target from the spec and the fixture's transform. The renderer and scripts both call `worldSnapTargets(world)`. Fixture transforms are plain yaw quarter-turns; any other transform still draws but offers no snap or focus target (P1 surfaces are axis-aligned).
- **A level is a world document** (`content/levels/workshop.json`), loaded with `migrateWorld`. A new game copies it with its own seed, difficulty and tick 0 (`newGameWorld`). The game bundles the level (`@controls/content/levels/…`), and `sim-cli` reads the file (`--world`, `hash`).
- **No `schemaVersion` bump.** v1 is unpublished until v0.2.0, so the field was added to v1 with every fixture, the JSON Schema export and the arbitraries updated in the same change. It changes every `world.hash` (an empty world now serialises `"fixtures":[]`); all golden hashes were re-pinned together.
- **Rejected:**
  - _Fixtures as entities_ (`prop.stud-wall` in `entities`): every entity command would need a "fixed" refusal, the level would consume entity ids 1 to 7 (every scenario's ids would shift), and walls and rails would get `entity-N` view ids instead of `stud-wall` and `din-rail-1`.
  - _Level geometry only in code_ with a level id in `extensions`: a save wouldn't describe its own room, `extensions` is for data the schema doesn't model, and a level edit would silently change what an old save looks like.

## Consequences

- `world-model` (F1.2) infers its types from `World`. It must restore `nextEntityId` when undoing a place, keep `entities` sorted, and implement sfc32, the stream derivation and the SHA-256 canonical hash as specified here.
- F1.2's command registry must accept the command-id grammar used by the replay log, and `args` must be JSON objects.
- F1.1's settings UI writes `Settings` documents and must enforce the caps itself (console history 200, palette recents 20). An over-cap file fails validation, and the whole file then falls back to defaults.
- F1.8b adds the ZIP container and I/O on top of these documents. v1 can still change until v0.2.0 ships, and is frozen from then on.
- Adding a region (IEC) or a difficulty is a schema change, even though it only widens an enum. An older build must refuse such a save rather than misread it.
- F1.9: entity commands never touch `fixtures`, so a replay log's `initialWorld` carries the level it started on. A level edit after v0.2.0 is a content change, not a schema change: old saves keep their own fixtures. P3's cuttable DIN rails and catalogue entries will either keep the `prop.*` fixture refs at version 1 or migrate them.
