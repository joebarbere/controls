# ADR 0015: World document v3 and the wire contract

**Status:** Proposed (2026-11-11), pending the agent-team review. P3 kickoff step 3. Drafted by `save-format-guardian` (lead); reviewers `sim-engine-engineer`, `renderer-engineer`, `angular-ui-engineer` and `content-designer` (see [Open questions for reviewers](#open-questions-for-reviewers)). No v3 code lands before this is Accepted. `schemaVersion` 3 stays provisional until v0.4.0 ships (fixtures updated in the same PR as any change), then it is frozen.
**Date:** 2026-11-11 (Phase 3)
**Sources:** [phase 3 plan](../../plans/phase-3-wiring.md) kickoff step 3 and decisions D1–D5, D8–D11, D15, D19, the world v3 and command checklists, F3.1–F3.6; [ADR 0004](0004-save-format.md) (save format rules); [ADR 0007](0007-world-document-v1.md) (ids, hash, PRNG, replay log); [ADR 0010](0010-wire-routing-spike.md) (what P3 must build and avoid); [ADR 0011](0011-sim-worker-contract.md) §1, §5.4, §7, §9.6, §12 (ownership, records, one branch per connection, the solution record); [ADR 0013](0013-world-document-v2.md) (v2, bags, `MODEL_KINDS`, the load check, the materialisation scope); [save-format](../caveats/save-format.md) and [commands](../caveats/commands.md) caveats

## Context

World v2 (ADR 0013) persists test leads: two-ended connections with no geometry, no state and a resistance fixed by their catalogue entry. P3 makes the player wire for real. Every new idea (a conductor with a route and a length, a cable that owns several conductors, a termination with a quality, an enclosure with mounts and knockouts, a device mounted in it, a label) is something a save holds and a replay must reproduce. Five teams build against it at the same time:

- `sim-engine-engineer` compiles conductors into the netlist and heats them (F3.1, F3.3 part 1, F3.6);
- `renderer-engineer` routes and bakes them, draws them and picks them (F3.2, F3.5);
- `angular-ui-engineer` builds the termination prompts, the tool belt and the fish tape (F3.3 part 2, F3.4);
- `content-designer` writes the conductor, cable, enclosure and tool entries (catalogue v2, ADR 0016);
- the main agent writes the `wire.*`, `cable.*`, `enclosure.*` and `entity.*` commands.

D1 fixed the outline (one `connections` array for leads and wires, nullable ends, a `cables` array, `mountedOn`, one `schemaVersion` 3). This ADR fixes the shapes, the commands and their refusals, what the compiler reads, the stream keys, the hash scope and the migration, so each team can build against fixtures before the others land. Where the plan was ambiguous or, on inspection, wrong, the choice is made here and listed in [Deviations from the plan](#deviations-from-the-plan).

## Decision

### One `schemaVersion` 3

`world.json`, `manifest.json` and `replay.log` move to `schemaVersion` 3 together (the one-version rule), with a total, pure v2 → v3 migration. v1 and v2 schemas and fixtures stay untouched. The `.ctrl` container's entry layout doesn't change. `ManifestV3` is `ManifestV2` with `schemaVersion: 3` (an identity step).

The sketches below are TypeScript-like for reading; the Zod schemas in `libs/domain/save-format/src/lib/v3/` are authoritative, every object is strict, and no field is optional (absent is `null`).

```ts
type Int = number; // a safe integer, -0 normalised
type FiniteNumber = number; // finite, -0 normalised
type EntityId = Int; // >= 1, below nextEntityId
type ConnectionId = Int; // >= 1, below nextConnectionId
type CableId = Int; // >= 1, below nextCableId
type PositionMm = { x: Int; y: Int; z: Int }; // PositionMmV1: integer mm, |c| <= 10 km
type LabelText = string; // printable ASCII 0x20-0x7E, 1..32 chars, no leading or trailing space
type ColourId = string; // /^[a-z][a-zA-Z0-9]{0,31}$/, a colour in the catalogue's colour table
type TerminationMethodId = string; // /^[a-z][a-zA-Z0-9]{0,31}$/, a method in @controls/catalog's registry
```

### `WorldV3`

```ts
interface WorldV3 {
  schemaVersion: 3;
  seed: Int; // u32
  tick: Int;
  nextEntityId: Int;
  nextConnectionId: Int;
  nextCableId: Int; // new: its own counter (below)
  regionId: RegionId;
  difficulty: Difficulty;
  assisted: boolean;
  fixtures: FixtureV1[];
  entities: EntityV3[];
  connections: ConnectionV3[]; // leads and conductors, one id space
  cables: CableV3[]; // new
  sim: SimSolutionV2 | null; // unchanged (ADR 0011 §9.6)
  extensions: Extensions;
}
```

### `EntityV3`: `mountedOn` and `label`

```ts
interface EntityV3 {
  id: EntityId;
  ref: CatalogRef;
  transform: TransformV1;
  state: DeviceStateBag; // commanded (ADR 0013)
  sim: DeviceStateBag; // sim-owned (ADR 0013)
  mountedOn: { entity: EntityId; mount: MountId } | null; // MountId: TerminalId's grammar
  label: LabelText | null;
  extensions: Extensions;
}
```

- **`mountedOn`** records which enclosure (or enclosure part: a DIN-rail panel, a box's device yoke) holds the device, and on which of its catalogue mounts. It is a relation, not a transform parent: the device's `transform` stays absolute and nothing inherits it (D11). P4's box fill counts from it. A fixture (level geometry, such as the workshop's own DIN rail) is never a host in P3: a device placed on one has `mountedOn: null`.
- **`label`** is the text of a printed label on the device (`TB1`, `CB3`), set with `entity.label`. Device labels and wire labels share `LabelText`, which is printable ASCII so every label renders in the one bundled font and survives every encoder.
- **Enclosure knockouts are a commanded state key** (D11): an enclosure kind has the commanded key `openEntries`, an integer bit set over the catalogue entry's `entries[]` in their catalogue order (bit _i_ set means entry _i_ is open). So an enclosure entry has at most 32 entries (`>>> 0` stays exact), the catalogue refuses more, and **the order of an enclosure entry's `entries[]` is save format**: changing it needs a new entry version. A bag keeps the shape generic (a new enclosure kind needs no bump), where a typed list of open entry ids would have been a world field per enclosure.

### `ConnectionV3`: leads and conductors

```ts
interface ConnectionV3 {
  id: ConnectionId;
  ref: CatalogRef; // a connection kind: `lead` or `conductor` (F3.1)
  a: ConnectionEndV3 | null; // null: an unlanded end, lying free
  b: ConnectionEndV3 | null;
  cable: { id: CableId; conductor: Int } | null; // the cable and the index in its assembly
  route: WaypointV3[] | null; // the conductor's own route; null for a lead or a cable conductor
  lengthMm: Int | null; // cut length, 1..1 000 000; null for a lead (its length is catalogue data)
  colour: ConductorColourV3 | null; // null for a lead
  label: LabelText | null; // a printed sleeve marker
  state: DeviceStateBag; // commanded; {} for every P3 kind
  sim: DeviceStateBag; // sim-owned: the thermal and contact state (below)
  extensions: Extensions;
}

interface ConnectionEndV3 {
  entity: EntityId;
  terminal: TerminalId;
  termination: TerminationV3 | null; // null for a lead's clip; never null on a landed conductor end
}

interface ConductorColourV3 {
  base: ColourId; // 'black', 'white', 'green', 'bare', …
  stripe: ColourId | null; // a tracer stripe, or null
}
```

- **A lead** is lead-shaped: `cable`, `route`, `lengthMm`, `colour` and `label` are null, both ends are non-null and both `termination`s are null (its clips' contact resistance stays catalogue data, D2).
- **A conductor** has `lengthMm` and `colour`, and exactly one of `route` (a single conductor: THHN in a duct, a pull through conduit) and `cable` (one conductor of a cable assembly, which shares the cable's route). Each landed end has a `termination`.
- **A connection with a null end is not netlisted** (wired, not drawn, D1). It keeps its route, length and sim state; it carries nothing.
- **Colours are ids, not an enum**, validated against the catalogue's colour table at the command and at load. Adding a colour (or a striped insulation) is catalogue data, never a schema change; a closed enum would have needed a bump for every new colour after v0.4.0.
- **`cable.conductor`** is the index in the cable assembly's `conductors[]` (catalogue v2): it says which role (ungrounded, grounded, EGC) and which assembly colour the conductor is, explicitly rather than by the rank of its id. The plan's sketch had `cable: id`; an object keeps the save self-describing.

### `TerminationV3` and `TerminationArgs`

A termination is **the outcome of the tool steps**, recorded when the end is landed (D8, D9): what was physically made, not what the player asked for, and not the contact resistance. The command resolves arguments into an outcome (with any seeded spread drawn there and then, from `commandStreamKey(seq)`); the engine computes contact resistance from the outcome (ADR 0018). So the save holds physical facts, a better contact model changes old saves' resistances only through `SIM_ENGINE_VERSION` (never their documents), and `world-model` never needs `sim-core`.

```ts
// What a surface sends (the logged argument): one per end, one `wire.land` (or `wire.add` end) each.
type TerminationArgs = {
  method: TerminationMethodId; // one of the terminal's `methods` ('wrong-method')
  strip: { tool: CatalogRef; hole: HoleId; lengthMm: Int }; // a stripper, one of its gauge holes, 1..100 mm
  accessory: { ref: CatalogRef; tool: CatalogRef; die: DieId } | null; // a ferrule or lug, crimped with a die
  clamp: { tool: CatalogRef | null; torqueNm: FiniteNumber | null }; // the driver; a torque setting or null
};
type TerminationArg = 'auto' | TerminationArgs; // 'auto' only at Trainee (D9)

// What the world stores.
interface TerminationV3 {
  method: TerminationMethodId;
  auto: boolean; // made by 'auto' (the ideal outcome)
  seq: Int; // the seq of the command that made it: its identity and its stream (below)
  stripLengthMm: Int; // as stripped, 0..1000
  nickedStrandFraction: FiniteNumber; // 0..1: the share of the conductor's area lost to the stripper
  torqueNm: FiniteNumber | null; // achieved clamp torque (>= 0); null for a method without one
  accessory: { ref: CatalogRef; crimpQuality: FiniteNumber } | null; // 0..1, 1 = the right die, fully closed
}
```

- **Tools travel inside the termination.** One landing uses up to three tools (a stripper, a crimper, a driver), so a single `tool` field (the plan's `wire.land {…, tool}`) couldn't check them. Each step names its tool and the command checks its kind (`wrong-tool`), its gauge hole (`unknown-hole`) and its die (`unknown-die`). D9's "strip and ferrule fold into one action per end; torque is a separate tool action" is a UI sequence of two prompts that ends in one logged `wire.land`, never two commands (a half-landed end would otherwise be a persisted state with no physical meaning).
- **`'auto'`** resolves to the terminal's first method with the ideal outcome (its specified strip length, no nicks, its specified torque or null, no accessory) and `auto: true`. Above Trainee it is refused (`termination-required`); the difficulty is the world's, so replay decides the same way.
- **What the outcome depends on** (D8): the strip hole against the conductor's area (nicks), the strip length against the terminal's specification, the accessory and die against the conductor, the clamp tool and its torque setting (a torque driver's stated accuracy, or a plain screwdriver's seeded spread around the specified torque). Two things are **not** stored, because they follow from the world and change after the landing: how many conductors share the terminal (counted by the compiler) and whether an aluminium conductor sits on a terminal not rated for it (catalogue data).
- **Methods are ids from a registry in `@controls/catalog`** (`screw`, `springCage`, `backStab`, `twistOn` in P3), like `MODEL_KINDS`: a new method (a lever nut) is code and catalogue data, not a schema change. Changing what an existing method means is an engine change.
- **`resolveTermination(args, terminalSpec, conductor, tools, rng)`** lives in `world-model/src/lib/termination/` (pure, `+ − × ÷` and `Math.sqrt` only, under the D6 lint), owned by `sim-engine-engineer` with F3.3 part 1. `world-model` can't import `sim-core`, and the command must resolve the outcome synchronously.

### `CableV3` and `nextCableId`

```ts
interface CableV3 {
  id: CableId;
  ref: CatalogRef; // a cable assembly (catalogue v2): 14/2 NM-B with ground, …
  a: CableEndV3 | null; // null: a free end (into a stand-in supply, or not yet entered)
  b: CableEndV3 | null;
  route: WaypointV3[]; // from end a to end b
  lengthMm: Int; // cut length, 1..1 000 000; every conductor's lengthMm equals it
  tailsMm: { a: Int; b: Int }; // cable left past each end's entry, 0..2000
  jacketStripMm: { a: Int; b: Int }; // jacket removed at each end, 0..tailsMm[end]
  label: LabelText | null;
  extensions: Extensions;
}
interface CableEndV3 {
  entity: EntityId; // an enclosure
  entry: EntryId; // one of its catalogue entries (TerminalId's grammar); open, with room
}
```

- **A cable owns its conductors.** `cable.add` creates the cable and one `ConnectionV3` per assembly conductor (`cable: { id, conductor: i }`, `ref` the assembly's conductor entry, `colour` the assembly's, both ends null, `route` null, `lengthMm` the cable's). A cable conductor is never deleted or rerouted on its own (`in-cable`); `cable.delete` removes all of them.
- **Tails are stored, not derived.** `tailsMm` is how much cable was left past each entry (into the box), and `jacketStripMm` how much of that has had its jacket removed. A cable conductor can land on a terminal only if the terminal is within reach of the entry (the straight distance from the entry point to the terminal's entry point is at most `tailsMm[end]`) and the jacket at that end has been stripped (`jacketStripMm[end] > 0`); otherwise `tail-too-short`. ADR 0017 may tighten the reach rule (bends, the jacket's minimum inside the clamp) before v0.4.0. The tail's shape inside the box is baked from (entry, terminal), never persisted.
- **Free ends are allowed.** The plan sketched each cable end as an enclosure entry; the demo's supply is a stand-in utility entity with no entries (D12), so a cable end may be `null` (the cable stops in the open, its free end at its route's first or last waypoint).
- **`nextCableId`** follows the entity-id rule (ADR 0007, ADR 0013) with its own counter, so cables never shift the ids a script's later `entity.place` or `wire.add` gets.

### The route shape

```ts
interface WaypointV3 {
  kind: 'free' | 'duct' | 'conduit' | 'staple' | 'bore';
  positionMm: PositionMm;
  entity: EntityId | null; // the duct, conduit stick or stud entity it is on
  fixture: FixtureId | null; // or the level fixture (a stud) it is on
  tool: CatalogRef | null; // a bore's drill or hole saw; null for every other kind
}
```

- **Integer millimetres, ordered from end `a` to end `b`,** at most `MAX_ROUTE_WAYPOINTS` (256) per route. A `free` waypoint has neither host; every other kind has exactly one of `entity` and `fixture`; a `bore` has a `tool` (a drill or hole saw, which sets the hole), the others none. The schema checks those shapes; which kinds a command accepts where is ADR 0017's (`bad-waypoint`).
- **The route's points are** end `a`'s terminal entry point (if `a` is landed), the waypoints, then end `b`'s (if landed). A null end lies at the first (or last) waypoint, so a route has at least as many waypoints as null ends and at least two points in all. For a cable, an end's point is its entry's position, and a free end lies at the first or last waypoint likewise.
- **Unlanding keeps the geometry:** `wire.unland` (and an `entity.delete` that unlands) puts a `free` waypoint at the terminal's entry point at that end of the route, so the conductor lies where it was. Landing never changes the route: the terminal point is simply added to the polyline, which must still fit the length.
- **Logged arguments carry explicit waypoints** (D5). Auto-route is expanded by the surface (the mouse, the console's `--route auto` sugar, `game.autoRoute`) through the shared domain router before `exec`, so a routing fix never changes what an old log replays to.
- **Never persisted:** the baked centreline, duct lanes (assigned at bake by sorted connection id), the live Verlet preview and tail shapes. They are pure functions of the world (ADR 0017), recomputed on load.
- **Geometry needs axis-aligned hosts.** A terminal's, entry's or mount's world position is the entity's position plus its catalogue offset rotated by the entity's orientation. With orientations in millidegrees that needs sine and cosine, which ECMAScript doesn't pin across engines, and ADR 0014 (`dmath`) is deferred. So in P3 every command that needs a terminal, entry or mount position refuses an entity whose yaw, pitch and roll aren't each a multiple of 90 000 (`not-axis-aligned`); quarter-turns rotate integer vectors exactly. Mouse placement snaps to quarter-turns already (`snap/placement.ts`); only a console `entity.rotate` can make another orientation.

### The length rule (D5, amended)

- **`lengthMm` is a logged argument, computed by the surface and checked by the command.** `routeDefaultLengthMm(points, slack, tails)` in `world-model/src/lib/routing/` (ADR 0017: the polyline, `Math.sqrt` per segment, plus a sourced slack allowance, rounded up to a millimetre) is what the mouse, the console's `--length auto` and `game.autoRoute` fill in. The command refuses a length shorter than the polyline (`too-short`: `lengthMm < ceil(Σ √(Δx² + Δy² + Δz²))`, each `√` of a safe integer) or above `MAX_CONDUCTOR_LENGTH_MM` (1 000 000, game-design: 1 km).
- **Why it moved from the command to the surface.** D5 computes the length inside `run`, so a later change to the slack allowance would change what an old log replays to (and every save with a wire would restart its log on load). As an argument, the meaning of a logged `wire.add` never changes, and a player or script can cut to a chosen length: the voltage-drop acceptance needs exactly 30 m of 14/2, which no "polyline plus slack" route gives without contortions. The command still checks the floor, which uses only `+ × √` on integers, the same in every engine.
- **The length is fixed once cut.** `wire.reroute` and `cable.reroute` keep `lengthMm` and refuse a route that doesn't fit (`too-short`); to change it, delete and add again (there is no re-cut command in P3).
- **The netlist reads `lengthMm` only.** Route geometry never reaches `sim-core`.

### Mounting and occupancy (D11)

- **`entity.place` gains `mountedOn`** (`{ entity, mount } | null`). Non-null is checked against the catalogue: the host exists and is axis-aligned, has that mount (`unknown-mount`), the device declares a matching mount type (`mount-mismatch`), the mount has room (`mount-full`, by the mount's capacity: one for a yoke, by overlap along a rail), and the device's position lies on the mount (`off-mount`, ADR 0017 / F3.5's integer check).
- **An enclosure is occupied** when a device is mounted on it, a cable end is in one of its entries, or a route waypoint names it. `entity.move`, `entity.rotate` and `entity.delete` refuse an occupied entity (`occupied`).
- **A mounted device can't be moved or rotated** (`mounted`), and **an entity with a landed conductor end can't be** either (`wired`): its terminals would leave its wires' routes and lengths behind. Unland, or delete and place again. (Deleting is allowed: below.)
- **`entity.delete`** removes every lead with an end on the entity (as in v2) and **unlands** every conductor end on it (an unlanded end, a `free` waypoint where the terminal was), in the same change; undo restores the entity, the leads and the conductors exactly.

### Commands

Every id and argument shape here is save format from the moment it is logged; the commands PR (plan PR 8) freezes each in `json-schema/command-args/<id>.args.schema.json`. Each command is undoable, restores ids and counters on undo, and **never reads sim-owned state** (a property test, as for `device.operate`).

```ts
type EndArg = { entity: EntityId; terminal: TerminalId; termination: TerminationArg } | null;
type ToolRef = CatalogRef; // a tool entry (content/tools, D10)

'wire.add':      { ref: CatalogRef; a: EndArg; b: EndArg; route: WaypointV3[]; lengthMm: Int; colour: ConductorColourV3; tool: ToolRef }        // tool: cutter
'wire.delete':   { id: ConnectionId }
'wire.reroute':  { id: ConnectionId; route: WaypointV3[] }
'wire.land':     { id: ConnectionId; end: 'a' | 'b'; terminal: { entity: EntityId; terminal: TerminalId }; termination: TerminationArg }
'wire.unland':   { id: ConnectionId; end: 'a' | 'b' }
'wire.label':    { id: ConnectionId; text: LabelText | null; tool: ToolRef }                                                         // labelMaker
'wire.pull':     { route: WaypointV3[]; lengthMm: Int; conductors: { ref: CatalogRef; colour: ConductorColourV3 }[]; tool: ToolRef } // fishTape; 1..16
'cable.add':     { ref: CatalogRef; a: CableEndV3 | null; b: CableEndV3 | null; route: WaypointV3[]; lengthMm: Int; tailsMm: { a: Int; b: Int }; tool: ToolRef } // cutter
'cable.strip':   { id: CableId; end: 'a' | 'b'; jacketMm: Int; tool: ToolRef }                                                       // stripper
'cable.delete':  { id: CableId }
'cable.reroute': { id: CableId; route: WaypointV3[] }
'cable.label':   { id: CableId; text: LabelText | null; tool: ToolRef }                                                              // labelMaker
'enclosure.openEntry': { id: EntityId; entry: EntryId; tool: ToolRef }                         // knockoutPunch | screwdriver | drill | holeSaw, by entry type
'entity.place':  { ref: CatalogRef; positionMm: PositionMm; orientationMdeg: OrientationMdeg; mountedOn: { entity: EntityId; mount: MountId } | null } // mountedOn defaults to null
'entity.label':  { id: EntityId; text: LabelText | null; tool: ToolRef }                                                             // labelMaker
// unchanged ids and shapes: entity.move, entity.rotate, entity.delete (new refusals), lead.connect, lead.disconnect (byte-unchanged)
```

- **Ids:** `wire.add` takes `nextConnectionId`; `wire.pull` takes one per conductor, in array order; `cable.add` takes `nextCableId` and then one connection id per assembly conductor, in assembly order. Undoing restores both counters; undoing a delete reinserts the same ids and data. As for entities, **only `edit.undo` and `edit.redo` may bring back a connection or cable id below its counter** (a property test; the engine's tombstones rely on it, ADR 0013).
- **`wire.pull`** is how conductors get into conduit: a route containing a `conduit` waypoint is refused by `wire.add` and `cable.add` (`needs-pull`) and accepted only here, which the fish-tape minigame logs on success (D10). It creates the conductors with both ends free at the run's ends. The plan's `{conduit, conductors, tool}` named the conduit; the route names it (its `conduit` waypoints), which is what the world stores, so the argument is the route.
- **Labels are their own commands** (`wire.label`, `cable.label`, `entity.label`), each taking the label maker, so `wire.add` and `cable.add` don't carry a label without the tool that prints it (D10: every tool-mediated command checks its tool). `text: null` removes a label.
- **`wire.add` and `cable.add` take a cutter** (cutting to length is a tool step). `cable.strip` sets `jacketStripMm[end]` and can only strip more (`cannot-unstrip`), up to the tail (`strip-too-long`).
- **`lead.connect` and `lead.disconnect` keep their ids and argument schemas byte for byte** (D2). `lead.connect` now builds a lead-shaped `ConnectionV3` with the lead kind's initial bags; `lead.disconnect` refuses a conductor (`not-a-lead`), and the `wire.*` commands refuse a lead (`not-a-wire`).
- **Not commands:** `wire.info <id>` is a read-only console query (D16), never logged. Custom enclosure entries drilled with a hole saw (F3.4 part 2) are not in v3; if F3.4 part 2 needs them, it amends this ADR before v0.4.0 (they would be a typed list on the enclosure, not bag keys).

#### Refusal codes

| Code                                                                    | When                                                                                                                                                                 |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not-found`                                                             | No entity, connection or cable with that id                                                                                                                          |
| `not-a-conductor` · `not-a-cable` · `not-an-enclosure` · `unknown-tool` | The `ref` isn't a conductor entry, a cable assembly, an enclosure, or a tool in the catalogue                                                                        |
| `not-a-wire` · `not-a-lead`                                             | A `wire.*` command on a lead; `lead.disconnect` on a conductor                                                                                                       |
| `in-cable`                                                              | `wire.delete` or `wire.reroute` on a cable conductor                                                                                                                 |
| `wrong-tool` · `unknown-hole` · `unknown-die`                           | A tool of a kind the step doesn't accept; a gauge hole or die the tool doesn't have                                                                                  |
| `no-terminals` · `unknown-terminal` · `same-terminal`                   | As `lead.connect` (ADR 0013)                                                                                                                                         |
| `already-landed` · `not-landed`                                         | `wire.land` on a landed end; `wire.unland` on a free one                                                                                                             |
| `terminal-full`                                                         | The terminal already holds its physical maximum of conductors (catalogue `maxConductors`; above `ratedConductors` is allowed and makes a worse termination, D8)      |
| `gauge-out-of-range`                                                    | The conductor's area is outside the terminal's accepted range                                                                                                        |
| `wrong-method` · `wrong-accessory`                                      | A method the terminal doesn't offer; an accessory that doesn't fit the conductor or the method                                                                       |
| `combination-out-of-range`                                              | A wire-nut splice outside its rated conductor combination                                                                                                            |
| `termination-required`                                                  | `'auto'` above Trainee                                                                                                                                               |
| `too-short` · `tail-too-short`                                          | The length doesn't cover the route (or the new route); a cable conductor's terminal is out of the tail's reach, or the jacket isn't stripped                         |
| `route-collides` · `bad-waypoint` · `needs-pull`                        | A segment through a device body (straight segments until F3.2 part 1); a waypoint whose host is missing or of the wrong kind; a conduit waypoint outside `wire.pull` |
| `not-axis-aligned`                                                      | A terminal, entry or mount on an entity that isn't at quarter-turns                                                                                                  |
| `entry-closed` · `entry-full` · `unknown-entry` · `already-open`        | A cable through an unopened entry; one with no room (catalogue `maxCables`); an entry the enclosure doesn't have; `openEntry` on an open entry                       |
| `unknown-mount` · `mount-mismatch` · `mount-full` · `off-mount`         | As in [Mounting and occupancy](#mounting-and-occupancy-d11)                                                                                                          |
| `occupied` · `mounted` · `wired`                                        | As in [Mounting and occupancy](#mounting-and-occupancy-d11)                                                                                                          |
| `cannot-unstrip` · `strip-too-long`                                     | `cable.strip` to less than already stripped, or past the tail                                                                                                        |
| `ids-exhausted`                                                         | A counter would pass `Number.MAX_SAFE_INTEGER`                                                                                                                       |

Refusals aren't logged, so their codes aren't save format; they are API for scripts and the UI, and tests pin them.

### What the netlist compiler reads (D4)

**One branch per netlisted connection** (ADR 0011 §7 kept). For each connection, in id order:

1. **Netlisted only if** its ref resolves to a connection kind with a model, **both ends are non-null**, both name netlisted entities and existing terminals, and neither end's sim state is `intermittentOpen`. Otherwise it is absent, with a reason: the existing ones, plus `unlanded` (a null end) and `open-end`. Absent connections are in no node, branch or hash.
2. **The element** is one resistor, `a` to `b`: R = R_conductor(T, L, A, stranding) + R_contact(a) + R_contact(b), plus an arcing resistance inside §4.5's 0.5–2 Ω band on an end whose state is `arcing`. `ConnectionNetlistModel.element(params)` becomes `element(input)`, with `input` holding: the entry's params; `lengthMm` (a conductor) or the entry's own length (a lead); per end, the `TerminationV3` (or null for a clip), the terminal's catalogue termination spec, and **the number of conductors landed on that terminal** (counted over the world, so landing a second conductor changes the first one's value); and the live sim state. It gains `simTopologyKeys` (`endAState`, `endBState`), as device models have.
3. **It never reads** `route`, `colour`, `label`, `cable`, waypoints or positions. Conductors in one cable are electrically and (in P3) thermally independent (D7).
4. **End voltages** are derived after the solve as V_terminal ∓ I · R_contact (exact for series elements) and published in the connection record (protocol 6); they add no unknowns.

So no new element kind or stamp is needed, the oracle corpus is unchanged, and a lead's value is the same as in v2.

### Connection state bags and their owners

Both bags have ADR 0013's generic shape (`DeviceStateBag`), checked per kind at load against `MODEL_KINDS`, which now declares keys for connection kinds too (and exports `json-schema/connection-state.<kind>.schema.json`).

- **`state` (commanded):** written only by commands. **Empty for `lead` and `conductor`.** It is kept so a later connection kind with a commanded setting needs no shape change. Termination, route, length, colour and label are typed fields, also commanded.
- **`sim` (sim-owned):** written only by `materialiseWorld`, inert in the live world, never read by a command. Owner `sim-engine-engineer`; `save-format-guardian` reviews every key. **`lead` and `conductor` share one key set** (D2: leads join the thermal model):

| Key                                        | Type                                                             | Initial | Meaning                                                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `conductorTempK`                           | number or null                                                   | `null`  | The conductor's lumped temperature; null until first simulated (the engine starts it at ambient)                             |
| `endATempK`, `endBTempK`                   | number or null                                                   | `null`  | The end's termination hot spot; null while the end has no termination node (unlanded, or not yet simulated)                  |
| `endADegradationOhm`, `endBDegradationOhm` | number ≥ 0                                                       | `0`     | Irreversible growth of the end's contact resistance since its termination was made (D8: monotone, never reversed by cooling) |
| `endAState`, `endBState`                   | `'ok' \| 'intermittentClosed' \| 'intermittentOpen' \| 'arcing'` | `'ok'`  | The end's contact state; `intermittentOpen` takes the connection out of the netlist (a topology key)                         |
| `insulationDamaged`                        | boolean                                                          | `false` | Sticky: set once the conductor passed its insulation's damage temperature (an event and a flag only in P3)                   |

- **The key set is provisional until v0.4.0** (like v3 itself) and is finalised by ADR 0018 (F3.3 part 1, F3.6 parts 1–2), with fixtures updated in the same PR. Adding a key after v0.4.0 is a `schemaVersion` bump (ADR 0013's rule).
- **The thermal bank covers every connection of a known connection kind, netlisted or not.** An unlanded conductor carries no current and relaxes towards ambient, and its other end keeps its degradation. So `materialiseWorld` overwrites the `sim` bag of every connection whose kind the catalogue knows, not only the netlisted ones (the entity rule, "only those the engine netlisted", would save an unlanded conductor's bag as it was at the last load).
- **A new termination resets its end.** When an end's `termination.seq` changes (a re-land), the engine starts that end at the conductor's temperature with no degradation and state `ok`. The command can't do it (it never writes `sim`); the engine sees the new `seq`.
- **Nothing about randomness is persisted** beyond these keys (below): an intermittent end's open and closed periods are a pure function of the seed, the end's stream key and the tick.

### PRNG stream keys

`deriveStream(seed, key)` and its golden vectors are unchanged (ADR 0007). New key functions in `world-model/src/lib/prng.ts`, next to `commandStreamKey(seq)` = `command:<seq>` and `entityStreamKey(id)` = `entity:<id>`:

```ts
connectionStreamKey(id: ConnectionId): string  // `connection:${id}`
cableStreamKey(id: CableId): string            // `cable:${id}`
terminationStreamKey(id: ConnectionId, end: 'a' | 'b', termination: TerminationV3 | null): string
  // `${connectionStreamKey(id)}:${end}:${termination === null ? 'clip' : termination.seq}`
```

- **Command-time draws** (a screwdriver's torque spread, nicks from a wrong hole) use `commandStreamKey(seq)`, and their outcome is stored in the `TerminationV3`. The engine never draws them again.
- **Engine draws for an end** (intermittent timing, arcing onset) use `terminationStreamKey`: keyed by the termination's `seq`, a re-made termination is a new contact with a new sequence, and the same one is identical across runs, replays, transports and a save and load. ADR 0018 must make each draw a pure function of (seed, key, tick), derived fresh like the breaker's pickup or counter-based (a `mix32` of the stream's first output and the tick bucket), with no persisted generator state and no string built per tick.
- **`connectionStreamKey`** is for per-conductor randomness that lives as long as the conductor (manufacturing tolerance, if a later model wants it); **`cableStreamKey`** is reserved: no P3 consumer is planned, and defining it now means a later one can't collide with another prefix.
- The prefixes `command:`, `entity:`, `connection:` and `cable:` are distinct, so keys can't collide across kinds. The key functions are frozen with v3 at v0.4.0, with golden strings in `prng.spec.ts`.

### Schema invariants

Zod refinements on `WorldV3` (not in the JSON Schema), each with a refused fixture:

1. Fixtures, entities, connections and cables are each sorted by strictly ascending id; entity, connection and cable ids are below their counters.
2. `mountedOn.entity` exists, isn't the entity itself, and mounting has no cycle.
3. A non-null connection end names an existing entity; two landed ends aren't the same terminal.
4. **Shape consistency:** `lengthMm === null` exactly when the connection is lead-shaped (`route`, `cable`, `colour` and `label` null, both ends non-null with null terminations); otherwise `colour` is non-null, exactly one of `route` and `cable` is non-null, and every non-null end has a termination.
5. A conductor's `cable.id` names an existing cable; per cable, its conductors' indices are exactly `0 … n − 1` with n ≥ 1, and each has the cable's `lengthMm`.
6. Routes: at most 256 waypoints; host and tool fields as in [The route shape](#the-route-shape); hosts exist; enough waypoints for the null ends and at least two points.
7. Cables: non-null ends name existing entities and aren't the same entry; `jacketStripMm[e] ≤ tailsMm[e]`; `tailsMm.a + tailsMm.b ≤ lengthMm`.
8. The solution record as in v2.

**Moved to the load check** (it needs the catalogue): the plan's "`lengthMm` ≥ the straight-line distance between landed ends" (compared as integers, `lengthMm² ≥ Δx² + Δy² + Δz²`, exact since coordinates are at most 10 km), and "`mountedOn` names an existing enclosure mount". `checkWorldDevices` becomes `checkWorldReferences` and still fails as `invalid-device-state` (no new `LoadGameError` kind). It also checks: connection refs are connection kinds, lead-shaped exactly when the kind is `lead`; terminals and methods exist on the devices; cable refs are assemblies, with one conductor per assembly conductor whose ref matches; cable ends are open entries of enclosures; mounts exist and fit; landed hosts are axis-aligned; colour ids, tool refs, holes and dies exist; each bag has exactly its kind's keys. A ref the catalogue doesn't know is still left alone (its connections and cables round-trip untouched and aren't netlisted).

### Hash scope

- **`world.hash`** is unchanged in definition (SHA-256 of the canonical JSON of the parsed world, ADR 0007), so it now covers cables, `nextCableId`, routes, lengths, colours, labels, terminations, `mountedOn`, entity labels and every connection's bags. Every world gains `"cables":[]`, `"nextCableId":1` and per-entity `"label":null,"mountedOn":null`, so **every pinned world hash is re-pinned once**, at the world v3 PR, listed old → new in the CHANGELOG (the plan's list).
- **`topologyHash`** keeps its encoding (`CNT`, version byte 1): a conductor is a branch like a lead, named `c<id>`, with model kind `conductor`. Lengths, terminations, temperatures and degradation are values and stay out; an `intermittentOpen` end changes it (the branch goes). Unlanded connections aren't in it. `hash.spec.ts` gains a `conductor` golden (F3.1 part 1).
- **`snapshotHash`** gains the connection records with protocol 6 (F3.6 part 3).
- **Not in any of them:** the baked centreline (its own cross-runtime golden, ADR 0017), lanes, the live preview, display state.

### The v2 → v3 migration

Pure and total (`v3/from-v2.ts`, kept forever; the tests deep-freeze the input and run it twice). It doesn't read the catalogue.

- **World:** `schemaVersion: 3`, `nextCableId: 1`, `cables: []`. Each entity gains `mountedOn: null` and `label: null`. Each connection (every v2 connection is a lead, or a ref the catalogue doesn't know) becomes lead-shaped: `a` and `b` gain `termination: null`; `cable`, `route`, `lengthMm`, `colour` and `label` are `null`; `state: {}`; `sim` is **the lead kind's initial bag** (the eight keys above at their initial values), held as a frozen constant in `from-v2.ts`. (The plan said "empty bags"; the lead kind gains keys in v3, so an empty bag would fail the load check. A ref the catalogue doesn't know keeps whatever bag it got, untouched, as ever.)
- **Replay log:** `initialWorld` migrated as above; every entry whose `id` is `entity.place` and whose `args` has no own `mountedOn` key gains `mountedOn: null` (any other entry, including `lead.connect` and `lead.disconnect`, is copied verbatim). The rule never throws on an odd entry: one that doesn't fit is copied and fails at replay, as before.
- **Manifest:** `schemaVersion: 3`; `catalogVersion` and `simEngineVersion` kept as saved.
- Every v1 and v2 fixture migrates and validates as v3; P1 saves (`0`/`0`) still verify by replay (their `entity.place` entries gain `mountedOn: null`, which is what a v3 bus logs).

### `catalogVersion` 2

Catalogue v2 (ADR 0016) lands before world v3. The requirements this ADR puts on it:

- **Every `(id, version)` of catalogue 1 stays resolvable** in catalogue 2: an entry that only gains termination data keeps its version (D3), and one whose electrical values change gets a new version beside the old.
- **The `lead` kind gains the sim keys above**; that is a key change to an existing kind, which is why it rides on this `schemaVersion` bump.
- **0.3.0 saves** (`catalogVersion` 1, engine 6) load as `engine-changed`, never refused: migrated to v3, the solution record dropped, solved again at the save's tick, log restarted, leads' new keys initialised by the engine from their nulls. A fixture test proves it (`fixtures/v2/ctrl/*-engine-6.ctrl`, never regenerated). The `sources.spec.ts` rule ("`sim-step-engine-${SIM_ENGINE_VERSION}.ctrl` loads as `continued`") can't hold for a catalogue-1 file once the build is catalogue 2, so engine-numbered fixtures written from catalogue 2 on are named `*-engine-N-catalog-C.ctrl` and the rule checks the current pair.
- Saves are still references (ADR 0004): a conductor, cable, enclosure or tool is a `CatalogRef`, never inlined.

### Protocol 6 connection records (for the ADR 0011 amendment in F3.6 part 3)

Listed here so the persisted keys and the published fields are designed together; the byte layout, the validity rule and the sign-offs belong to the amendment (`sim-engine-engineer` with `renderer-engineer` and `angular-ui-engineer`).

- **One record per connection in the thermal bank** (every connection of a known connection kind, netlisted or not), in connection-id order, laid out by its kind's `ConnectionOutputSchema` (the device schema's rules: `f64` first, then 4-byte, then `u8`, padded to 8).
- **The descriptor gains** `connections: { connection: ConnectionId; kind: string; recordOffset: number; branch: number }[]` (`branch` −1 when not netlisted). Readers join by (id, kind), as for devices.
- **Fields** (draft): `currentA`, `conductorDropV`, `endADropV`, `endBDropV` (solved: a reading only when `status` is `solved`); `conductorResistanceOhm` (at its temperature), `endAContactOhm`, `endBContactOhm`, `conductorTempK`, `endATempK`, `endBTempK` (own state, always written); `u8 endAState`, `u8 endBState` [`none`, `ok`, `intermittent`, `arcing`] (`none` for a free end; open and closed intermittent both publish `intermittent`); `u8 insulationDamaged` [`no`, `yes`]; `u8 status` (`RECORD_STATUS_VALUES`). About 88 bytes. Every value finite: a free end's temperature and contact fields are written 0 with state `none`.
- The overlays recolour the conductor meshes from these records and their branches; their own lead segments stay for leads only (D15).

### Sizes

A conductor with ten waypoints is about 1 KB of JSON; 2 000 conductors with their bags are about 3 MB, inside `world.json`'s 16 MiB cap, and a `wire.add` log entry is about 1 KB, so `replay.log`'s 32 MiB holds about 30 000 of them. No cap changes.

## Deviations from the plan

Decided here under the instruction to proceed autonomously; each is also an open question below.

1. **`lengthMm` is a logged argument** checked against the polyline, not computed in `run` (D5): replay stability across routing fixes, and cut-to-length.
2. **Tools are inside `TerminationArgs`** (strip, crimp, clamp), and `wire.land` has no top-level `tool`.
3. **Labels have their own tool commands**; `wire.add` and `cable.add` take no label, and gain a cutter. `entity.label` and `cable.label` are added.
4. **`wire.pull` takes the route** (with its `conduit` waypoints) instead of a conduit id.
5. **No re-cut:** reroutes keep the length.
6. **`ConnectionV3.cable` is `{ id, conductor }`; `CableV3` gains `tailsMm`; cable ends may be null.**
7. **Migrated leads get the lead kind's initial `sim` bag**, not an empty one.
8. **Two invariants move from the schema to the load check** (length against the chord; the mount exists).
9. **New refusals:** `mounted`, `wired`, `not-axis-aligned`; terminals have a rated and a physical conductor count.
10. **Custom enclosure entries are not in v3** unless F3.4 part 2 amends this ADR before v0.4.0.

## Consequences

- `save-format`: `v3/{world,manifest,replay-log,from-v2}.ts`, the chain extended, `CURRENT_SCHEMA_VERSION` 3, `LabelText`, `ColourId`, `TerminationMethodId` and `MountId`/`EntryId` primitives (new names; v2's primitives untouched), `*.v3.schema.json`, fixtures under `fixtures/v3/{world,manifest,replay-log,ctrl}` (the plan's list) and `fixtures/v3/refused/` per invariant; a fast-check arbitrary for v3 worlds (routes, cables, terminations) with the JSON and container round-trip properties.
- `catalog`: connection kinds declare keys; `connection-state.<kind>.schema.json`; the termination-method registry; the colour table; requirements above for ADR 0016.
- `world-model`: the commands, `checkWorldReferences`, `resolveTermination`, `routing/` (`routeDefaultLengthMm`, the polyline floor), the new stream keys, properties (undo restores ids and counters; only undo and redo re-add old ids; no command reads `sim`; deleting an entity never leaves a dangling end).
- `sim-core` and `sim-protocol`: `ConnectionNetlistModel` input and `simTopologyKeys`, the absent reasons `unlanded` and `open-end`, materialising every known connection's `sim` bag, tombstones for connection ids.
- `scripting-api`: `game.autoRoute`, the length sugar, the engine-numbered fixture naming.
- Palette and console (`angular-ui-engineer`): the new argument shapes need nullable objects, arrays of objects and the `'auto' | object` union (see the questions), which the "union of scalars only" rule (commands caveats) doesn't allow today.
- Docs (in the implementing PRs): save-format caveats (v3), commands caveats (stream keys, new refusals), `world-and-saves.md`, the new `wiring.md`, `docs/history.md` (`schemaVersion` 3), the glossary.

## Alternatives considered

- **A separate `wires` array** (D1 rejected): two id spaces and two compiler inputs, and leads would still need the same fields.
- **Three branches per wire with internal end nodes** (D4 rejected): about twice the unknowns for no new physics; the series-element rule gives the end voltages exactly.
- **Storing contact resistance in the termination:** the command would need `sim-core`'s model, and a model fix would leave old saves' numbers stale; storing the physical outcome avoids both.
- **Computing `lengthMm` in `run`** (the plan's D5): see the length rule.
- **A typed `sim` object on connections instead of bags:** precise, but ADR 0018 isn't written and later connection kinds (P10 network cables) will want other keys; bags keep ADR 0013's one mechanism.
- **Persisting intermittent generator state:** a pure function of (seed, key, tick) needs nothing persisted.
- **A closed colour enum:** every new insulation colour after v0.4.0 would be a `schemaVersion` bump.
- **Deterministic trigonometry now (ADR 0014)** instead of quarter-turn hosts: real panels are axis-aligned; `dmath` stays deferred until a model or a free-angle mount needs it.
- **Transform-inheriting mounts** (D11 rejected for P3): moving a box would move its devices, but every host change would rewrite descendants and their routes.

## Open questions for reviewers

### `sim-engine-engineer`

1. Is the eight-key `sim` set right (`conductorTempK`, end temperatures, `end*DegradationOhm`, `end*State`, `insulationDamaged`)? Is degradation better as Ω or as a multiplier of the as-made contact resistance? Should the intermittent open and closed states be persisted (proposed, as one four-valued key per end) or derived from the tick alone?
2. Should an `intermittentOpen` end remove the branch (proposed: a topology change through `simTopologyKeys`, absent reason `open-end`), or stamp a very large resistance (no topology event, but a conditioning risk)?
3. Is a bank over every known connection, netlisted or not, affordable in `tick-wired-plant` (unlanded conductors only relax towards ambient)?
4. Is the `TerminationV3` outcome enough for the Holm model: achieved torque, nicked fraction, strip length, crimp quality, with the conductor count and aluminium rating derived? Does it need a clamp area as well?
5. The terminal's conductor count makes one connection's value depend on others' ends: confirm the incremental compiler can key its cache on it.
6. `resolveTermination` in `world-model/src/lib/termination/` (owned by you, under the D6 lint): agreed?
7. The engine resets an end when `termination.seq` changes: agreed, including on undo and redo?

### `renderer-engineer`

1. The quarter-turn rule (`not-axis-aligned`) for terminals, entries and mounts until `dmath`: acceptable for F3.2 and F3.5?
2. The waypoint shape (`entity` or `fixture` host, a bore's `tool`), the endpoint rule (a free end lies on the first or last waypoint; unlanding adds a `free` waypoint), and cable tails baked from (entry, terminal) without persisted waypoints: enough for the bake and the pickers?
3. `lengthMm` from the surface through `routeDefaultLengthMm` (yours, in `routing/`), with the command checking only the polyline floor: agreed? Is 256 waypoints enough for a long stapled run?
4. `mounted` and `wired` stop moving a mounted or wired device, so sliding a breaker along a rail is delete and place: acceptable for P3, or do you want an `entity.remount`?
5. The draft connection-record fields: enough for the heat overlay and the recoloured conductor instances?

### `angular-ui-engineer`

1. The palette's arg-form allows only scalar unions today. The new shapes need nullable objects (`EndArg`, `mountedOn`, `accessory`, cable ends), arrays of objects (`route`, `wire.pull`'s `conductors`) and `'auto' | TerminationArgs`. Do you extend the form (a "none" toggle, a list editor, a two-way choice), or give `route` a single text field in the console's route syntax? Either way the every-command spec must pass in PR 8.
2. One `wire.land` per end, logged after both the strip-and-ferrule prompt and the torque prompt (D9's "separate tool action" as a UI step, not a command): agreed?
3. Console sugar: `--route auto`, `--length auto`, terminals as `3:L1`, and a route syntax for explicit waypoints. Which of these are yours and which the scripting-api's?
4. Labels by `wire.label`, `cable.label` and `entity.label` with the label maker, never as a field of `wire.add`: does that fit the tool-belt flow?
5. The fish tape logs one `wire.pull` with the route and the conductors on success only: confirm.

### `content-designer`

1. Terminal termination specs need `methods[]` (plural: a receptacle offers screw and back-stab on one terminal in P4), `ratedConductors` and `maxConductors` (physical), the accepted area range, strip length, torque with its source, and an entry point and exit direction in integer mm: agreed for ADR 0016?
2. Enclosure entries: at most 32 per entry, in a frozen order (the `openEntries` bit set), each with an id, a type (knockout or clamp, which decides the opening tools), a trade size and `maxCables`; mounts with an id, a type, a capacity and an extent. Devices declare which mount types they fit.
3. Cable assemblies: the order of `conductors[]` is save format (`cable.conductor` indexes it); colours are `ColourId`s from one colour table. Where should the table live (`content/tables/colours.v1.json`?) and how does it relate to `RegionProfile.conductorColours`?
4. Tool entries: gauge holes and dies need stable ids (`HoleId`, `DieId`) as well as their sizes. Does a stripper with cutting jaws count as a cutter for `wire.add`? Proposed: the tool entry lists the step kinds it can do, and the command checks the step kind, not only the tool kind.
5. Every catalogue-1 `(id, version)` stays resolvable in catalogue 2, and the `lead` kind gains the sim keys above: confirm both for ADR 0016.
