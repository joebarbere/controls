# ADR 0019: World document v4 and the residential contract

**Status:** Proposed (2026-11-17). P4 kickoff step 3, the agent-team contract. Drafted by `save-format-guardian` (lead). Reviews pending from `sim-engine-engineer`, `renderer-engineer`, `angular-ui-engineer` and `content-designer` (see [Open points for reviewers](#open-points-for-reviewers)). No v4 code lands before this is Accepted. `schemaVersion` 4, `catalogVersion` 3, `SIM_ENGINE_VERSION` 8 and `SIM_PROTOCOL_VERSION` 8 stay provisional until v0.5.0 ships, then they are frozen.
**Date:** 2026-11-17 (Phase 4)
**Sources:** [phase 4 plan](../../plans/phase-4-residential.md) kickoff step 3, decisions D1–D5, D7, D8, D10, D12, D14, D18, the "Kickoff PRs" section and the [pre-audit outcome](../../plans/phase-4-residential.md#pre-audit-outcome-2026-11-17); [ADR 0004](0004-save-format.md) (save format rules); [ADR 0007](0007-world-document-v1.md) (ids, hash, PRNG, replay log); [ADR 0011](0011-sim-worker-contract.md) §1, §4, §5.4, §7, §9.6, §12 and its protocol 6 and 7 amendments; [ADR 0013](0013-world-document-v2.md) (bags, `MODEL_KINDS`, the load check, `topologyHash`); [ADR 0015](0015-world-document-v3.md) (v3, the precedent for this ADR's structure); [ADR 0016](0016-catalogue-format-v2.md) (catalogue v2); [ADR 0018](0018-conductor-and-termination-physics.md) (the bucket-draw pattern, events, persisted contact state); [save-format](../caveats/save-format.md), [commands](../caveats/commands.md) and [simulation](../caveats/simulation.md) caveats. Grounded in the code at v0.4.0: `libs/domain/save-format/src/lib/v3/*`, `world-model` (`checkWorldReferences` in `devices.ts`, `wiring/mounting.ts`, `wiring/in-entry.ts`, `prng.ts`, `device-commands.ts`), `sim-core` (`netlist/compile.ts`, `netlist/hash.ts`, `devices/sources/netlist-models.ts`, `engine/device-model.ts`), `catalog` (`model-kinds.ts`, `registries.ts`).

## Context

World v3 (ADR 0015, frozen by v0.4.0) holds real wiring: conductors with terminations, cables, routes, what each device is mounted on (`mountedOn`) and which entry a conduit connector is in (`inEntry`). The compiler reads none of the relations: a mounted device conducts only through what is landed on its terminals.

P4 wires a house, and three physical facts can no longer be ignored: a breaker conducts from the bus only because it is clipped onto a stab; a metal box, a yoke and a conduit run are bonded only through what is mounted, entered or landed; and an appliance draws only when its cord is plugged in. The plan's D3 makes the compiler read all three. Around that, P4 adds things a save must hold: a cord plug in an outlet, re-identification tape on a conductor end, level zones the inspector reads, a lamp that burns out for good, and the state of breakers, GFCIs and AFCIs that must survive a save mid-trip.

Five teams build against this at the same time:

- `sim-engine-engineer` compiles the relations into the netlist, adds remote earth and the T-equivalent, and writes breakers v2, GFCI and AFCI (engine 8, ADR 0021);
- `renderer-engineer` draws plugs, cords, tape and bus stabs, snaps breakers and bulbs, and reads protocol 8 for audio;
- `angular-ui-engineer` builds the palette and console forms for the new commands, the panel and plug UI and the directory editor;
- `content-designer` writes catalogue v3 (ADR 0020) and every new entry;
- the main agent writes the commands and the inspector.

This ADR fixes the persisted shapes, the commands, what the compiler reads, the stream keys, the hash scope, the migration and the contract-level protocol 8 changes, so each team can build against fixtures before the others land. Where the plan was ambiguous or, on inspection, wrong, the choice is made here and listed in [Deviations from the plan](#deviations-from-the-plan).

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
- **Exclusive with the other relations:** an entity with `pluggedInto` has `mountedOn: null` and `inEntry: null`.
- **Not a host for geometry:** nothing about a plug is stored beyond the relation. The cord's drawn shape is a picture, never persisted (the drawn length is not what is wired, as for routes).

### `ConnectionV4.marking`

```ts
interface ConnectionV4 extends ConnectionV3 {
  marking: { a: ColourId | null; b: ColourId | null }; // new: re-identification tape at each end
}
```

- **Tape on a conductor end** (Art. 200.7 by number), set by `wire.mark`. It belongs to the conductor end, not to the termination: it survives `wire.unland`, `wire.land` and a re-made termination, and goes with the connection on delete and its undo.
- **A lead has `{ a: null, b: null }`** (it stays lead-shaped; invariant below). A cable conductor may be marked (the usual case: the white of a 14/2 switch loop re-identified as hot).
- **Colours are colour-table ids** (append-only table, ADR 0015). The schema checks the grammar; the load check checks the table and refuses `bare` (not a tape colour). Which colour is _correct_ is the inspector's, never the load check's.
- **The compiler never reads it.** Neither does the engine: tape is for the inspector and the renderer.

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
- **`use` is a registry id, not a closed enum** (deviation 4): `AREA_USES` in `@controls/catalog` is append-only across catalogue versions, like the colour table. The plan's ten uses are its first rows: `kitchen`, `bathroom`, `garage`, `outdoor`, `laundry`, `bedroom`, `living`, `hall`, `unfinishedBasement`, `crawlSpace`. A new use (a boathouse, a wet bar) is then a catalogue addition, not a `schemaVersion` bump. The load check refuses an id the registry lacks.
- At most `MAX_AREAS` = 256 (game-design: a large house has a few dozen rooms).

### Sim and commanded state keys

ADR 0013's rule holds: **a new model kind's keys need no `schemaVersion` bump; changing an existing kind's keys does.** P4 changes exactly one existing kind, `lamp.incandescent`, so its migration rides on this bump. Every other key below belongs to a new kind and enters saves with it.

**The governing rule for what is persisted** (the save-and-load property, simulation caveats): a bag holds everything that affects the device's future, including the timing of its events. A value that is a pure function of `(seed, entity id)`, the catalogue entry, the world's relations or the tick is derived at every bank build and never stored. So a save at any tick, loaded and advanced, equals running straight through (`world.hash`, `snapshotHash` and the event list).

The key sets of the new kinds are **provisional until v0.5.0** and finalised by ADR 0021 (as ADR 0018 finalised the v3 connection keys), with fixtures updated in the same PR. Key names and value types are save format from v0.5.0.

#### Persisted (in the `sim` bag unless stated)

| Kind(s)                                                      | Key                          | Type, initial                                                                | Why persisted                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lamp.incandescent` (existing kind)                          | `burnedOut`                  | boolean, `false`                                                             | Sticky (D1): the filament opened above the sourced temperature and never closes. In `simTopologyKeys` (an open filament has no element).                                                                                                              |
| `lamp.incandescent`, `light.*`, `appliance.*`                | `overvoltageSinceTick`       | integer ≥ 0 or `null`, `null`                                                | The first tick of the current excursion above ANSI C84.1 Range B (F4.4). The `overvoltage` event fires after a sourced dwell from it; without it a save mid-dwell would move the event. Cleared when the voltage returns inside the range.            |
| `breaker.plugOn1p`, `breaker.gfci1p`, `breaker.afci1p`       | `thermal`                    | number ≥ 0, `0`                                                              | The bimetal's state (the P2 law, D6). A part-heated breaker must reload part-heated.                                                                                                                                                                  |
| `breaker.plugOn2p`                                           | `thermalL1`, `thermalL2`     | number ≥ 0, `0`                                                              | One bimetal per pole, common trip (D6).                                                                                                                                                                                                               |
| every `breaker.plugOn*`, `breaker.gfci1p`, `breaker.afci1p`  | `tripped`                    | boolean, `false`                                                             | As the DIN breaker (P2). Cleared by the handle going off (the `commanded` hook).                                                                                                                                                                      |
| same                                                         | `tripCause`                  | `'thermal' \| 'magnetic' \| 'groundFault' \| 'arcFault' \| 'test'` or `null` | Why it is tripped, so a reloaded panel shows the same cause and records stay a function of the export. `null` exactly when not tripped.                                                                                                               |
| same                                                         | `magneticSinceTick`          | integer ≥ 0 or `null`, `null`                                                | The solve tick at which the current first exceeded the drawn pickup in the current excursion (D6). The breaker opens at that tick plus its drawn opening time; a save inside the 8–20 ms window must open at the same tick. Cleared below the pickup. |
| `receptacle.gfci`                                            | `latched`                    | boolean, `false`                                                             | Whether the contacts are latched closed. **A new GFCI starts unlatched**: it closes only on a reset with line power and no residual, so one fed on its load terminals never conducts (D7). Opened by a trip or a test.                                |
| `receptacle.gfci`                                            | `tripCause`                  | `'groundFault' \| 'test'` or `null`                                          | As the breakers'. `null` while latched and on a GFCI that has never latched.                                                                                                                                                                          |
| `receptacle.gfci`, `breaker.gfci1p`                          | `residualIntegral`           | number 0–1, `0`                                                              | The inverse-time integral Σ dt / t(I) (D7). Trips at 1. Reset to 0 when the residual falls below the drawn pickup.                                                                                                                                    |
| same                                                         | `residualSinceTick`          | integer ≥ 0 or `null`, `null`                                                | The first tick of the current excursion above the pickup: the trip is floored at it plus the drawn mechanism time (D7).                                                                                                                               |
| same                                                         | `testHeldSinceTick`          | integer ≥ 0 or `null`, `null`                                                | The test contact is closed (its internal resistor in circuit, a topology key) from a `test` press until the device trips or `GFCI_TEST_HOLD_TICKS` (game-design, ADR 0021) pass. Persisted because it changes topology and outlives the press's tick. |
| `breaker.afci1p`                                             | `arcSinceTick`               | integer ≥ 0 or `null`, `null`                                                | The first tick the AFCI saw a downstream arcing end at or above 5 A (D8). Its per-bucket trip probability rises with the time since, so the cumulative probability reaches 1 by the UL 1699 limit. Cleared when no downstream end is arcing.          |
| `receptacle.gfci` (commanded)                                | `test`, `reset`              | integer ≥ 0, `0`                                                             | Momentary controls (D7): press counters, incremented only by `device.press`. In `world.hash` through the commanded bag.                                                                                                                               |
| `breaker.gfci1p`, `breaker.afci1p` (commanded)               | `test`                       | integer ≥ 0, `0`                                                             | Their test buttons; reset is the handle.                                                                                                                                                                                                              |
| every breaker kind above (commanded)                         | `on`                         | boolean, `false`                                                             | The handle, as the DIN breaker's (`device.operate`, a toggle).                                                                                                                                                                                        |
| `enclosure.loadCentre` (commanded)                           | `directory1` … `directory42` | `LabelText` or `null`, `null`                                                | The panel directory (D14), one key per space (deviation 5). Keys above the entry's `spaces` stay `null` (load check). Plus the enclosure's `openEntries`.                                                                                             |
| `switch.wall1p` (commanded)                                  | `closed`                     | boolean, `false`                                                             | As `switch.spst` (a new kind: D10).                                                                                                                                                                                                                   |
| `switch.wall3way` (commanded)                                | `position`                   | `'t1' \| 't2'`, `'t1'`                                                       | Which traveller the common is on (a selector).                                                                                                                                                                                                        |
| `switch.wall4way` (commanded)                                | `position`                   | `'straight' \| 'crossed'`, `'straight'`                                      | A selector.                                                                                                                                                                                                                                           |
| `dimmer.wall` (commanded)                                    | `on`, `level`                | boolean `false`; number 0–1, `1`                                             | A toggle and a setpoint (D10). The series reactance is derived from `level` at each solve, never stored.                                                                                                                                              |
| `appliance.resistive`, `appliance.constantPower` (commanded) | `on`                         | boolean, `false`                                                             | A toggle (D12).                                                                                                                                                                                                                                       |

`lamp.incandescent` keeps `filamentTempK`. The DIN `breaker.thermalMagnetic` keeps its P2 keys and behaviour (D6); its `tripped` event gains a cause in the event's `detail`, not in its bag.

#### Derived on load, never persisted

| Value                                                                                                | Derived from                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A plug-on breaker's magnetic pickup (per pole), its opening time; a GFCI's pickup and mechanism time | `(seed, entity id)` through the stream keys below, once per bank build (the P2 pickup precedent). Integer ticks for times, rounded up.                                             |
| An appliance's duty-cycle phase                                                                      | `(seed, entity id)`, the `:duty` stream                                                                                                                                            |
| AFCI per-bucket draws                                                                                | `(seed, entity id, bucket)`, integer mixing (below)                                                                                                                                |
| An AFCI's downstream node set; `wiringGraph`                                                         | The compiled topology, once per topology generation                                                                                                                                |
| Which bus leg a stab contact lands on                                                                | `mountedOn` and the device's offset along the `busStab` mount (exact integers, `mountOffset`)                                                                                      |
| Every contact, cord, earth and grounding resistance                                                  | Catalogue v3 data (values, never topology)                                                                                                                                         |
| The dimmer's series reactance; an LED driver's admittance                                            | `level` and the solution, at each solve (value-only re-solves, D10, D11)                                                                                                           |
| Which press a counter change is                                                                      | The `commanded` hook compares the new counter with the bank's copy; a bank build adopts the saved counter as already seen                                                          |
| Whether a GFCI reset latches                                                                         | Decided in the `commanded` hook at the press's tick from the bank's state and the last solution (both in the export): line voltage present, residual below pickup. No pending key. |

**Undo never rewinds the simulator** (the P2 breaker rule, simulation caveats). Undoing a `device.press` restores the commanded counter; the hook sees the counter fall and does nothing. Redoing it raises the counter and presses again. Undoing a handle-off after a trip leaves the breaker reset, as for the DIN breaker.

### Commands

Every id and argument shape here is save format from the moment it is logged; the commands PR (PR 8) freezes each in `world-model/json-schema/command-args/<id>.args.schema.json`. Each is undoable, restores everything it changed on undo, and **never reads sim-owned state** (the existing property). None takes a tool in P4 (a tape, pen or plug needs none; gating later is a new command or argument version, as `raceway.cut` recorded).

```ts
'plug.insert':     { appliance: EntityId; receptacle: EntityId; outlet: OutletId }
'plug.remove':     { appliance: EntityId }
'wire.mark':       { id: ConnectionId; end: 'a' | 'b'; colour: ColourId | null } // null removes the tape
'panel.directory': { id: EntityId; space: Int; text: LabelText | null }    // space 1..42; null clears
'device.press':    { id: EntityId; control: DeviceStateKey }               // a momentary control
// unchanged ids and byte-identical argument schemas: every P3 command (SHA-256 pins in command-args.spec.ts)
```

- **`plug.insert`** sets the appliance's `pluggedInto`. It checks, in this order (only refused versus accepted is replay format, never which code): the appliance exists (`not-found`) and its entry has a `plug` (`not-an-appliance`); it isn't already plugged (`already-plugged`: remove first, so one gesture is one command); the receptacle exists (`not-found`) and its entry has `outlets` (`not-a-receptacle`) with that id (`unknown-outlet`); nothing is in that outlet (`outlet-occupied`); `NEMA_CONFIGS` says the plug mates the outlet (`wrong-configuration`: a 5-20P won't enter a 5-15R); both entities are at quarter-turns (`not-axis-aligned`); and the cord reaches (`out-of-reach`: `d² ≤ cordLengthMm²` in integers, d from the appliance's catalogue cord exit point to the outlet's face point, both through `entityPointMm`). An appliance that is mounted or in an entry can't be plugged (`mount-mismatch`), and the catalogue never gives a mountable device a plug.
- **`plug.remove`** clears it (`not-found`, `not-an-appliance`, `not-plugged`).
- **Occupancy.** A plugged appliance can't be moved or rotated (`plugged`; unplug first). A receptacle holding a plug is `occupied` for `entity.move` and `entity.rotate`. **`entity.delete` of a receptacle unplugs everything in it** in the same change, and **deleting an appliance takes its plug with it**; undo restores every relation exactly. Deleting a device that is a host for a mounted bulb or breaker stays `occupied` (P3 rule).
- **`wire.mark`** sets one end's tape (`not-found`, `not-a-wire` on a lead, `unavailable-colour` for an id not in the colour table or `bare`). Either end may be landed or free. Setting the value it already has succeeds and is logged (intent, as `device.operate`).
- **`panel.directory`** sets one `directory<space>` key (`not-found`, `not-a-panel` for a kind without a directory, `unknown-space` above the entry's `spaces`). Breaker `entity.label` stays available beside it. The directory may be wrong; that is P5's mislabelled-breaker fault.
- **`device.press`** adds 1 to a momentary control's counter (`not-found`, `not-a-device`, `unknown-control`, `not-momentary` for a control of another type, `ids-exhausted` at `Number.MAX_SAFE_INTEGER`). One logged command per press (D7). **`device.operate` refuses a momentary control** (`momentary`): no older log can hold one, so the new refusal stops nothing that replayed before.
- **`entity.place` is unchanged.** It logs `pluggedInto` nowhere: a placed appliance is unplugged, and plugging is always `plug.insert`. New mount types (`busStab`, `mainBreaker`, `mbj`, `groundBarKit`, `e26`) use the existing `mountedOn` and `checkMount`; a `busStab` position must sit on a whole multiple of the mount type's pitch along it (`off-mount` otherwise; a rule only P4 entries can meet, so no older log is affected).
- **Not commands:** `inspect` is a console query (`CONSOLE_QUERY_ARGS`) and `game.inspect()`; `inspect.run` is unlogged UI. Findings are derived, never stored or hashed (D13).

### What the netlist compiler reads

ADR 0011 §7's "one branch per netlisted connection" and ADR 0015's compiler rules stand. Engine 8 adds **relation contacts** and **remote earth** (D3, D5). For each, the compiler reads only the world's relations, the catalogue and exact integer geometry already validated by the load check; it never reads `areas`, `marking`, `label`, `directory`, routes or colours.

1. **Mount contacts from `mountedOn`.** A catalogue v3 mount type may declare contacts: pairs of (host terminal, device terminal), each compiling to one resistor branch whose value is the mount type's sourced contact resistance. For a `busStab` mount the host terminal is chosen by position: the device's offset along the mount divided by the pitch gives a position index, and the mount type's phase pattern maps it to `busL1` or `busL2` (odd positions L1, even L2 along one column; the space numbering the directory uses is the catalogue entry's map, ADR 0020). A two-pole breaker spans two positions, so its two line terminals always reach both legs. A bulb on an `e26` socket has two contacts (shell and centre) to the holder's terminals. Metal-to-metal bonds (a yoke on a steel box, a ground bar kit on the can, the main bonding jumper) are contacts like any other, to the host's `chassis` terminal.
2. **Entry bonds from `inEntry`.** A conduit connector in an entry of an enclosure with a `chassis` terminal compiles one contact branch between the connector's `chassis` and the enclosure's, when both entries declare one. How conduit parts bond to each other is [open point S7](#sim-engine-engineer).
3. **Plug contacts from `pluggedInto`.** One contact branch per pin of the plug's NEMA configuration, between the appliance's pin terminal and the receptacle outlet's pin terminal (catalogue v3 maps each pin to a terminal on both sides), valued by the configuration's sourced contact resistance. The cord's conductors are resistors inside the appliance's own fragment (D12: from `cordAwg` and `cordLengthMm`, like a conductor, no thermal node in P4).
4. **A contact compiles only when both sides are netlisted and declare its terminals.** Otherwise it is absent, with a diagnostic (`absent-contact`, with the relation and a reason). So every P3 entry (no contacts, no `chassis`) compiles exactly as in engine 7, apart from D4 below, and a mount that declares no contacts (a DIN rail, a yoke on a nonmetallic box) adds nothing.
5. **Remote earth (D5).** One implicit earth node per netlist, present only when an element connects to it: the `service.splitPhase` neutral's utility grounding resistance, and a ground rod's `earthResistanceOhm` from its electrode terminal. It is never in the world. It appears in the netlist and the descriptor as the reserved member `{ entity: 0, terminal: 'earth' }` (entity ids start at 1, so 0 is free); `touchVoltageV` in records is measured against it. The `utility.*` stand-in supplies and the generator stub get no earth connection, so the workshop gains no earth node.
6. **The T-equivalent (D4)** gives every split-phase source (`utility.splitPhase`, `generator.portable`, `service.splitPhase`) an internal centre-tap node and a neutral element: a structural change to those models, so every `topologyHash` of a world holding one moves at engine 8. How a device fragment declares an internal node is ADR 0021's.
7. **New element refs.** A contact branch is a new `ElementRef` kind: `{ kind: 'contact'; entity: EntityId; relation: 'mount' | 'entry' | 'plug'; contact: string }`, where `entity` is the dependent entity (the mounted device, the connector, the appliance) and `contact` the contact's id from the catalogue (a mount type's contact id or a plug pin). Branch order: every entity's own elements, then every connection, then every contact ordered by (entity, relation code, contact id). So branch currents through a stab, a bond or a plug pin are in the solution and the snapshot like any branch's: no extra record is needed for them.
8. **What stays out.** No thermal node on a contact in P4 (D3, an abstraction documented in ADR 0021). Inspector-only catalogue data (terminal `role` and `side`, marked volumes, materials) is never read by the compiler.

**`wiringGraph`** (D13, exported from `sim-core`) applies the same joins and the same contact rules, with switching devices treated as closed and protective devices as line → load paths, so the inspector and the simulator never disagree about what is connected (a property ties it to `compileNetlist`).

**What moves `topologyHash`:** mounting, unmounting, deleting or sliding to another stab position a device with contacts; a connector entering or leaving an entry with a bond; `plug.insert` and `plug.remove`; the earth node's first and last connection; a lamp's `burnedOut`; a GFCI's `latched` and `testHeldSinceTick` going null ↔ non-null; a breaker's `tripped` (as now). **What doesn't:** every contact, cord, earth and grounding resistance; tape, areas, directory text, labels; the dimmer's level; an appliance's `on` where its model keeps the element and changes its value (ADR 0021 decides per kind).

**The `CNT` encoding stays at version 1.** The branch tag gains the value 2 (a contact: varint entity, u8 relation code, str contact id), appended like an element-kind code, and the earth member encodes as entity 0. No world without contacts or an earth node encodes differently, so the encoding version doesn't move; the hashes that move do so because their netlists changed. If `sim-engine-engineer` finds an existing byte that would move, the version byte goes to 2 in the engine 8 PR instead (open point S6).

### PRNG stream keys

`deriveStream(seed, key)`, its golden vectors and every P3 key are unchanged. P4 adds one key function in `world-model/src/lib/prng.ts`:

```ts
entityPurposeStreamKey(id: EntityId, purpose: string): string // `entity:${id}:${purpose}`
```

Each value below is the **first output** of its own stream (`nextFloat()`), drawn once per bank build, so no draw depends on how many another took and a kind gaining a draw later moves nothing else:

| Draw                                         | Stream                              | Mapping (bands from the entry, ADR 0021)                             |
| -------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| Magnetic pickup, pole 1 (every breaker kind) | `entity:<id>` (unchanged P2 rule)   | I_min + (I_max − I_min) u; the shared magnetic code path stays P2's  |
| Magnetic pickup, pole 2 (`breaker.plugOn2p`) | `entity:<id>:pickupL2`              | as pole 1                                                            |
| Opening time above the pickup                | `entity:<id>:opening`               | ⌈t_min + (t_max − t_min) u⌉ ticks (8–20 ms for 15/20 A)              |
| GFCI pickup                                  | `entity:<id>:gfciPickup`            | 4 + 2u mA (the sourced Class A band)                                 |
| GFCI mechanism time                          | `entity:<id>:gfciMechanism`         | ⌈3 + 11u⌉ ticks                                                      |
| Appliance duty-cycle phase                   | `entity:<id>:duty`                  | ⌊period · u⌋ ticks                                                   |
| AFCI per-bucket draw                         | base `entity:<id>:afci`, then mixed | u = fmix32(s ^ Math.imul(bucket, 0x9e3779b1)) / 2³², s its first u32 |

- **The AFCI follows ADR 0018's intermittent pattern** (deviation 3): the stream's cached first output mixed with the absolute bucket index using integer operations only, so no string is built per bucket, no generator state is persisted, and the outcome is a pure function of `(seed, id, bucket)`, identical across runs, replays, transports and a save and load. The bucket length is ADR 0021's (sourced or game-design, a multiple of `SOLVE_INTERVAL_TICKS`).
- **No P4 command draws.** `plug.insert`, `wire.mark`, `panel.directory` and `device.press` are deterministic; no P4 world command draws from `commandStreamKey(seq)` either.
- The purpose strings above are frozen with v4 at v0.5.0, with golden key strings and first outputs in `prng.spec.ts`. Changing a mapping or a draw moves every saved device's behaviour: a determinism change, `SIM_ENGINE_VERSION` at least.

### Schema invariants

Zod refinements on `WorldV4` (not in the JSON Schema), each with a refused fixture under `fixtures/v4/refused/world/`. ADR 0015's invariants 1–8 carry over unchanged, plus:

9. **Relations.** `pluggedInto.entity` names another entity that exists; at most one entity per `(entity, outlet)`; never together with `mountedOn` or `inEntry`; **mounts, entries and plugs together form no cycle** (one walk over all three, replacing v3's two; a strip plugged into a strip plugged into the first is refused).
10. **Markings.** A lead-shaped connection has `marking: { a: null, b: null }` (invariant 4 extended).
11. **Areas.** Sorted by strictly ascending id (UTF-16 code units, as fixtures); no area id equals a fixture id (so a later `view.focus` on an area is unambiguous); `minMm < maxMm` on every axis; at most 256.

**In the load check** (`checkWorldReferences`, still `invalid-device-state`, still leaving unknown refs alone): the appliance's entry has a `plug` and the host's entry has that outlet; the configurations mate; both are at quarter-turns and the cord reaches (the command's own check, so a crafted save can't hold a plug the command would refuse); marking colours are in the colour table and not `bare`; area uses are in `AREA_USES`; a load centre's `directory<n>` keys above its entry's `spaces` are `null`, and each text is `LabelText`; momentary counters are non-negative integers; a breaker's `tripCause` is `null` exactly when it isn't tripped, and a GFCI receptacle's is non-null only while it is unlatched; `busStab` positions sit on the pitch (`checkMount`). Bag key sets are checked against `MODEL_KINDS` as before.

### Hash scope

- **`world.hash`** keeps its definition (SHA-256 of the canonical JSON of the parsed world, ADR 0007), so it covers `areas`, `pluggedInto`, `marking`, the new bags (press counters and directory text included) and every relation. Every world gains `"areas":[]`, `"pluggedInto":null` per entity and `"marking":{"a":null,"b":null}` per connection, and every lamp bag gains its new keys, so **every pinned world hash is re-pinned once, at the world v4 PR** (PR 7), listed old → new in the CHANGELOG. Engine 8 re-pins once more for numeric reasons (PR 9), with its own list.
- **`topologyHash`**: as [above](#what-the-netlist-compiler-reads); `hash.spec.ts` gains one golden per new model kind and one per contact relation and for the earth node.
- **`snapshotHash`** covers the protocol 8 records (below), so every scenario with a lamp, a lead or a wire moves at protocol 8.
- **Not in any hash:** inspector findings, `wiringGraph`, audio cues, the cord's drawn shape, display state, events.

### The v3 → v4 migration

Pure and total (`v4/from-v3.ts`, kept forever; the tests deep-freeze the input and run each step twice). It doesn't read the catalogue.

- **World:** `schemaVersion: 4`, `areas: []`. Each entity gains `pluggedInto: null`. Each connection gains `marking: { a: null, b: null }`. **Each entity whose ref is in `LAMP_INCANDESCENT_REFS_V3`** gains, in its `sim` bag, `burnedOut: false` and `overvoltageSinceTick: null` (each only if absent; an entity with a ref outside the list, an unknown ref included, is copied untouched).
  - `LAMP_INCANDESCENT_REFS_V3` is a frozen literal in `from-v3.ts`: the `lamp.incandescent` entries that a v3 save can name, `{ id: 'lamp.lumivane-12v-5w', version: 1 }` and `{ id: 'lamp.lumivane-120v-60w', version: 1 }`. Catalogue 2 is frozen, so the list is complete for every save v0.4.0 wrote; a parity test in `@controls/catalog` requires it to equal the `lamp.incandescent` entries of the frozen catalogue-2 snapshot, and the v4 literal never changes. (Deviation 1: the plan said "lamp bags `burnedOut: false`", which a catalogue-free step can only do by ref.)
- **Replay log:** `initialWorld` migrated as above; **every entry copied verbatim**. No P3 command's id or argument shape changed, and no P4 command exists in a v3 log.
- **Manifest:** `schemaVersion: 4`; `catalogVersion` and `simEngineVersion` kept as saved.
- **Every v1, v2 and v3 fixture migrates and validates as v4.** A 0.4.0 save (catalogue 2, engine 7) loads as `engine-changed`, never refused: `world.json` as saved and migrated, the solution record dropped, solved again at the save's tick, the log restarted (ADR 0011 §9.6). A fixture test proves it on the frozen `fixtures/v3/ctrl/*-engine-7-catalog-2.ctrl` saves; none is regenerated.
- **Known edge:** a dev-build v3 save written between the catalogue v3 PR and the world v4 PR could hold a catalogue-3 entry of a kind whose keys this bump changes. None is planned (the first new lamp entries land after world v4, PR 12). If one appears, it is refused as `invalid-device-state` like any provisional-version change.

### `catalogVersion` 3: what this ADR depends on

Catalogue v3 (ADR 0020, PR 6) lands before world v4. This ADR needs, and ADR 0020 specifies:

- **Mount-type contacts:** `contacts: { id, host, device, contactOhm }[]` on a mount type (or the entry's mount), with a source per value; for `busStab`, a `pitchMm` and the phase pattern by position index; `MOUNT_TYPES` rows `busStab`, `mainBreaker`, `mbj`, `groundBarKit`, `e26`.
- **A `chassis` terminal convention** on every kind that bonds (the load centre, `enclosure.metalBox`, conduit fittings if open point S7 says so, metal-cased appliances), and a `ground` terminal bonded to the yoke on every wiring device (D10).
- **Receptacle `outlets: { id, config, positionMm, pins: { pin, terminal }[] }[]`** and **appliance `plug: { config, cordAwg, cordLengthMm, cordExitMm, pins: { pin, terminal }[] }`**, over the code registry **`NEMA_CONFIGS`** (pins per configuration, which plugs mate which receptacle, contact resistance, NEMA WD 6 by number).
- **The `momentary` control type**, whose key is a commanded integer counter named by the control id (`checkControlValue`: a non-negative integer; never settable by `device.operate`).
- **The load centre entry's `spaces`** (at most 42) and its map from directory space number to (mount, position index).
- **`earthResistanceOhm`** on ground-rod entries (computed offline, D5), and the service entry's utility grounding resistance.
- **The `AREA_USES` registry**, append-only, with the plan's ten rows.
- Inspector-only data the compiler never reads: terminal `role` and `side`, `multiConductor`, `markedVolumeMm3`, `material`.
- The existing requirement (ADR 0015): a shipped `(id, version)` resolves in every later catalogue; `shipped.spec.ts` freezes catalogue 2's entries; `tb.quennick-st4@2` beside `@1`.

### Protocol 8 (contract level; an ADR 0011 amendment)

Listed here so the persisted keys and the published fields are designed together. **Byte layouts, the validity bits and the sign-offs belong to the ADR 0011 amendment in the protocol 8 PR (PR 11)**, which `renderer-engineer` and `angular-ui-engineer` sign. Everything here is provisional until then.

- **Descriptor.** `ElementRef` gains the `contact` kind (above). Node members may include the earth member `{ entity: 0, terminal: 'earth' }` (the member schema allows entity 0 with exactly that terminal); readers never look entity 0 up in the world. Contact branches carry their currents in the existing branch section.
- **Device records for every new kind**, each ending in the validity `status`:
  - plug-on breakers: per-pole `currentA` and `thermalFraction`, `magneticPickupA` (per pole), `openingMs`, `state` [`off`, `on`, `tripped`], `tripCause`;
  - GFCI (receptacle and breaker): hot and neutral pole currents, `residualMa`, `pickupMa`, `residualIntegral`, line-side and load-side voltages, `state` [`unlatched`, `latched`, `tripped`], `testHeld`, `tripCause`;
  - AFCI: the breaker fields plus `arcDetected` and the time since `arcSinceTick`;
  - load centre: per-leg bus current, the main bonding jumper's and the GEC's currents, `touchVoltageV`;
  - every kind with a `chassis` terminal: `touchVoltageV` against remote earth, a reading only when its island holds the earth node;
  - receptacles: per outlet the face voltages hot–neutral, hot–ground and neutral–ground (what P5's receptacle tester reads);
  - LED lights: `powerW`, `voltageV`, `lightOutputRel`, driver state [`off`, `running`]; appliances: `powerW`, `currentA`, `voltageV`; the dimmer: `levelRms`, load voltage;
  - **`lamp.incandescent` gains `burnedOut`** (a layout change to an existing kind).
  - The DIN breaker's record is unchanged (its bag has no cause).
- **Connection records gain `endADegradation` and `endBDegradation`** (f64, own state: the carried P3 readout item), so the readout says "degrading" only above the onset.
- **Events.** `tripped` carries `detail.cause` (`thermal | magnetic | groundFault | arcFault | test`) for every breaker kind and the GFCI receptacle; new kinds **`lampBurnout`** (the lamp; `detail: { filamentTempK }`) and **`overvoltage`** (the device; `detail: { voltageV }`). Each is derived from persisted state, so the event list after a save and load equals the uninterrupted run's. Which events toast and which only announce is the amendment's (open point U5).
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

1. **The migration adds lamp keys by a frozen ref list** (`LAMP_INCANDESCENT_REFS_V3`): a catalogue-free step can't know an entity's kind any other way.
2. **`lamp.incandescent` gains a second key, `overvoltageSinceTick`,** beside `burnedOut`, so the F4.4 `overvoltage` event survives a save mid-dwell. It rides on the same migration; dropping it before v0.5.0 is free (open point S4).
3. **AFCI draws use `entity:<id>:afci` and integer bucket mixing**, not the plan's `afci:<entity>:<bucket>` key: one stream derivation per bank build instead of a string per bucket, a pure function of the same inputs, and ADR 0018's pattern; no sixth key prefix.
4. **`AreaV4.use` is a registry id** (`AREA_USES`, append-only), not a closed enum: a new use is a catalogue row, not a `schemaVersion` bump (ADR 0015's colour-table reasoning).
5. **The panel directory is one commanded key per space** (`directory1` … `directory42`): a bag value is a scalar, so D14's "space number → label text" map can't be one key. 42 spaces is the cap a load-centre entry may declare.
6. **New refusals the plan didn't list:** `not-a-receptacle`, `unknown-outlet`, `already-plugged`, `not-plugged`, `plugged`, `not-axis-aligned` (plug reach), `mount-mismatch` (a mounted appliance), `not-a-panel`, `unknown-space`, `momentary` (`device.operate`), `ids-exhausted` (a press counter).
7. **A new GFCI receptacle starts unlatched**, so line/load reversal is observable from installation (D7's "fed on its load terminals it never latches").
8. **A stab's bus leg is derived from the device's position on the mount** (pitch and phase pattern), not stored in `mountedOn`: the transform is already stored, exact and load-checked, and a stored slot could disagree with it.
9. **Contact branches get their own `ElementRef` kind and branch tag**; the `CNT` encoding keeps version 1 (D5 left "a `CNT` bump if the hash needs one" open).
10. **Remote earth is in the netlist only when something connects to it**, and only `service.splitPhase` and ground rods connect in P4: the workshop's stand-in supply gets none.

## Consequences

- `save-format`: `v4/{world,manifest,replay-log,from-v3}.ts`, the chain extended, `CURRENT_SCHEMA_VERSION` 4, the `OutletId`, `AreaId` and `AreaUseId` primitives, `*.v4.schema.json` with staleness, fixtures under `fixtures/v4/{world,manifest,replay-log,ctrl}` (a plugged appliance, marked conductors, areas, a tripped GFCI mid-run, a part-heated breaker inside its opening window, a burned-out lamp) and `fixtures/v4/refused/world/` per new invariant; a fast-check arbitrary for v4 worlds with the JSON and container round-trip properties; the purity tests for `from-v3.ts`.
- `catalog`: the keys above in `MODEL_KINDS` (`device-state.<kind>.schema.json` per new kind, and `lamp.incandescent`'s regenerated); `AREA_USES`; the momentary control type; the `LAMP_INCANDESCENT_REFS_V3` parity test; everything ADR 0020 lists.
- `world-model`: the five commands and their frozen argument schemas; `entity.delete` unplugging; the `plugged` and `occupied` rules; `device.operate`'s `momentary` refusal; `checkWorldReferences` for plugs, markings, areas, directories and the stab pitch; `entityPurposeStreamKey`; properties (undo restores relations and counters; no command reads `sim`; deleting a receptacle or appliance never leaves a dangling plug).
- `sim-core`: contacts from `mountedOn`, `inEntry` and `pluggedInto`; the earth node; the T-equivalent; `wiringGraph`; the new kinds' banks with the keys above; the `commanded` hook for presses and resets; `hash.spec.ts` goldens; engine-numbered fixtures.
- `sim-protocol`: the ADR 0011 amendment (protocol 8).
- `scripting-api` and `sim-cli`: the console forms of the new commands, `game.inspect()`, the house scenarios, the 0.4.0 `engine-changed` fixture test.
- Docs (in the implementing PRs, by `docs-keeper`): save-format caveats (v4, the frozen lamp list, `catalogVersion` 3, engine 8), commands caveats (new refusals, occupancy, press semantics), simulation caveats (contacts, earth, persisted protection state), `world-and-saves.md`, `wiring.md`, `docs/history.md` (`schemaVersion` 4, `catalogVersion` 3, `simEngineVersion` 8), the glossary.

## Alternatives considered

- **A cord as connections** (D1 rejected): three connections with plug "terminals" that aren't screws, terminations that aren't made, and routes for a cord nobody routes.
- **A plug as `mountedOn`** (D1 rejected): mounting fixes the transform at the host and frames the orientation, and a plugged lamp stands where it was put.
- **`burnedOut` on a new lamp kind** instead of the existing one: no migration, but the P3 120 V lamp and the bench lamp could never burn out, and the A19 bulbs would split from the filament model they share.
- **Filling missing keys on load** instead of migrating: the load check is exact about key sets for a reason (a crafted bag with a missing key is damage), and "fill on load" would make the bag's meaning depend on the build.
- **Storing the stab slot in `mountedOn`**: redundant with the stored transform and able to disagree with it; a v4 shape change for no new information.
- **Storing opening times, pickups and mechanism times**: they follow from seed and id (the P2 pickup precedent); storing them would freeze another engine's draws into old saves.
- **A pending-reset key** for the GFCI: the hook can decide from state already in the export, so a pending flag would be a key with no information.
- **A held `test` toggle** (D7 rejected): two commands per press, and a test the player could leave held.
- **One `afci:<entity>:<bucket>` stream per bucket**: same determinism, a string per bucket and a new prefix.
- **A closed `use` enum**: every new area use after v0.5.0 would be a `schemaVersion` bump.
- **Contacts as ideal joins** (D3 rejected): no current through a stab, a bond or a plug pin, so no objectionable-current reading.
- **Bumping `CNT` to version 2 regardless**: moves every persisted `topologyHash` for no structural reason in worlds without contacts.

## Open points for reviewers

Each point has the default this ADR takes; a reviewer either agrees or proposes a change before Accepted.

### `sim-engine-engineer`

- **S1** The protection key lists and names (`thermal` / `thermalL1`/`thermalL2`, `tripped`, `tripCause`, `magneticSinceTick`, `latched`, `residualIntegral`, `residualSinceTick`, `testHeldSinceTick`, `arcSinceTick`). Default as tabled. In particular: absolute since-ticks rather than elapsed counters (no per-tick writes, save parity structural); is anything in your planned GFCI or AFCI state machine missing?
- **S2** The GFCI reset decided inside the `commanded` hook from the last solution (line voltage, residual) with no pending key. Default: yes. If the hook can't see what it needs at that tick, propose the minimal persisted key instead.
- **S3** The test press holding the test resistor in until trip or `GFCI_TEST_HOLD_TICKS`. Default: yes, with a game-design hold you choose in ADR 0021.
- **S4** `overvoltageSinceTick` on `lamp.incandescent`, `light.*` and `appliance.*`. Default: keep (events survive a save). Say if the lamp should only burn out and never raise `overvoltage`; dropping it before PR 7 lands is free.
- **S5** An LED driver with hysteresis at dropout would need a `running` key committed in `afterSolve` (the F2.4 rule). Default: no hysteresis, no key; say before PR 7 if you want one.
- **S6** The `CNT` encoding staying at version 1 with branch tag 2 and earth as entity 0. Confirm no existing byte moves, or bump to 2 in PR 9.
- **S7** EMT as an EGC (F4.3 part 1). Default: conduit kinds gain a `chassis` terminal and a bond-only model in engine 8 (terminals are code, not save format); connector-to-enclosure from `inEntry`; stick-to-stick and stick-to-fitting joins derived in the compiler from the same integer joint predicate `conduitContinuityProblem` uses (ends at one point, opposite directions), never stored. If you'd rather defer EMT bonding past P4, say so and F4.3 drops the bullet. Storing joints later is ruled out (a migration can't read the catalogue), so the choice is derive-forever or never.
- **S8** The AFCI bucket mixing and its bucket length; the hazard rising with time since `arcSinceTick`.
- **S9** The compiler reading `mountOffset` for stab legs (it imports `world-model` already for SHA-256).
- **S10** Earth only for `service.splitPhase` and ground rods; the `utility.*` stand-ins and the generator stub stay unearthed.

### `renderer-engineer`

- **R1** Contact branches in the descriptor: overlays have no mesh for them. Default: the voltage and current overlays skip `contact` branches; the panel hum (D15) sums the bus stab currents from the branch section.
- **R2** The earth member (entity 0) in node members: readers must not look it up. Confirm `NetlistReadout` and the overlays tolerate it.
- **R3** Audio cues (D15) from protocol 8: `tripped` with cause, GFCI `state` changes in records, `device.press` and `plug.*` applied commands, `lampBurnout`, the arcing end states. Anything missing for ADR 0023?
- **R4** Plug reach uses `entityPointMm` on a catalogue `cordExitMm` and the outlet's `positionMm`; the cord is drawn, never stored. Agree that placement maths never proposes an unreachable plug and that the plug gesture pre-checks with the command's exported check.
- **R5** `busStab` snapping to the pitch (positions refused off it) and `e26` bulb placement through `placeInWorld`.
- **R6** The connection record growing by two f64 (`NetlistReadout`'s fast-path constants move).
- **R7** Tape (`marking`) drawn as a band at the end; a picture only.

### `angular-ui-engineer`

- **U1** Palette forms for the five commands: `plug.insert` needs entity refs for both entities and an outlet chosen from the receptacle's entry (a new `x-controls-ref` hint, or a plain text field); `wire.mark` needs the `connection` ref and a nullable colour; `panel.directory` a nullable `LabelText`; `device.press` a control id. The hints must land before PR 8 freezes the schemas.
- **U2** `device.operate` refusing a momentary control, and a press binding (`device.press.selection` on a `when` disjoint from the operate key's). Binding ids are stable once shipped.
- **U3** The panel UI shows trip state and cause from records, never from the commanded `on` (the P2 rule).
- **U4** The directory editor: 42 spaces, `LabelText` (printable ASCII, 1–32 characters); how non-ASCII input is refused before logging.
- **U5** Which new events toast (default: `tripped` for every breaker kind and the GFCI receptacle, coalesced as now; `lampBurnout` announced, not toasted; `overvoltage` in the inspector and dev console only).
- **U6** Refusals shown before logging in the plug gesture (pre-check with the same exported checks `run` uses).

### `content-designer`

- **C1** The catalogue v3 fields listed [above](#catalogversion-3-what-this-adr-depends-on): anything ADR 0020 can't provide in that shape?
- **C2** `LAMP_INCANDESCENT_REFS_V3`: confirm the two shipped lamp entries are the only `lamp.incandescent` refs a v0.4.0 save can name.
- **C3** `AREA_USES` ids (the plan's ten) and whether the house needs another (a utility room, a porch).
- **C4** The 42-space directory cap; each load-centre entry's `spaces` and its space → (mount, position) map.
- **C5** Selector values: `switch.wall3way` `position` `t1 | t2`, `switch.wall4way` `straight | crossed`, the dimmer's `on` plus `level`.
- **C6** Momentary control ids `test` and `reset`, and which kinds carry them (default: GFCI receptacles both; GFCI and AFCI breakers `test` only).
- **C7** A new GFCI receptacle unlatched (realism check: products ship unlatched and need line power to reset).
- **C8** The DIN rail's PE-block foot bond (`terminalBlock.ground`) stays out of P4: `din35` declares no contacts.
- **C9** Which kinds carry a `chassis` terminal (load centre, `enclosure.metalBox`, metal-cased appliances, conduit fittings per S7).
- **C10** Tape colours: any colour-table id except `bare`; correctness is the inspector's.

## Review

Pending. Each reviewer's verdict, the changes applied and the conflicts resolved are recorded here before the status moves to Accepted.
