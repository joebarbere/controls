# ADR 0013: World document v2

**Status:** Accepted (2026-10-30). P2 kickoff step 5, the world v2 and minimal connectivity PRs (decisions D2, D3, D4, D8). Frozen once v0.3.0 ships.
**Review:** `sim-engine-engineer` (the bag split, `MODEL_KINDS` and the solution record) and `electrical-realism-reviewer` (catalogue v1 values) approved with notes, applied in the same PRs: the materialisation scope, the empty-netlist rule, the rebase caveat, the null-initial convention, lead state in v3 and the `endTick` load check below.
**Date:** 2026-10-30 (Phase 2)
**Sources:** [phase 2 plan](../../plans/phase-2-circuit-engine.md) decisions D2–D4 and D8 and the kickoff world v2 section; [ADR 0011](0011-sim-worker-contract.md) §1, §3, §9.6, §10, §12 and its Consequences ("Requirements on ADR 0013"); [ADR 0004](0004-save-format.md) (save format rules); [ADR 0007](0007-world-document-v1.md) (v1, ids, hash, replay log); [save-format caveats](../caveats/save-format.md)

## Context

P1's world (`schemaVersion` 1, ADR 0007) is a list of props. P2's simulator needs three more things persisted: what is wired to what (D2: test leads, made with `lead.connect`), the state of each device (a switch's position, a battery's charge), and enough of the last electrical solution that a save made between solves continues bit-exactly (ADR 0011 §9.6). D3 chose one `schemaVersion` 2 for the whole phase, so new device kinds must fit without further bumps. D4 chose a minimal device catalogue now, so device data lives in one auditable place. ADR 0011 fixed who owns which state and how replay, `firstSeq` and `endTick` work; this ADR records the persisted shapes.

## Decision

### One `schemaVersion` 2

`world.json`, `manifest.json` and `replay.log` all move to `schemaVersion` 2 (ADR 0007's rule), with a total, pure v1 → v2 migration. v1 schemas and fixtures stay untouched; every v1 fixture migrates and validates.

### `WorldV2`

`{ schemaVersion, seed, tick, nextEntityId, nextConnectionId, regionId, difficulty, assisted, fixtures, entities, connections, sim, extensions }`. Fixtures and transforms keep v1's schemas.

- **`EntityV2`** is v1's entity plus two device state bags (ADR 0011 §1):
  - **`state`** (commanded): written only by commands, such as a switch's `closed`;
  - **`sim`** (sim-owned): written only by `materialiseWorld` when a save or `world.hash` is taken, such as a battery's `stateOfCharge`. The live world's copy is inert: nothing reads it during play.

  Both are records of named values: keys `^[a-z][a-zA-Z0-9]*$` (at most 64 characters, at most 64 keys), values a finite number (`-0` normalised), a boolean, a `SafeString` of at most 32 characters, or `null` for absent (never a missing key). The world schema checks only this generic shape (`DeviceStateBag` in `primitives.ts`), so **a new device kind never needs a `schemaVersion` bump**.

- **`ConnectionV2`** `{ id, ref, a, b, extensions }`: a two-ended connection between terminals, `TerminalRef` `{ entity, terminal }`. `ref` names a catalogue entry of a connection kind (P2: the test lead). P3's wires arrive in world v3, alongside leads, not instead of them. **Connections have no state bags in v2**: a lead's own state (its conductor temperature, a termination's quality) arrives with world v3 in P3. A connection with an end on an entity the netlist leaves out (an unknown ref) is left out too.
- **`sim`**: the solution record `{ lastSolveTick, topologyHash, nodes, branches, islands: { flags, iterations }[] }` or `null`. Nodes and branches are interleaved `re, im` pairs in F2.1's order, which is canonical: a pure function of the world, independent of the incremental-recompile history. It is in `world.hash` (decision U3). The engine checks `topologyHash` and the lengths against the compiled netlist when it starts; a mismatch is `start-failed`, never a silent re-solve (F2.3a), **except** for a save from another engine or catalogue version (D8), whose record is always dropped (`sim: null`, solved again at the save's tick, the log restarted as `engine-changed`; amended in F2.4: dropped even when it fits, so no reading comes from another engine's models): such saves are never refused. Its devices' `sim` bags are kept. An island's `iterations` of 0 means it was not solved (AC before F2.2 part 2, mixed, or unmodelled): its values are zeros and no reading. `null` means "not solved since the session started", **and a world whose netlist is empty exports `sim: null`**, never an empty record. "Empty" means exactly `isEmptyNetlist(netlist)`: the netlist has no nodes (`nodes.length === 0`). The order and the hash are defined in [Solution order and `topologyHash`](#solution-order-and-topologyhash).

Schema invariants (refinements, not in the JSON Schema): entities, fixtures and connections are each sorted by strictly ascending id; entity ids are below `nextEntityId` and connection ids below `nextConnectionId`; each connection's ends are entities that exist and two different terminals (two terminals of one entity are allowed: a jumper); `sim.lastSolveTick ≤ tick`, and `nodes` and `branches` have even lengths. So each world still has one serialised form, and nothing dangles.

### Connection id allocation

The same rule as entity ids (ADR 0007), with its own counter:

- a connection's id is the world's **`nextConnectionId`**, which `lead.connect` then increments; undoing the connect restores the counter;
- disconnecting never decrements it, and undoing a disconnect reinserts the connection with its **same id** (and data);
- deleting an entity removes every connection with an end on it, in the same change, and undoing the delete restores them with their ids (plan F2.1: a lead is never left to be compiled silently);
- a separate counter, not `nextEntityId`, so connecting leads never shifts the ids a script's later `entity.place` calls get.

So an id can be reused only after the connection that held it was undone out of existence, and "undo everything returns the initial hash" still holds for sessions in which no time passed.

### Solution order and `topologyHash`

Added with F2.1 (`netlist/compile.ts` and `netlist/hash.ts` in `@controls/sim-core`), on `save-format-guardian`'s review.

**Canonical order.** The order of `sim.nodes` and `sim.branches` (and of the snapshot payload) is a pure function of the world, never of the edit or recompile history:

- terminals are ordered by entity id (numerically), then terminal id (UTF-16 code units);
- a node is a set of terminals joined ideally (union-find over closed switches and terminals a device joins internally); nodes are numbered by their smallest member terminal;
- branches are every netlisted entity's elements (entity id, then part name in code units), then every netlisted connection by id, exactly one branch each;
- islands are connected components over the branches, numbered by their smallest node.

**What `topologyHash` covers.** SHA-256 (the pure implementation in `@controls/world-model`) over a canonical byte encoding, lower-case hex. It covers:

- the partition: every node's member terminals `(entity, terminal)`, in node order;
- per branch, in branch order: the element ref (entity and part, or connection id), the element-kind code, the source domain (none, DC or AC), the model kind and the two end nodes.

It leaves out every value (resistances, setpoints, nameplates), so a value-only change keeps the hash, and the islands, which follow from the partition and the branch ends.

**Versioning.** The encoding starts with the header `CNT` and a version byte (1). Changing the encoding (a field, its order, a code table) bumps that byte and `SIM_ENGINE_VERSION` together. So does any change to a built-in `DeviceNetlistModel` or `ConnectionNetlistModel` that changes the structure it produces: its terminals, parts, joins, element kinds, source domains or `simTopologyKeys`. Either change moves every persisted `topologyHash`. `hash.spec.ts` pins one golden per built-in model kind, so such a change can't land silently.

### Materialisation

`materialiseWorld(busWorld, export)` (`sim-protocol`, ADR 0011 §1) **overwrites only the `sim` bags of the entities the engine netlisted** and `WorldV2.sim`. Every other bag (props, unknown refs, and every `state` bag) is copied from the bus world unchanged.

**`null` initial values.** A `sim` key whose `MODEL_KINDS` initial value is `null` (the lamp's `filamentTempK`) means "not yet simulated". The engine initialises it when the device enters the netlist, from the device's params or a sourced `sim-core` constant (an ambient temperature), and never exports `null` for it after that. The key stays nullable in its schema, because a world saved before the engine first ran holds `null`.

### The device catalogue and `MODEL_KINDS` (D4)

- **Catalogue entries** live in `content/devices/<id>.v<version>.json` (`DeviceDefinition` in `@controls/catalog`): id and version, title, a fictional brand and model name, category, size, terminals `{ id, label, positionMm }`, the model `{ kind, params }`, controls and `sources[]`. Every parameter, the size and the terminal layout must be covered by a source; loading refuses an entry that isn't. `prop.*` stays built in (`world-model`).
- **The catalogue is mirrored into code.** Domain code can't import `content/` (`type:content` is data for apps), and the game, the sim worker and `sim-cli` must resolve refs identically, so `@controls/catalog` holds a generated copy (`builtin-devices.generated.ts`) with a staleness test, like the JSON Schema exports. The JSON files stay authoritative. The plan didn't say how the catalogue reaches domain code; this is the choice (alternatives below).
- **`MODEL_KINDS`** declares, per kind, its parameters' schema, its terminals and every state key: owner (`commanded` or `sim`), value type, Zod schema and initial value. Adding a kind is no bump. **Changing an existing kind's keys** (adding, removing, renaming, narrowing, or changing an owner) **is a `schemaVersion` bump** with a migration of every save's bags. `json-schema/device-state.<kind>.schema.json` (in `@controls/catalog`) is the frozen record of each kind's bags.
- **`catalogVersion` 1** is the P2 set: a 12 V 7 Ah sealed lead-acid battery, a 12 V 5 W incandescent lamp, an SPST toggle switch and a 1 m test lead (amended in F2.4: plus the bench and DIN-rail supplies and the utility services, still version 1 until v0.3.0; the full list is `docs/history.md`'s catalogue table). Like a schema version, it may change until v0.3.0 ships (F2.4 and F2.5 finalise their kinds) and is frozen from then on.
- **Lead resistance** is derived, never tabulated: `R(T) = ρ₀ · L / A · (1 + α (T − T₀))` plus the contact resistance at each end (`leadResistanceOhm`), using only `+ - * /` (D6).

### The load check: `invalid-device-state`

The world schema can't know the catalogue, so `loadGame` and `createGame({ world })` run `checkWorldDevices` (`world-model`) after the schema (ADR 0011 §10 step 1):

- an entity whose ref resolves to a catalogue device has exactly its kind's keys in each bag, each valid for its key;
- a built-in prop has empty bags;
- **an entity or connection whose ref the catalogue doesn't know is left alone**: its bags round-trip untouched, like `extensions`, and the netlist compiler treats it as absent. A save that uses a missing mod's device still loads;
- a connection's ref, if known, is a connection kind; each end's terminal exists on its entity's device; an end on a built-in prop is refused.

A failure is the load error `invalid-device-state` (`LoadGameError` in `@controls/scripting-api`, with value-free issues), handled in `loadErrorReason`'s exhaustive switch.

### `ManifestV2`

v1's manifest plus **`simEngineVersion: Int`** (D8): `SIM_ENGINE_VERSION` from `@controls/sim-core`, bumped whenever snapshot or world goldens are re-pinned for numeric reasons. A save whose `simEngineVersion` or `catalogVersion` differs from the build's loads with a restarted log (`engine-changed`), never refused, except that a save with both at 0 (a migrated P1 save) is verified first (narrow v0 compatibility, Consequences). `catalogVersion` is now the built-in catalogue's (1). The caller supplies both to `createManifest` (save-format depends on neither); `createSaveManifest()` in the scripting API is what `Game.save` writes.

### `ReplayLogV2`

`{ schemaVersion, initialWorld, firstSeq, entries, endTick }`, entries unchanged (`{ seq, tick, id, args }`):

- **`firstSeq`**: `entries[i].seq === firstSeq + i`. A rebased or restarted log keeps its numbering, so `seq`-keyed randomness stays put. `CommandBus` gains the `firstSeq` option and `nextSeq()`, the one source of `seq`s (ADR 0011 §3).
- **`endTick`**: `endTick ≥ last entry tick ≥ … ≥ initialWorld.tick`; a lower one is refused. "State at T" is as ADR 0011 §3 defines it. Advancing to `endTick` on replay arrives with the time host in F2.3a; until then no time passes, and `toReplayLog` writes the bus's current tick.
- **A restarted log continues the numbering**: when a save's log doesn't reproduce its world, the new log starts at the dropped log's next `seq` (ADR 0011 §10).
- **Rebasing** (`rebaseReplayLog(log, count)`) starts a log from the world it reaches after `count` entries, sim bags and solution record included, at `firstSeq + count`. It is exact where no later undo or redo reaches across the cut, which is always true at a load; a property test shows a log rebased at a load point replays to the same hash. Groundwork for the P1 follow-up "the replay log never shrinks" (the cap-triggered rebase is P4).
  - **It is exact only before the engine runs, or when given a materialised world.** Replaying commands reaches the bus world, whose `sim` bags are inert; once time has passed, the true state at the cut also holds what the engine computed. So the P4 rebase must take the materialised world at the cut (for example `rebaseReplayLog(log, count, worldAtCut)`, from a `state` query at that tick) instead of the replayed one. The signature is left as it is until then.
- **A save's `world.json` is at the log's `endTick`.** `readCtrl` refuses a container whose `replay.log` `endTick` differs from `world.json`'s `tick` (`end-tick-mismatch`), and `writeCtrl` refuses to write one: the saver captures both at the same tick (ADR 0011 §9.5), so a mismatch is a damaged or hand-edited save, like `version-mismatch`. (A log that merely fails to reproduce the world still loads with a restarted log, ADR 0007.)

### The v1 → v2 migration

Each entity gets `state: {}` and `sim: {}`; the world gets `nextConnectionId: 1`, `connections: []` and `sim: null`; the log gets `firstSeq: 0` and `endTick: max(initialWorld.tick, last entry tick)`; the manifest keeps its `catalogVersion` (0 in every P1 save) and gets `simEngineVersion: 0`, meaning "written before the engine". The migration doesn't read the catalogue (it must stay pure and frozen).

### Hash scope

`world.hash` is still SHA-256 over the canonical JSON of the parsed world document (ADR 0007), which now includes both bags, connections, `nextConnectionId` and the solution record. `-0` is normalised by the schema, and every number is finite. Because every world now serialises `"connections":[]`, `"nextConnectionId":1` and `"sim":null`, **every golden hash was re-pinned once**, in one change (the CHANGELOG lists them). A property test checks every sim number survives JSON under `Object.is`.

### Command ids and arguments (PR 3)

`lead.connect {ref, a, b}`, `lead.disconnect {id}` and `device.operate {id, control, value}`, and the argument schemas of `sim.setSpeed`, `sim.resume` and `sim.step` (ADR 0011 §13), are save format from the moment they are logged. Their argument JSON Schemas are frozen in staleness-checked exports (kickoff PR 3).

## Consequences

- `world-model`: `entity.place` gives a catalogue device its kind's initial bags (props and unknown refs get empty ones) and refuses a connection kind (`not-placeable`); `entity.delete` removes the entity's connections in the same change. `createWorldRegistry({ catalog })` takes the catalogue (default the built-in one). Property tests: every change keeps `tick`, the solution record and each surviving entity's `sim` bag; a rebased log replays to the same hash.
- `@controls/commands`: `CommandBusOptions.firstSeq` and `CommandBus.nextSeq()`. `advanceTo`, `withTick` and replay advancing stay F2.3a's.
- `@controls/sim-core`: `SIM_ENGINE_VERSION` (1).
- **A known edge:** a P1 save whose entity happens to use a catalogue v1 id (only reachable by typing one in the console) migrates with empty bags and is then refused as `invalid-device-state`. The migration can't fill the bags because it can't read the catalogue.
- **D8 for P1 saves (decided 2026-10-30):** a migrated P1 save has `simEngineVersion` 0 and `catalogVersion` 0, so D8's literal "differs from the build" would restart every P1 log though P1 saves hold no sim state. **Narrow v0 compatibility** (decided 2026-10-30 in the world v2 review): a save with `simEngineVersion === 0 && catalogVersion === 0` (a migrated P1 save, which holds no sim state) is verified as normal; if verification fails it falls back to `replay.status: 'restarted'` with reason `engine-changed`, never a refusal. Any other mismatch, including a single 0 on its own, stays `engine-changed` as above. The check is a pure, tested `engineCompatible(manifest, build)` in `scripting-api` (F2.3a). It relies on the empty-netlist rule: a world with no netlist exports `sim: null` (ADR 0013), so a P1 world verifies to the same hash.
- Fixtures under `fixtures/v2/`: worlds (empty, props and extensions, devices with `sim: null`, a bench lamp mid-interval with a blown and a partly melted fuse, 17-digit floats, a subnormal and a tick above 2³¹), manifests, replay logs (`endTick` past the last entry, `firstSeq > 0`, empty), `.ctrl` saves from `pnpm sim run … --save`; `refused/` (an `endTick` before the last entry) and `start-failed/` (a solution record whose lengths don't match the netlist: valid schema, refused when the engine starts).

## Alternatives considered

- **Connections share `nextEntityId`.** One counter, but every lead would shift the ids of later entities, breaking scripts that count on them.
- **One state bag, with ownership by convention.** Simpler, but the engine and commands would both write it, and a save made mid-sim couldn't be told apart from a commanded change (ADR 0011 §1).
- **Per-kind typed state in the world schema.** Exact JSON Schema, but every new device kind would be a `schemaVersion` bump (D3 rejected it).
- **Refusing entities with unknown refs.** Stricter, but a save would be lost when a mod is missing; unknown refs round-trip like `extensions` instead.
- **Reading `content/devices` at run time in each host** (the game bundling it, `sim-cli` reading files, the worker receiving it by message). No generated file, but every host and every domain test would have to load and pass the catalogue, and a host that forgot would resolve refs differently. A generated mirror with a staleness test gives one catalogue everywhere; mods can add a run-time layer later.
- **Letting `type:domain` import `type:content`.** It would loosen a module boundary that is proven to fire.
- **A separate `schemaVersion` 3 for sim state.** Two migrations in one phase (D3 rejected it).
