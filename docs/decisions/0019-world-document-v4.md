# ADR 0019: World document v4 and the residential contract

**Status:** Accepted (2026-11-17). P4 kickoff step 3, the agent-team contract. Drafted by `save-format-guardian` (lead). `schemaVersion` 4, `catalogVersion` 3, `SIM_ENGINE_VERSION` 8 and `SIM_PROTOCOL_VERSION` 8 stay provisional until v0.5.0 ships, then they are frozen. World v4's schemas, migration and load checks landed in P4 PR 7 ([implementation notes](#implementation-notes-p4-pr-7-2026-11-18)).
**Review:** `sim-engine-engineer`, `renderer-engineer`, `angular-ui-engineer` and `content-designer` each approved with changes; every required change is applied below (see [Review](#review)). One conflict (the directory `space` bound) was resolved in review.
**Amended by:** [ADR 0020](0020-catalogue-format-v3.md) (deviations 1, 2, 4, 5: a device contact names its host contact (`host`); a contact's resistance is sourced at `fits.<type>.contacts.<id>.contactOhm`, not `mounts.<type>…`; R5 is resolved by a top-level `hostMounts`; a bus column lists its `legs` in stab order instead of a "reversed" flag).
**Date:** 2026-11-17 (Phase 4)
**Sources:** [phase 4 plan](../../plans/phase-4-residential.md) kickoff step 3, decisions D1–D5, D7, D8, D10, D12, D14, D18, the "Kickoff PRs" section and the [pre-audit outcome](../../plans/phase-4-residential.md#pre-audit-outcome-2026-11-17); [ADR 0004](0004-save-format.md) (save format rules); [ADR 0007](0007-world-document-v1.md) (ids, hash, PRNG, replay log); [ADR 0011](0011-sim-worker-contract.md) §1, §4, §5.4, §7, §9.6, §12 and its protocol 6 and 7 amendments; [ADR 0013](0013-world-document-v2.md) (bags, `MODEL_KINDS`, the load check, `topologyHash`); [ADR 0015](0015-world-document-v3.md) (v3, the precedent for this ADR's structure); [ADR 0016](0016-catalogue-format-v2.md) (catalogue v2); [ADR 0018](0018-conductor-and-termination-physics.md) (the bucket-draw pattern, events, persisted contact state); [save-format](../caveats/save-format.md), [commands](../caveats/commands.md) and [simulation](../caveats/simulation.md) caveats. Grounded in the code at v0.4.0: `libs/domain/save-format/src/lib/v3/*`, `world-model` (`checkWorldReferences` in `devices.ts`, `wiring/mounting.ts`, `wiring/in-entry.ts`, `prng.ts`, `device-commands.ts`), `sim-core` (`netlist/compile.ts`, `netlist/hash.ts`, `devices/sources/netlist-models.ts`, `engine/device-model.ts`, `mna/ac.ts`, `thermal/regimes.ts`), `catalog` (`model-kinds.ts`, `registries.ts`).

## Context

World v3 (ADR 0015, frozen by v0.4.0) holds real wiring: conductors with terminations, cables, routes, what each device is mounted on (`mountedOn`) and which entry a conduit connector is in (`inEntry`). The compiler reads none of the relations: a mounted device conducts only through what is landed on its terminals.

P4 wires a house, and two physical facts can no longer be ignored: a breaker conducts from the bus only because it is clipped onto a stab, and a metal box or a yoke is bonded only through what is mounted or landed; an appliance draws only when its cord is plugged in. The plan's D3 makes the compiler read these relations. Around that, P4 adds things a save must hold: a cord plug in an outlet, re-identification tape on a conductor end, level zones the inspector reads, a lamp that burns out for good, and the state of breakers, GFCIs and AFCIs that must survive a save mid-trip.

Five teams build against this at the same time:

- `sim-engine-engineer` compiles the relations into the netlist, adds remote earth and the T-equivalent, and writes breakers v2, GFCI and AFCI (engine 8, ADR 0021);
- `renderer-engineer` draws plugs, cords, tape and bus stabs, snaps breakers and bulbs, and drives audio;
- `angular-ui-engineer` builds the palette and console forms for the new commands, the panel and plug UI and the directory editor;
- `content-designer` writes catalogue v3 (ADR 0020) and every new entry;
- the main agent writes the commands and the inspector.

This ADR fixes the persisted shapes, the commands, what the compiler reads, the stream keys, the hash scope, the migration and the contract-level protocol 8 changes, so each team can build against fixtures before the others land. Where the plan was ambiguous or, on inspection, wrong, the choice is made here and listed in [Deviations from the plan](#deviations-from-the-plan); the plan is corrected in the same PR.

## Decision

### One `schemaVersion` 4

`world.json`, `manifest.json` and `replay.log` move to `schemaVersion` 4 together (the one-version rule), with a total, pure v3 → v4 migration. v1, v2 and v3 schemas and fixtures stay untouched. The `.ctrl` entry layout doesn't change. `ManifestV4` is `ManifestV3` with `schemaVersion: 4` (an identity step).

The sketches below are TypeScript-like for reading. The Zod schemas in `libs/domain/save-format/src/lib/v4/` are authoritative, every object is strict, and no field is optional (absent is `null`). Primitives as in ADR 0015, plus:

```ts
type OutletId = string; // TerminalId's grammar, unique within the receptacle's catalogue entry
type AreaId = string; // FixtureIdV1's grammar (lower-case, hyphenated, at most 64), not starting with `entity-`
type AreaUseId = string; // CAMEL_ID_PATTERN, a row of the catalogue AREA_USES registry
```

Each is a new primitive (`OutletId`, `AreaId`, `AreaUseId` with `.meta({ id })` names of their own). No existing primitive is tightened.

### `WorldV4`

```ts
interface WorldV4 {
  schemaVersion: 4;
  seed: Int;
  tick: Int;
  nextEntityId: Int;
  nextConnectionId: Int;
  nextCableId: Int;
  nextTerminationId: Int;
  regionId: RegionId;
  difficulty: Difficulty;
  assisted: boolean;
  fixtures: FixtureV1[];
  areas: AreaV4[]; // new
  entities: EntityV4[];
  connections: ConnectionV4[];
  cables: CableV3[]; // unchanged
  sim: SimSolutionV2 | null; // unchanged (ADR 0011 §9.6)
  extensions: Extensions;
}
```

No new counter: nothing P4 adds has an identity of its own (a plug is a relation; tape belongs to a conductor end; an area's id is a level-authored string).

### `EntityV4.pluggedInto`

```ts
interface EntityV4 {
  id: EntityId;
  ref: CatalogRef;
  transform: TransformV1;
  state: DeviceStateBag;
  sim: DeviceStateBag;
  mountedOn: MountedOnV3 | null;
  inEntry: InEntryV3 | null;
  pluggedInto: { entity: EntityId; outlet: OutletId } | null; // new
  label: LabelText | null;
  extensions: Extensions;
}
```

- **A relation, not a transform** (D1): the appliance stays where it was placed; nothing inherits the receptacle's transform. It lives on the plugged entity (the appliance, or a power strip's own cord), like `mountedOn` and `inEntry`.
- **`outlet`** is an id from the receptacle entry's `outlets[]` (catalogue v3, ADR 0020): a duplex 5-15R has `top` and `bottom`. Outlet ids are save format per entry version from v0.5.0 (a renamed or removed outlet needs a new entry version), like mount and entry ids.
- **Exclusive with the other relations:** an entity with `pluggedInto` has `mountedOn: null` and `inEntry: null`. The load check also refuses a catalogue entry that both fits a mount and has a plug (a relaxable rule: relaxing it later changes no old save).
- **Nothing about a plug is stored beyond the relation.** The cord's drawn shape is a picture, never persisted. **Reach is straight-line** (below): a cord may pass through framing. That is a documented abstraction, like the drawn length of a route.

### `ConnectionV4.marking`

```ts
interface ConnectionV4 extends ConnectionV3 {
  marking: { a: ColourId | null; b: ColourId | null }; // new: re-identification tape at each end
}
```

- **Tape on a conductor end** (Art. 200.7 by number), set by `wire.mark`. It belongs to the conductor end, not to the termination: it survives `wire.unland`, `wire.land` and a re-made termination, and goes with the connection on delete and its undo.
- **A lead has `{ a: null, b: null }`** (it stays lead-shaped; invariant below). A cable conductor may be marked (the usual case: the white of a 14/2 switch loop re-identified as hot).
- **Colours are colour-table ids** (append-only table, ADR 0015). The schema checks the grammar; the load check checks the table and refuses `bare` (not a tape colour). Which colour is _correct_ is the inspector's, never the load check's.
- **Neither the compiler nor the engine reads it.** Tape is for the inspector and the renderer.

### `WorldV4.areas`

```ts
interface AreaV4 {
  id: AreaId;
  use: AreaUseId; // 'kitchen' | 'bathroom' | 'garage' | … from the AREA_USES registry
  minMm: PositionMm; // inclusive corner
  maxMm: PositionMm; // exclusive corner; strictly greater than minMm on every axis
}
```

- **Level data for the inspector's location rules** (210.8(A), 210.12(B), 404.2(C) by number). No command creates, moves or deletes an area in P4; levels author them and they round-trip through saves. `sim-core` never reads them.
- **Axis-aligned boxes in integer mm**, half-open `[min, max)` on each axis, so two areas sharing a wall face don't both contain the face. Areas may overlap; a point in two areas has both uses (the inspector applies the rules of each).
- **`use` is a registry id, not a closed enum** (deviation 4): `AREA_USES` in `@controls/catalog` is append-only across catalogue versions, like the colour table. Its first rows: `kitchen`, `bathroom`, `garage`, `outdoor`, `laundry`, `bedroom`, `living`, `hall`, `basement`, `crawlSpace` (`basement` replaces the plan's `unfinishedBasement`: whether a basement is finished is a rule parameter, not a use). A new use is then a catalogue addition, not a `schemaVersion` bump. The load check refuses an id the registry lacks.
- At most `MAX_AREAS` = 256 (game-design: a large house has a few dozen rooms).

### Sim and commanded state keys

ADR 0013's rule holds: **a new model kind's keys need no `schemaVersion` bump; changing an existing kind's keys does.** P4 changes exactly one existing kind, `lamp.incandescent`, so its migration rides on this bump. Every other key below belongs to a new kind and enters saves with it.

**The governing rule for what is persisted** (the save-and-load property, simulation caveats): a bag holds everything that affects the device's future, including the timing of its events. A value that is a pure function of `(seed, entity id)`, the catalogue entry, the world's relations or the tick is derived at every bank build and never stored. So a save at any tick, loaded and advanced, equals running straight through (`world.hash`, `snapshotHash` and the event list).

Catalogue v3 adds two state value types (ADR 0020): **`text`**, a nullable `LabelText` (the directory), and **`counter`**, a non-negative integer (momentary controls). Models project their topology keys to booleans (a since-tick is "null or not"), and the compiler's structure key for them becomes a non-allocating numeric code in PR 9 instead of today's JSON-stringified keys, measured against `intermittent-toggle-wired`.

The key sets of the new kinds are **provisional until v0.5.0** and finalised by ADR 0021 (as ADR 0018 finalised the v3 connection keys), with fixtures updated in the same PR. Key names and value types are save format from v0.5.0.

#### Persisted (in the `sim` bag unless stated)

| Kind(s)                                                      | Key                          | Type, initial                                                                | Why persisted                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lamp.incandescent` (existing kind)                          | `burnedOut`                  | boolean, `false`                                                             | Sticky (D1): the filament opened at the sim-core constant `LAMP_BURNOUT_K` (at most `LAMP_FILAMENT_MAX_K`, 3600 K; game-design below tungsten's melting point) and never closes. A topology key (an open filament has no element).                                                                                     |
| `lamp.incandescent`, `light.*`, `appliance.*`                | `overvoltageSinceTick`       | integer ≥ 0 or `null`, `null`                                                | The first tick of the current excursion above ANSI C84.1 Range B for the device's rated-voltage class (F4.4). The `overvoltage` event fires after a sourced dwell from it; without it a save mid-dwell would move the event. Always `null` for a device whose rated voltage has no region range (the 12 V bench lamp). |
| `light.led`, `light.ledFixture`                              | `running`                    | boolean, `false`                                                             | The constant-power driver's state, with hysteresis around its dropout (game-design thresholds inside the sourced ~90 V), committed in `afterSolve` (the F2.4 rule) so a save inside the hysteresis band reloads into the same state.                                                                                   |
| `breaker.plugOn1p`, `breaker.gfci1p`, `breaker.afci1p`       | `thermal`                    | number ≥ 0, `0`                                                              | The bimetal's state (the P2 law, D6). A part-heated breaker must reload part-heated.                                                                                                                                                                                                                                   |
| `breaker.plugOn2p`                                           | `thermalL1`, `thermalL2`     | number ≥ 0, `0`                                                              | One bimetal per pole, common trip (D6).                                                                                                                                                                                                                                                                                |
| every breaker kind above                                     | `tripped`                    | boolean, `false`                                                             | As the DIN breaker (P2). Cleared by the handle going off (the `commanded` hook).                                                                                                                                                                                                                                       |
| same                                                         | `tripCause`                  | `'thermal' \| 'magnetic' \| 'groundFault' \| 'arcFault' \| 'test'` or `null` | Why it is tripped, so a reloaded panel shows the same cause and records stay a function of the export. `null` exactly when not tripped.                                                                                                                                                                                |
| same                                                         | `magneticSinceTick`          | integer ≥ 0 or `null`, `null`                                                | The tick of the protection step that first saw the current above the drawn pickup in the current excursion (D6). The breaker opens at it plus its drawn opening time, so a save inside the 8–20 ms window opens at the same tick. Cleared below the pickup.                                                            |
| `receptacle.gfci`                                            | `latched`                    | boolean, `false`                                                             | Whether the contacts are latched closed. **A new GFCI starts unlatched**: it closes only on a reset with line power, so one fed on its load terminals never conducts (D7). Opened by a trip or a test.                                                                                                                 |
| `receptacle.gfci`                                            | `tripCause`                  | `'groundFault' \| 'test'` or `null`                                          | As the breakers'. `null` while latched and on a GFCI that has never latched.                                                                                                                                                                                                                                           |
| `receptacle.gfci`, `breaker.gfci1p`                          | `residualIntegral`           | number 0–1, `0`                                                              | The inverse-time integral Σ dt / t(I) (D7), **clamped at 1** (a trip floored by the mechanism time can reach 1 before it opens). Reset to 0 when the residual falls below the drawn pickup.                                                                                                                            |
| same                                                         | `residualSinceTick`          | integer ≥ 0 or `null`, `null`                                                | The first tick of the current excursion above the pickup: the trip is floored at it plus the drawn mechanism time (D7).                                                                                                                                                                                                |
| same                                                         | `testHeldSinceTick`          | integer ≥ 0 or `null`, `null`                                                | The test contact is closed (its internal resistor in circuit, a topology key) from a `test` press until the device trips or `GFCI_TEST_HOLD_TICKS` pass (about 1000, game-design, fixed in ADR 0021).                                                                                                                  |
| `breaker.afci1p`                                             | `arcExposure`                | number 0–1, `0`                                                              | Σ Δt / T_limit(I) over the arcing buckets in which a downstream end arcs at I ≥ 5 A (D8; "only arcing buckets count" is game-design). The trip test at each bucket boundary uses it (below), so the cumulative trip probability reaches 1 by the UL 1699 limit.                                                        |
| `breaker.afci1p`                                             | `arcLastSeenTick`            | integer ≥ 0 or `null`, `null`                                                | The last bucket boundary at which a downstream end was arcing. `arcExposure` resets to 0 after a game-design quiet gap since it.                                                                                                                                                                                       |
| `receptacle.gfci` (commanded)                                | `test`, `reset`              | counter, `0`                                                                 | Momentary controls (D7): press counters, incremented only by `device.press`. In `world.hash` through the commanded bag.                                                                                                                                                                                                |
| `breaker.gfci1p`, `breaker.afci1p` (commanded)               | `test`                       | counter, `0`                                                                 | Their test buttons; reset is the handle.                                                                                                                                                                                                                                                                               |
| every breaker kind above (commanded)                         | `on`                         | boolean, `false`                                                             | The handle, as the DIN breaker's (`device.operate`, a toggle).                                                                                                                                                                                                                                                         |
| `enclosure.loadCentre` (commanded)                           | `directory1` … `directory42` | text, `null`                                                                 | The panel directory (D14), one key per space (deviation 5). Keys above the entry's `spaces` stay `null` (load check). **Never a control:** no `directory*` key is ever in a load centre's `controls[]`, so `device.operate` can't set one (`unknown-control`, tested).                                                 |
| `enclosure.loadCentre` (commanded)                           | `coverOn`, `openEntries`     | boolean `true`; as every enclosure                                           | The dead-front cover (a toggle). Added now, though nothing in P4 reads it, because P5's shock model will and adding a key to a shipped kind later is a migration (decided in review).                                                                                                                                  |
| `switch.wall1p` (commanded)                                  | `closed`                     | boolean, `false`                                                             | As `switch.spst` (a new kind: D10).                                                                                                                                                                                                                                                                                    |
| `switch.wall3way` (commanded)                                | `position`                   | `'t1' \| 't2'`, `'t1'`                                                       | Which traveller the common is on (a two-option selector).                                                                                                                                                                                                                                                              |
| `switch.wall4way` (commanded)                                | `position`                   | `'straight' \| 'crossed'`, `'straight'`                                      | A two-option selector.                                                                                                                                                                                                                                                                                                 |
| `dimmer.wall` (commanded)                                    | `on`, `level`                | boolean `false`; number 0–1, `1`                                             | A toggle and a setpoint (D10). The series reactance is derived from `level` at each solve, never stored.                                                                                                                                                                                                               |
| `appliance.resistive`, `appliance.constantPower` (commanded) | `on`                         | boolean, `false`                                                             | A toggle (D12).                                                                                                                                                                                                                                                                                                        |

`lamp.incandescent` keeps `filamentTempK`. The DIN `breaker.thermalMagnetic` keeps its P2 keys and behaviour (D6); it already emits `tripped` with `detail.cause` at engine 7, and its bag gains nothing.

#### Derived on load, never persisted

| Value                                                                                                | Derived from                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A plug-on breaker's magnetic pickup (per pole), its opening time; a GFCI's pickup and mechanism time | `(seed, entity id)` through the stream keys below, once per bank build (the P2 pickup precedent). Integer ticks for times, rounded up.                                                                                                                                                                                     |
| An appliance's duty-cycle phase                                                                      | `(seed, entity id)`, the `:duty` stream                                                                                                                                                                                                                                                                                    |
| AFCI per-bucket draws                                                                                | `(seed, entity id, bucket)`, integer mixing (below)                                                                                                                                                                                                                                                                        |
| An AFCI's downstream set (a cut set); `wiringGraph`                                                  | The compiled topology, **lazily**: the AFCI cut set only when some end is arcing                                                                                                                                                                                                                                           |
| Which bus leg a stab contact lands on                                                                | `busStabIndex` (below): `mountedOn`, the device's position and the host mount's pitch and leg pattern                                                                                                                                                                                                                      |
| Every contact, cord, earth and grounding resistance                                                  | Catalogue v3 data (values, never topology)                                                                                                                                                                                                                                                                                 |
| The dimmer's series reactance; an LED driver's admittance                                            | `level` (or `running`) and the solution, at each solve (value-only re-solves, D10, D11)                                                                                                                                                                                                                                    |
| Which press a counter change is                                                                      | The `commanded` hook compares the new counter with the bank's copy; a bank build adopts the saved counter as already seen                                                                                                                                                                                                  |
| Whether a GFCI reset latches                                                                         | Decided in the `commanded` hook at the press's tick **on line voltage only**, read from the last solution on a readable island (the bank gets read-only, engine-internal access to it). No pending key. A standing ground fault then re-trips through the normal path, no earlier than the mechanism time after the reset. |

**Undo never rewinds the simulator** (the P2 breaker rule, simulation caveats). Undoing a `device.press` restores the commanded counter; the hook sees the counter fall and does nothing. Redoing it raises the counter and presses again. Undoing a handle-off after a trip leaves the breaker reset, as for the DIN breaker.

### Commands

Every id and argument shape here is save format from the moment it is logged; the commands PR (PR 8) freezes each in `world-model/json-schema/command-args/<id>.args.schema.json`. Each is undoable, restores everything it changed on undo, and **never reads sim-owned state** (the existing property). None takes a tool in P4 (tape, a pen and a plug need none; gating later is a new command or argument version, as `raceway.cut` recorded).

```ts
'plug.insert':     { appliance: EntityId; receptacle: EntityId; outlet: OutletId }
'plug.remove':     { appliance: EntityId }
'wire.mark':       { id: ConnectionId; end: 'a' | 'b'; colour: ColourId | null } // null removes the tape
'panel.directory': { id: EntityId; space: Int; text: LabelText | null }    // space ≥ 1, no maximum; null clears
'device.press':    { id: EntityId; control: DeviceStateKey }               // a momentary control
// unchanged ids and argument schemas: every P3 command
```

- **The freeze rule is unchanged:** a hint-only `.meta()` change regenerates the frozen schema (`-u`) and needs no bump. The SHA-256 pins of the P3 argument schemas (`command-args.spec.ts`) hash a **hint-stripped** copy, so adding a hint never trips them; any acceptance change does.
- **Palette hints** (land with or before PR 8): `plug.insert` takes entity refs `appliance` and `receptacle` and `outlet` with `x-controls-options: { from: 'outlets', entity: 'receptacle' }`; `plug.remove {appliance}` an entity ref; `wire.mark` a `connection` ref and a nullable `colour` with `x-controls-options: { from: 'colours', except: ['bare'] }`; `panel.directory` a nullable `text` and `space` options `{ from: 'directorySpaces' }`; `device.press` `control` options `{ from: 'controls', type: 'momentary' }`. **`x-controls-options` is form-only: it never changes what a command accepts.** Only the first ref field of each kind is prefilled from the selection.
- **Console argument order** (ADR 0008 positional form): `plug.insert <appliance> <receptacle> <outlet>`, `plug.remove <appliance>`, `wire.mark <id> <a|b> <colour|null>`, `panel.directory <id> <space> "<text>"|null` (a bare `null` clears; a quoted `"null"` is the text null), `device.press <id> <control>`.
- **`plug.insert`** sets the appliance's `pluggedInto`. It checks, in this order (only refused versus accepted is replay format, never which code): the appliance exists (`not-found`) and its entry has a `plug` (`not-an-appliance`); it isn't already plugged (`already-plugged`: remove first, so one gesture is one command); the receptacle exists (`not-found`) and its entry has `outlets` (`not-a-receptacle`) with that id (`unknown-outlet`); nothing is in that outlet (`outlet-occupied`); `NEMA_CONFIGS` says the plug mates the outlet (`wrong-configuration`: a 5-20P won't enter a 5-15R); both entities are at quarter-turns (`not-axis-aligned`); and the cord reaches (`out-of-reach`: `d² ≤ cordLengthMm²` in integers, d from the appliance's catalogue cord exit point to the outlet's face point, both through `entityPointMm`). The check is exported as **`checkPlugInsert`** with **`plugReach`** for live hints; surfaces pre-check a gesture with `precheck(registry.get('plug.insert'), …)` (the command's own `run`).
- **`plug.remove`** clears it (`not-found`, `not-an-appliance`, `not-plugged`).
- **Occupancy.** A plugged appliance can't be moved or rotated (`plugged`; unplug first). A receptacle holding a plug is `occupied` for `entity.move` and `entity.rotate`. **`entity.delete` of a receptacle unplugs everything in it** in the same change, and **deleting an appliance takes its plug with it**; undo restores every relation exactly. A host with a bulb or breaker mounted on it stays `occupied` (P3 rule). `entityHold` returns `plugged` or `occupied`; **`moveBlocker(world, id)`** (`plugged | occupied | null`) is exported so the UI can refuse at pick-up; `WorldPlacementFailure` gains `plugged`.
- **`wire.mark`** sets one end's tape (`not-found`, `not-a-wire` on a lead, `unavailable-colour` for an id not in the colour table or `bare`). Either end may be landed or free. Setting the value it already has succeeds and is logged (intent, as `device.operate`).
- **`panel.directory`** sets one `directory<space>` key (`not-found`, `not-a-panel` for a kind without a directory, `unknown-space` above the entry's `spaces`). **`space` has no maximum in the frozen schema** (resolved in review): the entry's `spaces` bounds it, so a larger panel later needs no argument change. Breaker `entity.label` stays available beside it. The directory may be wrong; that is P5's mislabelled-breaker fault.
- **`device.press`** adds 1 to a momentary control's counter (`not-found`, `not-a-device`, `unknown-control`, `not-momentary` for a control of another type, `ids-exhausted` at `Number.MAX_SAFE_INTEGER`). One logged command per press (D7). **`device.operate` refuses a momentary control** (`momentary`, with a message naming the alternative: "`test` is a button: press it with `device.press`"): no older log can hold one, so the new refusal stops nothing that replayed before.
- **`lead.connect` refuses `inaccessible`** on a terminal whose catalogue v3 `access` is `none` (a plug pin inside a cord cap, a receptacle slot behind its face where the entry says so). Only catalogue-3 entries can declare `none`, so no older log is affected.
- **The operate key** (E, and double-click; binding id `device.operate.selection` unchanged) flips the selection's first control that is a toggle **or a two-option selector** (a 3-way's or 4-way's `position`), so `SELECTION_TOGGLE_VALUE_KEY` becomes `boolean | string`.
- **New bindings** (stable ids from v0.5.0): `device.press.test.selection` T (`viewport.focused && selection.momentary.test`) and `device.press.reset.selection` Shift+T (when `selection.momentary.reset`, added in PR 8); `plug.remove.selection` I (when `selection.plugged`). The plug gesture starts on I when `selection.pluggable && !selection.plugged`, through an unlogged gesture command outside `plug.*` (`plugging.begin`); outlets are cycled with Tab and Shift+Tab, refused ones included and announced with their refusal.
- **`entity.place` is unchanged.** It never logs a plug: a placed appliance is unplugged, and plugging is always `plug.insert`. New mount types use the existing `mountedOn` and `checkMount`; a `busStab` position must be one of the host mount's stab positions (`off-mount` otherwise; a rule only P4 entries can meet).
- **Not commands:** `inspect` is a console query (`CONSOLE_QUERY_ARGS`) and `game.inspect()`; `inspect.run` is unlogged UI. Findings are derived, never stored or hashed (D13).

### What the netlist compiler reads

ADR 0011 §7's "one branch per netlisted connection" and ADR 0015's compiler rules stand. Engine 8 adds **relation contacts** and **remote earth** (D3, D5). The compiler reads only the world's relations, the catalogue and exact integer geometry the load check already validates; it never reads `areas`, `marking`, `label`, `directory`, routes or colours.

**Terminals come from the entry.** A model kind fixes its terminal list exactly (`MODEL_KINDS`), and `sim-core` and `wiringGraph` take a device's terminals from its catalogue entry; ADR 0020 provides the families that need varying terminal sets (bars as indexed terminal families, one receptacle or appliance kind per pin pattern, a main-lug versus main-breaker load centre through a `mainFeed` mount).

1. **Mount contacts from `mountedOn`.** The host's enclosure mount declares its host terminals (for a `busStab`, also its pitch and leg pattern); the device's mount declaration lists contacts `{ id, terminal, positionOffset, contactOhm }` (`contactOhm` per entry, sourced at `mounts.<type>.contacts.<id>.contactOhm`). Each contact compiles to one resistor branch between the device terminal and the host terminal it reaches, never an ideal join. A bulb on an `e26` socket has two contacts (shell and centre); metal-to-metal bonds (a yoke on a steel box, a ground bar kit on the can, the main bonding jumper) are contacts to the host's `chassis` terminal. _Amended by [ADR 0020](0020-catalogue-format-v3.md) (deviations 1, 2, 4): the device contact also names the host contact it touches (`host`), its resistance is sourced at `fits.<type>.contacts.<id>.contactOhm`, and a non-enclosure host offers its mounts in a top-level `hostMounts`._
2. **The bus stab.** **`busStabIndex(host, mount, positionMm)`** (_four arguments since PR 8, adding the device's `fit`; see PR 8 note 6_), one pure, exported `world-model` function used by `checkMount`, snapping, the ghost hint, the compiler and the inspector, finds the stab index by **exact lookup** in the host mount's positions `round(k × pitchMm)` (never by division; `pitchMm` an integer on the host mount, 25 mm labelled game-design, 1.6 % under the 25.4 mm product pitch). The host mount's **leg pattern** maps index to `busL1` or `busL2`: each column is indexed from 0 and alternates legs by row, both columns starting on the same leg, so spaces 1 and 2 are L1, 3 and 4 L2 (correcting the plan's "odd spaces L1, even L2"); a column whose axis runs the other way declares its pattern reversed. A multi-pole device's contacts add their `positionOffset` (line 1 → 0, line 2 → 1), so a two-pole breaker always reaches both legs. Breaker widths are at most the smallest step. Each contact and its leg are in the compiler's structure list, so **sliding a breaker to another space is a structural change**. _Amended by [ADR 0020](0020-catalogue-format-v3.md) (deviation 5): the host mount's `bus: { pitchMm, stabs, legs }` lists the legs in stab order; a column counted the other way lists them the other way round, with no "reversed" flag._
3. **Entry bonds from `inEntry`: none in P4.** EMT and conduit as a ground path are deferred past P4 (deviation 7): conduit kinds gain no `chassis` terminal in catalogue v3 and the frozen entries are untouched. The `entry` relation code is reserved below so a later design needs no encoding change, and since nothing was bonded, a later design loads old saves unbonded, which is what they simulated.
4. **Plug contacts from `pluggedInto`.** A plug's pins and an outlet's slots are terminals of their own, with `methods: []` (catalogue v3); a GFCI receptacle's face slots are a node separate from its load terminals, dead on a reverse feed. One contact branch per pin of the configuration joins the appliance's pin terminal to the outlet's slot terminal, valued by the outlet's `contactOhm` (`outlets.<id>.contactOhm`; `NEMA_CONFIGS` holds geometry and mating only). The cord's conductors are resistors inside the appliance's own fragment (D12: from `cordAwg` and `cordLengthMm`, no thermal node in P4).
5. **When a contact compiles.** A side that declares no contact adds nothing and reports nothing (a DIN rail, a yoke on a nonmetallic box, every P3 entry). When both sides declare it but a terminal isn't netlisted, the contact is absent with an `absent-contact` diagnostic. So every P3 world compiles exactly as in engine 7. Contact-less mount types exit early with no allocation.
6. **Remote earth (D5).** One implicit **one-terminal pseudo-fragment at entity 0**, terminal `earth`, present only when a link reaches it. The links are compiler-made contact branches `{ kind: 'contact', entity: <service or rod>, relation: 'earth', contact: <id> }`: the `service.splitPhase` neutral's utility grounding resistance and a ground rod's `earthResistanceOhm`. It is never in the world. Because entity 0 sorts first, **the earth node is node 0 when present and every other node index shifts by one** (only in worlds with an earth link). `touchVoltageV` in records is measured against it. The `utility.*` stand-ins and the generator stub get no earth link, so the workshop gains no earth node.
   - **Caveat (fix before P6):** an earth or EGC path that joins a DC circuit to an AC island makes the island `mixed` (unsolved). P4 has no such circuit; the simulation caveats record it.
7. **The T-equivalent (D4): terminal behaviour only.** This ADR pins what the terminals see: Z_full / 2 in each line and Z_n in the neutral, with the 25 kVA golden I_LN = 8230 A and I_LL = 5208 A. **It does not pin a representation.** An internal centre-tap node with a negative neutral element would break the AC solver's singularity argument (`mna/ac.ts`) and can't be held by stamps that require R > 0 and L > 0 (Z_n = −2.576 − j8.243 mΩ). ADR 0021 decides; the recommendation is an eliminated 2 × 2 coupled source-impedance block [[Z_h + Z_n, Z_n], [Z_n, Z_h + Z_n]], whose real part is positive definite (eigenvalues R_h and R_h + 2R_n), with the factorisation-cache key including the coupled stamp class. **Split-phase `topologyHash`

   es don't move.** The oracle deck uses the T with negative R and L if ngspice accepts it, otherwise K-coupled inductors.

8. **Element refs and order.** A contact branch is a new `ElementRef` kind, `{ kind: 'contact'; entity: EntityId; relation: 'mount' | 'entry' | 'plug' | 'earth'; contact: string }`: `entity` is the dependent entity (the mounted device, the appliance, the service or rod), `contact` the contact's id (ASCII, `CAMEL_ID_PATTERN`, at most 255 characters). Contacts come **after** every entity element and every connection, ordered by (entity, relation code, contact id); `islandRecords` and the toggle reassembly keep that order. Branch currents through a stab, a bond, a plug pin or an earth link are in the solution and the snapshot like any branch's.
9. **What stays out.** No thermal node on a contact in P4 (D3, an abstraction in ADR 0021). Inspector-only data (terminal `role` and `side`, marked volumes, materials) is never read by the compiler.

**`wiringGraph`** (D13, exported from `sim-core`) applies the same joins and contact rules, with switching devices treated as closed and protective devices as line → load paths, so the inspector and the simulator never disagree about what is connected (a property ties it to `compileNetlist`).

**What moves `topologyHash`:** mounting, unmounting, deleting or sliding to another space a device with contacts; `plug.insert` and `plug.remove`; the earth node's first and last link; a lamp's `burnedOut`; a GFCI's `latched` and `testHeldSinceTick` going null ↔ non-null; a breaker's `tripped` (as now). **What doesn't:** every contact, cord, earth and grounding resistance; tape, areas, directory text, labels; the dimmer's level; the split-phase sources (D4, above); an appliance's `on` where its model keeps the element and changes its value (ADR 0021 decides per kind).

**The `CNT` encoding stays at version 1.** The branch tag gains the value 2 (a contact: varint entity, **u8 relation code**, str contact id), appended like an element-kind code; the earth member encodes as entity 0. **Relation codes are hashed and append-only: `mount` 0, `entry` 1, `plug` 2, `earth` 3.** No world without contacts or an earth node encodes differently.

### PRNG stream keys

`deriveStream(seed, key)`, its golden vectors and every P3 key are unchanged. P4 adds one key function in `world-model/src/lib/prng.ts`:

```ts
entityPurposeStreamKey(id: EntityId, purpose: string): string // `entity:${id}:${purpose}`
```

Each value below is the **first output** of its own stream (`nextFloat()`), drawn once per bank build, so no draw depends on how many another took and a kind gaining a draw later moves nothing else. Bands come from the catalogue entry (the region profile holds the Class A limits the entry's band must sit inside):

| Draw                                         | Stream                            | Mapping                                                                             |
| -------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| Magnetic pickup, pole 1 (every breaker kind) | `entity:<id>` (unchanged P2 rule) | min + (max − min) u over the entry's band; the shared magnetic code path stays P2's |
| Magnetic pickup, pole 2 (`breaker.plugOn2p`) | `entity:<id>:pickupL2`            | as pole 1                                                                           |
| Opening time above the pickup                | `entity:<id>:opening`             | ⌈min + (max − min) u⌉ ticks over the entry's band (8–20 ms for 15/20 A)             |
| GFCI pickup                                  | `entity:<id>:gfciPickup`          | min + (max − min) u over the entry's band (4–6 mA)                                  |
| GFCI mechanism time                          | `entity:<id>:gfciMechanism`       | ⌈min + (max − min) u⌉ ticks over the entry's band (3–14 ms)                         |
| Appliance duty-cycle phase                   | `entity:<id>:duty`                | ⌊period · u⌋ ticks                                                                  |
| AFCI per-bucket draw                         | base `entity:<id>:afci`, mixed    | u = `mix32`(s ^ Math.imul(bucket, 0x9e3779b1)) / 2³², s the base stream's first u32 |

- **The AFCI follows ADR 0018's intermittent pattern** (deviation 3), sharing the bucket-draw helper with `thermal/regimes.ts` (`mix32`, the existing function). Its bucket is the intermittent bucket (100 ticks, absolute boundaries). At each boundary where a downstream end arced at I ≥ 5 A during the bucket, `arcExposure` grows from x_prev to x by Δt / T_limit(I) and **the AFCI trips if u < (x − x_prev) / (1 − x_prev)**, so the cumulative probability is exactly x and reaches 1 by the limit. The outcome is a pure function of `(seed, id, bucket)` and the persisted keys, identical across runs, replays, transports and a save and load; no string is built per bucket and no generator state is stored.
- **No P4 command draws.** `plug.insert`, `wire.mark`, `panel.directory` and `device.press` are deterministic; no P4 world command draws from `commandStreamKey(seq)` either.
- The purpose strings are frozen with v4 at v0.5.0, with golden key strings and first outputs in `prng.spec.ts`. Changing a mapping or a draw moves every saved device's behaviour: a determinism change, `SIM_ENGINE_VERSION` at least.

### Schema invariants

Zod refinements on `WorldV4` (not in the JSON Schema), each with a refused fixture under `fixtures/v4/refused/world/`. ADR 0015's invariants 1–8 carry over unchanged, plus:

9. **Relations.** `pluggedInto.entity` names another entity that exists; at most one entity per `(entity, outlet)`; never together with `mountedOn` or `inEntry`; **mounts, entries and plugs together form no cycle** (one walk over all three, replacing v3's two; a strip plugged into a strip plugged into the first is refused).
10. **Markings.** A lead-shaped connection has `marking: { a: null, b: null }` (invariant 4 extended).
11. **Areas.** Sorted by strictly ascending id (UTF-16 code units, as fixtures); no area id equals a fixture id (so a later `view.focus` on an area is unambiguous); `minMm < maxMm` on every axis; at most 256.

**In the load check** (`checkWorldReferences`, still `invalid-device-state`, still leaving unknown refs alone): the appliance's entry has a `plug` and the host's entry has that outlet; the configurations mate; both are at quarter-turns and the cord reaches (`checkPlugInsert`, so a crafted save can't hold a plug the command would refuse); no entry both fits a mount and has a plug; marking colours are in the colour table and not `bare`; area uses are in `AREA_USES`; a load centre's `directory<n>` keys above its entry's `spaces` are `null`; counters are non-negative integers; a breaker's `tripCause` is `null` exactly when it isn't tripped, and a GFCI receptacle's is non-null only while it is unlatched; `busStab` positions are stab positions (`checkMount` through `busStabIndex`); a lead's clip end is never on an `access: 'none'` terminal (added in PR 8). Bag key sets are checked against `MODEL_KINDS` as before.

### Hash scope

- **`world.hash`** keeps its definition (SHA-256 of the canonical JSON of the parsed world, ADR 0007), so it covers `areas`, `pluggedInto`, `marking`, the new bags (counters and directory text included) and every relation. Every world gains `"areas":[]`, `"pluggedInto":null` per entity and `"marking":{"a":null,"b":null}` per connection, and every lamp bag gains its new keys, so **every pinned world hash is re-pinned once, at the world v4 PR** (PR 7), listed old → new in the CHANGELOG. Engine 8 re-pins once more for numeric reasons (PR 9), with its own list.
- **`topologyHash`**: as [above](#what-the-netlist-compiler-reads); `hash.spec.ts` gains one golden per new model kind, one per contact relation and one for the earth node.
- **`snapshotHash`** covers the protocol 8 records (below), so every scenario with a lamp, a lead or a wire moves at protocol 8.
- **Not in any hash:** inspector findings, `wiringGraph`, audio cues, the cord's drawn shape, display state, events.

### The v3 → v4 migration

Pure and total (`v4/from-v3.ts`, kept forever; the tests deep-freeze the input and run each step twice). It doesn't read the catalogue.

- **World:** `schemaVersion: 4`, `areas: []`. Each entity gains `pluggedInto: null`. Each connection gains `marking: { a: null, b: null }`. **Each entity whose ref is in `LAMP_INCANDESCENT_REFS_V3`** gains, in its `sim` bag, `burnedOut: false` and `overvoltageSinceTick: null` (each only if absent; an entity with a ref outside the list, an unknown ref included, is copied untouched).
  - `LAMP_INCANDESCENT_REFS_V3` is a frozen literal in `from-v3.ts`: the `lamp.incandescent` entries a v3 save can name, `{ id: 'lamp.lumivane-12v-5w', version: 1 }` and `{ id: 'lamp.lumivane-120v-60w', version: 1 }` (confirmed by `content-designer`). Catalogue 2 is frozen, so the list is complete for every save v0.4.0 wrote; a parity test in `@controls/catalog` requires it to equal the `lamp.incandescent` entries of the frozen catalogue-2 snapshot, and the literal never changes (deviation 1).
- **Replay log:** `initialWorld` migrated as above; **every entry copied verbatim**. No P3 command's id or argument shape changed, and no P4 command exists in a v3 log.
- **Manifest:** `schemaVersion: 4`; `catalogVersion` and `simEngineVersion` kept as saved.
- **Every v1, v2 and v3 fixture migrates and validates as v4.** A 0.4.0 save (catalogue 2, engine 7) loads as `engine-changed`, never refused: `world.json` as saved and migrated, the solution record dropped, solved again at the save's tick, the log restarted (ADR 0011 §9.6). A fixture test proves it on the frozen `fixtures/v3/ctrl/*-engine-7-catalog-2.ctrl` saves; none is regenerated.
- **Known edge:** a dev-build v3 save written between the catalogue v3 PR and the world v4 PR could hold a catalogue-3 entry of a kind whose keys this bump changes. None is planned (the first new lamp entries land after world v4, PR 12). If one appears, it is refused as `invalid-device-state`, like any provisional-version change.

### `catalogVersion` 3: what this ADR depends on

_Amended by [ADR 0020](0020-catalogue-format-v3.md), which specifies all of it, with deviations 1 (the contact's `host`), 2 (`fits.<type>.contacts.<id>.contactOhm`), 4 (a top-level `hostMounts` resolves R5) and 5 (`legs` instead of "reversed"), and chooses `mainFeed`._

Catalogue v3 (ADR 0020, PR 6) lands before world v4. This ADR needs, and ADR 0020 specifies:

- **Mount contacts** (C1): the host's `EnclosureMount` declares its host terminals, and for `busStab` an integer `pitchMm` and a per-mount leg pattern (R2: entry data, not `MOUNT_TYPES`); the device's `DeviceMount` declares `contacts: { id, terminal, positionOffset, contactOhm }[]` with a source per value. `MOUNT_TYPES` rows `busStab`, `mainBreaker` (or `mainFeed`), `mbj`, `groundBarKit`, `e26`.
- **A `DeviceMount` anchor** (`alongMm`, `crossMm`; R4) so different bulbs or devices on one single mount share an axis; P3 entries declare 0 (allowed by the shipped mask).
- **Where a lampholder's `e26` mount lives** (R5): either a mounts-only enclosure spec that the inspector ignores, or mounts moved out of `enclosure`; ADR 0020 chooses, but a non-enclosure device must be able to offer a mount.
- **Terminals from the entry** (C3): indexed terminal families for bars, one kind per pin pattern for receptacles and appliances, a `mainFeed` mount for main-lug versus main-breaker.
- **Plug pins and outlet slots as terminals with `methods: []`** and a terminal **`access: 'land' | 'clip' | 'none'`** (C5); GFCI face slots a node separate from the load terminals.
- **Receptacle `outlets: { id, config, positionMm, contactOhm, pins: { pin, terminal }[] }[]`** and **appliance `plug: { config, cordAwg, cordLengthMm, cordExitMm, pins: { pin, terminal }[] }`**, over **`NEMA_CONFIGS`** (pins and mating only, NEMA WD 6 by number, including 1-15P; C6).
- **State value types `text` and `counter`** and the **`momentary`** control type (a `counter` key named by the control id, never settable by `device.operate`); GFCI receptacles carry `test` and `reset`, GFCI and AFCI breakers `test` only.
- **The load centre entry's `spaces`** (at most 42), its space → (mount, index) map, and `coverOn`.
- **A `chassis` terminal** on the load centre, `enclosure.metalBox` and metal-cased appliances (C9); not on conduit kinds (deviation 7).
- **`earthResistanceOhm`** on ground-rod entries (from length, diameter and a stated ρ; derived 39.90 Ω for the house rod) and the service entry's utility grounding resistance.
- **`AREA_USES`**, append-only, with the ten rows above.
- **`supersededBy: CatalogRef | null`** (C12, allowed by the shipped mask) on the shipped steel boxes, which have no `chassis` terminal and can't bond: the build menu hides superseded entries and the inspector words its finding "replace".
- Inspector-only data the compiler never reads: terminal `role` and `side`, `multiConductor`, `markedVolumeMm3`, `material`.
- The existing requirement (ADR 0015): a shipped `(id, version)` resolves in every later catalogue; `shipped.spec.ts` freezes catalogue 2's entries; `tb.quennick-st4@2` beside `@1`.
- **Notes for ADR 0020** (non-blocking, from review): the AFCI and GFCI breakers' pigtail as a `pigtail` terminal plus a short white conductor; 14-30R and 14-50R stay out of the house (no two-pole GFCI in P4); the 30, 40 and 50 A plug-on bands still need sources; "a mountable device never has a plug" is a relaxable load rule.

### Protocol 8 (contract level; an ADR 0011 amendment)

Listed here so the persisted keys and the published fields are designed together. **Byte layouts and the sign-offs belong to the ADR 0011 amendment in the protocol 8 PR (PR 11)**, which `renderer-engineer` and `angular-ui-engineer` sign; their co-sign conditions are part of this contract.

- **Descriptor.** `ElementRef` gains the `contact` kind. `TerminalRefSchema` allows entity 0 **only** with terminal `earth`. A probe or trace `branch` target accepts a `contact` ref. Readers never look entity 0 up in the world (the netlist panel labels it "remote earth"; nothing focuses it). Contact branches carry their currents in the existing branch section; the voltage and current overlays skip them (they have no mesh), and the panel hum sums the stab currents from that section.
- **Device records for every new kind**, each ending in the validity `status`; **state and `tripCause` are fixed enum codes, always written whatever the status**, as are every draw-relevant own-state field (lamp `burnedOut`, breaker and GFCI state):
  - plug-on breakers: per-pole `currentA` and `thermalFraction`, `magneticPickupA` per pole, `openingMs`, `state` [`off`, `on`, `tripped`], `tripCause`;
  - GFCI (receptacle and breaker): hot and neutral pole currents, `residualMa`, `pickupMa`, `residualIntegral`, the **line-side** and load-side voltages, `state` [`unlatched`, `latched`, `tripped`], `testHeld`, `tripCause`;
  - AFCI: the breaker fields plus `arcExposure` and whether a downstream end is arcing;
  - load centre: per-leg bus current, the main bonding jumper's and the GEC's currents, `touchVoltageV`;
  - every kind with a `chassis` terminal: `touchVoltageV` against remote earth, a reading only when its island holds the earth node;
  - receptacles: per outlet, **keyed by `OutletId`**, the face voltages hot–neutral, hot–ground and neutral–ground (what P5's receptacle tester reads);
  - LED lights: `powerW`, `voltageV`, `lightOutputRel`, driver state [`off`, `running`]; appliances: `powerW`, `currentA`, `voltageV`; the dimmer: `levelRms`, load voltage;
  - **`lamp.incandescent` gains `burnedOut`** (a layout change to an existing kind). The DIN breaker's record is unchanged.
- **Connection records** gain `endADegradation` and `endBDegradation` (f64, own state: the carried P3 readout item), **inserted inside the f64 block after `endBTempK`**; the u8 block moves to offset 112 and `CONNECTION_RECORD_BYTES` goes 104 → 120. A spec requires the fast path to equal the general path, and a module-load assertion checks the layout is every f64 then every u8.
- **Events.** `tripped` carries `detail.cause` (`thermal | magnetic | groundFault | arcFault | test`) for every new breaker kind and the GFCI receptacle, as the DIN breaker already does. New kinds **`lampBurnout`** (the lamp; `detail: { filamentTempK }`) and **`overvoltage`** (the device; `detail: { voltageV }`). Each is derived from persisted state, so the event list after a save and load equals the uninterrupted run's.
- **What the UI does with them:** `tripped` toasts with the device's label (or title) and cause, coalesced per entity as now, except cause `test`, which is announced only; `lampBurnout` is announced, coalesced, never toasted; `overvoltage` shows in the selection readout and the dev-console event log, not the inspector. One announcement per event.
- **Audio** (ADR 0023) takes command-driven cues from `WorldSync`'s world-state diffs (a `pluggedInto` change; an `on`, `closed` or `position` change; a counter going up, never down, which is an undo), suppressed on a whole-world replacement (a load), and sim cues from events and record changes.
- `SIM_PROTOCOL_VERSION` 7 → 8; every snapshot golden re-pinned in that PR.

### Versions

| Version                | From → to | When                   | Provisional until |
| ---------------------- | --------- | ---------------------- | ----------------- |
| `schemaVersion`        | 3 → 4     | World v4 PR (PR 7)     | v0.5.0            |
| `catalogVersion`       | 2 → 3     | Catalogue v3 PR (PR 6) | v0.5.0            |
| `SIM_ENGINE_VERSION`   | 7 → 8     | Engine 8 part 1 (PR 9) | v0.5.0            |
| `SIM_PROTOCOL_VERSION` | 7 → 8     | Protocol 8 (PR 11)     | v0.5.0            |

While provisional, a later P4 PR that changes one re-pins in place and **replaces** that version's fixtures in place (the P3 rule in the save-format caveats), updating the CHANGELOG's single old → new list per version. Any release from `main`, a patch included, freezes all four together. Engine-numbered fixtures from catalogue 3 are named `*-engine-8-catalog-3.ctrl`; the `-engine-7-catalog-2` ones stay and load as `engine-changed`.

### Sizes

A plug, a marking and an area are each under 100 bytes of JSON; a load centre's 42 directory keys about 1 KB with null values, 2.5 KB filled. The new log entries are under 200 bytes. No cap changes.

## Deviations from the plan

The plan is corrected in the same PR.

1. **The migration adds lamp keys by a frozen ref list** (`LAMP_INCANDESCENT_REFS_V3`): a catalogue-free step can't know an entity's kind any other way.
2. **`lamp.incandescent` gains a second key, `overvoltageSinceTick`,** beside `burnedOut`, so the F4.4 `overvoltage` event survives a save mid-dwell.
3. **AFCI draws use `entity:<id>:afci` with integer bucket mixing and the `arcExposure` / `arcLastSeenTick` keys**, not the plan's `afci:<entity>:<bucket>` key: one stream per bank build, ADR 0018's pattern, no sixth key prefix.
4. **`AreaV4.use` is a registry id** (`AREA_USES`, append-only), not a closed enum, and `unfinishedBasement` becomes `basement`.
5. **The panel directory is one commanded `text` key per space** (`directory1` … `directory42`): a bag value is a scalar, so D14's map can't be one key. `panel.directory`'s `space` has no maximum.
6. **Bus legs alternate by row, not by space number** (spaces 1 and 2 L1, 3 and 4 L2), derived by `busStabIndex` from the stored position; the pitch and leg pattern live on the enclosure's mount.
7. **EMT and conduit as a ground path are deferred past P4.** The plan's D3 ("a connector in a steel box's entry") and F4.3 part 1's EMT bullet are dropped: the joints between conduit parts are drawn, not wired (nothing records them); there is no sourced impedance for them; no P4 acceptance needs it; and it adds compile cost. Old saves will load unbonded under a later design, which is what they simulated.
8. **The T-equivalent is pinned at its terminals only** (D4 said a negative neutral branch inside the source network); the representation is ADR 0021's, recommended as a coupled 2 × 2 source impedance, and split-phase `topologyHash`es don't move.
9. **GFCI reset latches on line voltage alone** (D7 said "with line power and no residual"): a standing fault re-trips through the normal path no earlier than the mechanism time. The D7 golden is restated to match.
10. **New refusals the plan didn't list:** `not-a-receptacle`, `unknown-outlet`, `already-plugged`, `not-plugged`, `plugged`, `not-axis-aligned` (plug reach), `not-a-panel`, `unknown-space`, `momentary` (`device.operate`), `inaccessible` (`lead.connect`, only catalogue-3 terminals), `ids-exhausted` (a press counter).
11. **A new GFCI receptacle starts unlatched**, so line/load reversal is observable from installation.
12. **The load centre gains `coverOn` now**, though nothing reads it before P5, to avoid a later migration.

## Consequences

- `save-format`: `v4/{world,manifest,replay-log,from-v3}.ts`, the chain extended, `CURRENT_SCHEMA_VERSION` 4, the `OutletId`, `AreaId` and `AreaUseId` primitives, `*.v4.schema.json` with staleness, fixtures under `fixtures/v4/{world,manifest,replay-log,ctrl}` (a plugged appliance, marked conductors, areas, a tripped GFCI mid-run, a GFCI saved after `residualIntegral` reached 1 but before its mechanism time, a part-heated breaker inside its opening window, a burned-out lamp) and `fixtures/v4/refused/world/` per new invariant; a fast-check arbitrary for v4 worlds with the JSON and container round-trip properties; the purity tests for `from-v3.ts`.
- `catalog`: the keys above in `MODEL_KINDS` (`device-state.<kind>.schema.json` per new kind, and `lamp.incandescent`'s regenerated); the `text` and `counter` value types; `AREA_USES`; the momentary control type; the `LAMP_INCANDESCENT_REFS_V3` parity test; everything ADR 0020 lists.
- `world-model`: the five commands, their frozen argument schemas and palette hints; `checkPlugInsert`, `plugReach`, `moveBlocker`, `busStabIndex`; `entity.delete` unplugging; `entityHold`'s `plugged` and `occupied`; `device.operate`'s `momentary` refusal and the two-option selector rule; `lead.connect`'s `inaccessible`; `checkWorldReferences` for plugs, markings, areas, directories and stab positions; `entityPurposeStreamKey`; properties (undo restores relations and counters; no command reads `sim`; deleting a receptacle or appliance never leaves a dangling plug).
- `sim-core`: contacts from `mountedOn` and `pluggedInto`; the earth pseudo-fragment and links; the T-equivalent's terminal behaviour; `wiringGraph`; the new kinds' banks with the keys above; the `commanded` hook for presses and resets with read-only last-solution access; topology keys as booleans with a numeric structure code (PR 9); the shared bucket-draw helper; `hash.spec.ts` goldens; engine-numbered fixtures. **Bench risks** to measure in PR 9 and PR 10: the AFCI cut set computed lazily; a cycling appliance's recompiles against `tick-house`'s 0 B gate; contact branches after connections in `islandRecords` and the toggle reassembly.
- `sim-protocol`: the ADR 0011 amendment (protocol 8).
- `scripting-api` and `sim-cli`: the console forms of the new commands, `game.inspect()`, the house scenarios, the 0.4.0 `engine-changed` fixture test.
- Docs (in the implementing PRs, by `docs-keeper`): save-format caveats (v4, the frozen lamp list, `catalogVersion` 3, engine 8), commands caveats (new refusals, occupancy, press semantics, the operate key), simulation caveats (contacts, earth and node 0, the DC `mixed` caveat, persisted protection state), `world-and-saves.md`, `wiring.md`, `docs/history.md` (`schemaVersion` 4, `catalogVersion` 3, `simEngineVersion` 8), the glossary.

## Alternatives considered

- **A cord as connections** (D1 rejected): three connections with plug "terminals" that aren't screws, terminations that aren't made, and routes for a cord nobody routes.
- **A plug as `mountedOn`** (D1 rejected): mounting fixes the transform at the host and frames the orientation, and a plugged lamp stands where it was put.
- **`burnedOut` on a new lamp kind** instead of the existing one: no migration, but the P3 120 V lamp and the bench lamp could never burn out, and the A19 bulbs would split from the filament model they share.
- **Filling missing keys on load** instead of migrating: the load check is exact about key sets for a reason (a crafted bag with a missing key is damage), and "fill on load" would make the bag's meaning depend on the build.
- **Storing the stab slot in `mountedOn`**: redundant with the stored transform and able to disagree with it.
- **Storing opening times, pickups and mechanism times**: they follow from seed and id (the P2 pickup precedent); storing them would freeze another engine's draws into old saves.
- **A pending-reset key, or a reset that also checks the residual:** the hook decides from state already in the export, and a standing fault re-trips through the normal path anyway.
- **A held `test` toggle** (D7 rejected): two commands per press, and a test the player could leave held.
- **One `afci:<entity>:<bucket>` stream per bucket**, or an AFCI timed from an `arcSinceTick`: the first builds a string per bucket; the second can't express "only arcing buckets count" across an intermittent arc.
- **A closed `use` enum**: every new area use after v0.5.0 would be a `schemaVersion` bump.
- **Contacts as ideal joins** (D3 rejected): no current through a stab, a bond or a plug pin, so no objectionable-current reading.
- **An internal centre-tap node with a negative neutral element** (this ADR's draft): breaks the AC solver's singularity argument and the R > 0, L > 0 stamps.
- **Deriving conduit joints from geometry in the compiler** (this ADR's draft default for EMT): geometry would become topology for a feature no acceptance needs, without a sourced joint impedance.
- **Bumping `CNT` to version 2 regardless**: moves every persisted `topologyHash` for no structural reason in worlds without contacts.

## Review

All four reviews (2026-11-17) were "approve with changes"; every required change is applied above.

- **`sim-engine-engineer`:** the T-equivalent pinned by terminal behaviour only, with the coupled 2 × 2 source impedance recommended to ADR 0021, the factorisation-cache key and the oracle deck, and split-phase topology hashes unmoved (S1); earth as a one-terminal pseudo-fragment at entity 0 with compiler-made `earth` contact branches, hashed append-only relation codes, contact-id bounds and node 0 shifting the others (S2); the AFCI's `arcExposure` and `arcLastSeenTick` replacing `arcSinceTick`, the conditional trip test at absolute 100-tick boundaries and a lazy cut set (S3); GFCI reset on line voltage only, with read-only last-solution access in the hook (S4); `residualIntegral` clamped at 1 and a fixture saved inside the mechanism window (S5); topology keys projected to booleans with a non-allocating structure code in PR 9 (S6); EMT and conduit bonding deferred past P4 (S7); and the smaller points: the DIN breaker already emits a cause, `mix32` and the shared bucket helper, `magneticSinceTick` as the protection step's tick, `overvoltageSinceTick` kept (null without a region range), the LED driver's `running` key, `GFCI_TEST_HOLD_TICKS` about 1000, `CNT` version 1, one shared position-to-leg function, contacts and legs in the structure list, the early exit for contact-less mounts, the DC `mixed` caveat and the bench risks (S8).
- **`renderer-engineer`:** stab positions `round(k × pitch)` looked up exactly by one exported `busStabIndex` used everywhere, breaker widths within a step (R1); pitch and leg pattern on the enclosure's mount, per mount (R2); multi-pole `positionOffset` (R3); the `DeviceMount` anchor (R4); the lampholder's `e26` mount requirement (R5); `checkPlugInsert`, `plugReach`, `entityHold` and `WorldPlacementFailure` gaining `plugged` (R6); the connection record's degradation fields placed in the f64 block, 120 bytes, with fast-path and layout checks (R7); entity 0 allowed only as `earth`, contact probe targets and the UI follow-ups (R8); audio command cues from world-state diffs rather than applied commands (R9); draw-relevant own-state fields written whatever the status (R10); straight-line reach documented as an abstraction (R11). The optional `latched` event was not added (see below).
- **`angular-ui-engineer`:** the freeze scope (hint-only changes regenerate; SHA pins hash a hint-stripped copy), the `x-controls-options` hints, the prefill rule and the console argument order (U1); the T, Shift+T and I bindings, the unlogged `plugging.begin` gesture and outlet cycling (U2); the operate key flipping two-option selectors (U3); `directory*` keys never controls, with a test (U4); the `momentary` refusal message naming `device.press` (U6); plug pre-checks through `precheck` on the command itself (U7); `overvoltage` in the selection readout and dev-console log (U8); `moveBlocker` (U9); the toast and announcement rules; and the protocol 8 co-sign conditions (fixed enum codes always written, line-side voltage and `residualMa` on GFCI records, face voltages keyed by `OutletId`).
- **`content-designer`:** contacts declared by host and device mounts with per-entry, sourced `contactOhm`, and `absent-contact` only when both sides declare (C1); bus phasing by row and an integer 25 mm game-design pitch (C2); terminals fixed per kind and taken from the entry, with indexed families and a `mainFeed` mount (C3); S7's deferral without conduit `chassis` terminals (C4); pins and slots as `methods: []` terminals, separate GFCI face slots, terminal `access` and the `inaccessible` refusal (C5); plug contact resistance on the outlet and 1-15P in `NEMA_CONFIGS` (C6); the `text` and `counter` value types (C7); no maximum on `space` (C8); GFCI stream mappings over the entry's band (C9); `basement` (C10); the `burnedOut` constant and per-class overvoltage threshold (C11); `supersededBy` for the shipped steel boxes (C12); the non-blocking notes for ADR 0020 and the answers on momentary controls and `chassis` kinds.
- **Conflict resolved:** _the directory `space` bound._ `angular-ui-engineer` asked for `Int` 1–42 in the frozen schema; `content-designer` for `Int ≥ 1` with the entry's `spaces` enforced by `unknown-space`. Decided: no maximum in the schema (a larger panel later needs no argument change), and the palette's options come from `directorySpaces` anyway.
- **Not taken:** `renderer-engineer`'s optional GFCI `latched` event. A successful reset already shows as the record's `state` going `unlatched` → `latched`, which the audio and the panel read, and an event adds a protocol kind with no gameplay reader.
- **Decided in review on the guardian's call:** the load centre's `coverOn` key is added now (`content-designer` asked for a decision): adding a key to a shipped kind later needs a migration that can't read the catalogue, and P5's shock model will need it.

## Implementation notes (P4 PR 7, 2026-11-18)

World v4's schemas, migration, load checks and fixtures landed in PR 7 (`save-format-guardian`). Where the code differs from the text above, the difference is recorded here; none changes a persisted shape this ADR fixes.

1. **`checkPlugInsert` and `plugReach` landed with the schemas, not the commands PR.** The load check must refuse a plug the command would refuse, so the check is written once in `world-model/src/lib/wiring/plug.ts` and PR 8's `plug.insert` calls it unchanged. It takes `{ existing: true }` for a plug already in place (skips `already-plugged`; the plug's own outlet isn't occupied).
2. **A new refusal, `plug-cycle`**, after the receptacle's `not-found`: the receptacle is the appliance itself or hangs from it through mounts, entries or plugs (a strip plugged into a strip plugged into the first). Invariant 9 refuses such a world, so the command must refuse the plug; only refused versus accepted is replay format.
3. **One message for every cycle**, `Mounts, entries and plugs must not form a cycle`, replacing v3's two (`Mounting must not form a cycle`; `Mounting and entries must not form a cycle`). An entity whose own relation names itself or a missing entity is reported by that rule, not as a cycle. v3's refused fixtures keep their v3 messages (they are refused at v3, before the step).
4. **Invariant 10 has its own message** (`A lead carries no marking: { a: null, b: null }`) rather than extending invariant 4's lead-shape message, so v3's message and fixtures stay as they are.
5. **`DeviceStateValueV4` and `DeviceStateBagV4`** are new primitives with the same acceptance as v2/v3's and a description that covers catalogue v3's `text` and `counter` keys (ADR 0020's PR 7 item). Rewording the shared `DeviceStateValue` would have changed the frozen `world.v2` and `world.v3` JSON Schema files.
6. **Engine 7 carries the lamp's two new keys through** (`sim-core`'s lamp bank reads and writes them back unchanged), so the migrated keys survive materialisation without an engine bump; engine 8 sets them (PR 9). No `topologyHash`, snapshot hash or protocol fingerprint moved. `scripting-api`'s `.ctrl` fixture test (`save.spec.ts`) exempts `overvoltageSinceTick` from "every null-initial key is filled after a load", because `null` is its value for "no excursion", not "never set"; **engine 8 must keep that exemption deliberately** and never fill the key just to satisfy the test.
7. **Interim guards until PR 8:** a plugged entity can't move or turn (`plugged`), and a receptacle holding a plug is `occupied` for `entity.move`, `entity.rotate` **and `entity.delete`** (the text above has `entity.delete` unplug it; that arrives with PR 8's commands). Deleting a plugged appliance takes its plug with it, as specified. Refusals aren't logged, so relaxing the delete refusal changes no log. `entityHold`'s `plugged`, `moveBlocker` and `WorldPlacementFailure.plugged` also arrive in PR 8: until then `entityHold` returns only `occupied` or `wired`, so the placement ghost (which reads only `entityHold`) doesn't yet refuse picking up a plugged appliance; the commands do.
8. **Load checks deferred:** `busStab` positions through `busStabIndex` (PR 8, with the function) and the `tripCause` consistency rules (PR 10, with the breaker and GFCI kinds). Counters need no new rule: a `counter` key's schema (a non-negative safe integer) is already checked by `checkBags`. "No entry both fits a mount and has a plug" is refused by `parseCatalog`, so no world can reach it.
9. **`mountedOn` resolves through `offeredMounts`** in `checkMount` and the load check (ADR 0020 R5): a lampholder's `hostMounts` socket takes a bulb. Snapping and the ghost still read enclosure mounts only (PR 8).
10. **Fixtures.** The new kinds' keys are provisional until ADR 0021, so `fixtures/v4/world/protection-state.json` uses fixture-only refs (`breaker.fixture-*`, `receptacle.fixture-*`, …; the load check leaves them alone) with the keys in the table above, and is replaced in place when ADR 0021 settles them. The twelve `-engine-7-catalog-3.ctrl` saves the catalogue v3 PR wrote as world v3 are kept under `fixtures/v3/ctrl/` (never regenerated, like the engine-6 catalogue-2 saves): each migrates to exactly its v4 twin, which `sim run --save` now writes under `fixtures/v4/ctrl/`, and loads `continued` until engine 8 makes it `engine-changed`.
11. **`AreaV4` has no `extensions`**, as specified above; world-level `extensions` holds anything a mod attaches to areas.

## Implementation notes (P4 PR 8, 2026-11-18)

The world v4 commands landed in PR 8 (main agent). Where the code differs from the text above:

1. **Two refusal codes are new beyond the list above:** `plug-cycle` (from `checkPlugInsert`, PR 7's note 2) and **`multi-conductor-out-of-range`**, the `multiConductor` cap's refusal (ADR 0020's PR 8 item) in `checkLanding`, so `wire.add` lands under the same cap as `wire.land`. `checkPlugInsert` also refuses, defensively, an appliance that is mounted (`mounted`) or in an entry (`in-entry`), reusing `entity.rotate`'s and `entity.move`'s codes; invariant 9 and `parseCatalog` keep any world from reaching them. Only refused versus accepted is replay format.
2. **The P3 argument pins hash a hint-stripped copy of every P3 schema** (32 files, as of v0.4.0), not only `lead.*`; the raw-byte pins of `lead.connect` and `lead.disconnect` stay. The five new schemas join the pins when v0.5.0 ships.
3. **`device.press` on a non-momentary control is `not-momentary`** whatever its type (a toggle, a setpoint, a selector), and on a `counter` already at `Number.MAX_SAFE_INTEGER` is `ids-exhausted`, as specified.
4. **A load-check fix:** PR 7's control-range pass called `checkControlValue` on every control, which refuses any momentary value, so a world holding any button would have been refused. Momentary controls are skipped there now (the `counter` schema in `checkBags` is the rule).
5. **`moveBlocker` returns `plugged` before `occupied`;** `entityHold` is `moveBlocker` then `wired`. An entity both plugged and holding a plug (a strip) reports `plugged`.
6. **The `busStab` rule** in `checkMount`: the device's origin is exactly a stab position and every contact's stab (`index + positionOffset`) is on the bus (`off-mount` otherwise). `busStabIndex(host, mount, positionMm, fit)` takes the device's fit as a fourth argument and checks the plane (normal 0), the device's cross line (`fit.crossMm`) and an exact stab, so a caller holding a position `checkMount` hasn't seen gets `null` off the line. Breaker widths aren't checked against the pitch (the catalogue's job). `busStabLeg(mount, k)` is exported beside `busStabIndex` so the compiler and inspector don't recompute `legs[k mod 2]`.
7. **Palette hints:** `panel.directory`'s `space` hint is `{ from: 'directorySpaces', entity: 'id' }` and `device.press`'s `{ from: 'controls', entity: 'id', type: 'momentary' }` (the entity named explicitly, as `plug.insert`'s). The palette reads sibling fields as typed. The new bindings (T, Shift+T, I and the `plugging.begin` gesture) are left to the panel UI PR (F4.2 part 3), which owns the gestures they start.
8. **Added to the load check in PR 8:** a lead-shaped connection whose clip end is on a terminal with `access: 'none'` (`lead.connect`'s `inaccessible`), so a crafted save can't hold a lead the command refuses. Only catalogue-3 entries can declare `none`, so no older save is affected. The `multiConductor` cap is deliberately not load-checked, like every landing limit (`terminal-full`, the twist-on combination).

## Implementation notes (P4 PR 9, 2026-11-18)

Engine 8 part 1 (`sim-engine-engineer`) implements "What the netlist compiler reads"; the physics and every deviation are recorded in [ADR 0021](0021-service-grounding-and-protection-physics.md) part 1. In short:

1. **The T-equivalent is a coupled 2 × 2 source impedance** (this ADR's recommendation), so no negative element exists anywhere and split-phase `topologyHash`es didn't move.
2. **Protocol 8 starts in PR 9 with the descriptor's part** (the `contact` element ref, entity 0 as `earth`, a contact trace target), because a world holding a contact can't otherwise cross the worker boundary; PR 11 completes it in place with the ADR 0011 amendment and its sign-offs (ADR 0021 deviation 1).
3. **The service has a fourth terminal `x0`** (the transformer neutral at the pole), where the utility's grounding link sits (ADR 0021 deviation 2).
4. **The lamp's `burnedOut` and `overvoltageSinceTick` are still carried through** (note 6 of PR 7 said engine 8 sets them): setting them needs protocol 8's `lampBurnout` and `overvoltage` events (PR 11) and F4.4's dwell, so they move to that work. The `overvoltageSinceTick` exemption in `scripting-api`'s `save.spec.ts` is kept.
5. **The numeric structure code** for topology keys waits for the first kinds with sim topology keys (PR 10).
6. **Contact ids** in the descriptor are camelCase ASCII up to 255 characters (§8); in the catalogue `ContactId` stays at 32. ADR 0020's `ElementRef.part` question is settled by the `contact` kind.

## Implementation notes (P4 PR 10, 2026-11-18)

Breakers v2, the GFCI breaker and the AFCI breaker (`sim-engine-engineer`); the physics and the deviations are in [ADR 0021](0021-service-grounding-and-protection-physics.md) part 2.

1. **The four breaker kinds' keys are final as this ADR's table has them** (`breaker.plugOn1p`, `breaker.plugOn2p`, `breaker.gfci1p`, `breaker.afci1p`): no key added, renamed or reshaped. `tripCause` is one enum for every kind (`TRIP_CAUSES`). The GFCI receptacle's keys settle with F4.1 part 2.
2. **The `tripCause` load check** landed (`tripCauseProblems` in world-model, deferred from PR 7's note 8): `null` exactly when not `tripped`; for a kind with `latched`, non-null only while unlatched.
3. **`protection-state.json` needed no change**: its fixture-only bags already held these key sets. It keeps its fixture-only refs; a world-model spec checks each bag against the kind its ref stands for.
4. **The numeric structure code** (PR 9's note 5) landed: each sim topology key is projected to a boolean and the compiler keeps one number per entity, read without building a bag (`CompileOptions.simValue`).
5. **The `commanded` hook gets read-only access to the last solution** (`CommandedContext`), as "Derived on load, never persisted" anticipated; the AFCI's test press uses it now, the GFCI receptacle's reset will.
6. **`GFCI_TEST_HOLD_TICKS` is fixed at 5000, not "about 1000"** (the realism review): a realistic test circuit (at most about 9 mA, UL 943 by number; 6.8 mA from a 15 kΩ resistor at 85 % voltage) takes up to 4.60 s at the Class A limit, which the hold must cover. The key's type and meaning are unchanged.
