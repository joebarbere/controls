# ADR 0015: World document v3 and the wire contract

**Status:** Accepted (2026-11-11). P3 kickoff step 3, the agent-team contract. Drafted by `save-format-guardian` (lead). No v3 code landed before this. `schemaVersion` 3 stays provisional until v0.4.0 ships (fixtures updated in the same PR as any change), then it is frozen.
**Amended by:** [ADR 0016](0016-catalogue-format-v2.md) (deviations 3, 4, 8: the `fits.<type>` coverage path; mount `axis` + `facing` and type occupancy replace `yoke`; clamp geometry and twist-on bounds arrive with ADR 0018); [ADR 0018](0018-conductor-and-termination-physics.md) (the clamp-geometry list, the arcing band, the intermittent phase rule and its onset, the end-reset state, the engine draws).
**Review:** `sim-engine-engineer`, `renderer-engineer`, `angular-ui-engineer` and `content-designer` each approved with changes; every required change is applied below (see [Review](#review)). The main agent recommended a world termination counter, which this ADR adopts ([Termination identity](#termination-identity-nextterminationid)).
**Date:** 2026-11-11 (Phase 3)
**Sources:** [phase 3 plan](../../plans/phase-3-wiring.md) kickoff step 3 and decisions D1–D5, D8–D11, D15, D19, the world v3 and command checklists, F3.1–F3.6; [ADR 0004](0004-save-format.md) (save format rules); [ADR 0007](0007-world-document-v1.md) (ids, hash, PRNG, replay log); [ADR 0008](0008-console-and-scripts.md) (console grammar); [ADR 0010](0010-wire-routing-spike.md) (what P3 must build and avoid); [ADR 0011](0011-sim-worker-contract.md) §1, §5.4, §7, §9.6, §12 (ownership, records, one branch per connection, the solution record); [ADR 0013](0013-world-document-v2.md) (v2, bags, `MODEL_KINDS`, the load check, the materialisation scope); [save-format](../caveats/save-format.md) and [commands](../caveats/commands.md) caveats

## Context

World v2 (ADR 0013) persists test leads: two-ended connections with no geometry, no state and a resistance fixed by their catalogue entry. P3 makes the player wire for real. Every new idea (a conductor with a route and a length, a cable that owns several conductors, a termination with a quality, an enclosure with mounts and knockouts, a device mounted in it, a label) is something a save holds and a replay must reproduce. Five teams build against it at the same time:

- `sim-engine-engineer` compiles conductors into the netlist and heats them (F3.1, F3.3 part 1, F3.6);
- `renderer-engineer` routes and bakes them, draws them and picks them (F3.2, F3.5);
- `angular-ui-engineer` builds the palette and console forms, the termination prompts, the tool belt and the fish tape (F3.3 part 2, F3.4);
- `content-designer` writes the conductor, cable, enclosure, accessory and tool entries (catalogue v2, ADR 0016);
- the main agent writes the `wire.*`, `cable.*`, `enclosure.*` and `entity.*` commands.

D1 fixed the outline (one `connections` array for leads and wires, nullable ends, a `cables` array, `mountedOn`, one `schemaVersion` 3). This ADR fixes the shapes, the commands and their refusals, what the compiler reads, the stream keys, the hash scope and the migration, so each team can build against fixtures before the others land. Where the plan was ambiguous or, on inspection, wrong, the choice is made here and listed in [Deviations from the plan](#deviations-from-the-plan); the plan is corrected in the same PR.

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
type TerminationId = Int; // >= 1, below nextTerminationId
type PositionMm = { x: Int; y: Int; z: Int }; // PositionMmV1: integer mm, |c| <= 10 km
type LabelText = string; // printable ASCII 0x20-0x7E, 1..32 chars, no leading or trailing space
type ColourId = string; // /^[a-z][a-zA-Z0-9]{0,31}$/, a row of the catalogue colour table
type TerminationMethodId = string; // /^[a-z][a-zA-Z0-9]{0,31}$/, a method in @controls/catalog's registry
type MountId = string; // TerminalId's grammar, unique within the catalogue entry
type EntryId = string; // TerminalId's grammar, unique within the catalogue entry
type HoleId = string; // TerminalId's grammar, unique within the tool entry
type DieId = string; // TerminalId's grammar, unique within the tool entry
```

### `WorldV3`

```ts
interface WorldV3 {
  schemaVersion: 3;
  seed: Int; // u32
  tick: Int;
  nextEntityId: Int;
  nextConnectionId: Int;
  nextCableId: Int; // new
  nextTerminationId: Int; // new
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

Every counter follows the entity-id rule (ADR 0007, ADR 0013) with its own counter, so wiring never shifts the ids a script's later `entity.place` gets: a new id is exactly the counter; undo restores the counter; deleting never decrements it; and **only `edit.undo` and `edit.redo` may bring back an id below its counter** (a property test; the engine's tombstones and the termination rule below rely on it).

### `EntityV3`: `mountedOn` and `label`

```ts
interface EntityV3 {
  id: EntityId;
  ref: CatalogRef;
  transform: TransformV1;
  state: DeviceStateBag; // commanded (ADR 0013)
  sim: DeviceStateBag; // sim-owned (ADR 0013)
  mountedOn: { entity: EntityId; mount: MountId } | null;
  label: LabelText | null;
  extensions: Extensions;
}
```

- **`mountedOn`** records which enclosure (or enclosure part: a DIN-rail panel, a box's device yoke) holds the device, and on which of its catalogue mounts. It is a relation, not a transform parent: the device's `transform` stays absolute and nothing inherits it (D11). P4's box fill counts from it. A fixture (level geometry, such as the workshop's own DIN rail) is never a host in P3: a device placed on one has `mountedOn: null`.
- **`label`** is the text of a printed label on the device (`TB1`, `CB3`), set with `entity.label`. Device, wire and cable labels share `LabelText`, which is printable ASCII so every label renders in the one bundled font and survives every encoder.
- **Enclosure knockouts are a commanded state key** (D11): an enclosure kind has the commanded key `openEntries`, an integer bit set over the catalogue entry's `entries[]` in their catalogue order (bit _i_ set means entry _i_ is open; initial 0, every entry starts closed). So an enclosure entry has at most 32 entries (`>>> 0` stays exact; a later enclosure with more is a new kind with a second key), the catalogue refuses more, and **the order of an enclosure entry's `entries[]` is save format**: changing it needs a new entry version. Each catalogue entry is `{ id, type, tradeSize, maxCables, internalClamp, positionMm, axis }`, where `type` comes from a catalogue registry (`knockout`, `pryout`, `clamp`, `drillSite` in P3, sourced) that names the tool capabilities that open it. Drill and hole-saw entries (F3.4 part 2) are `drillSite` entries declared in the catalogue, not a world list. A mount is `{ id, type, positionMm, axis, extentMm, yoke }`, and a device declares the mounts it fits, `mounts: { type, widthMm }[]`. Entry, mount and terminal ids are unique within a catalogue entry.

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
- **Colours are ids, not an enum.** They live in the catalogue colour table (`content/tables/colours.v<n>.json`), which is **append-only across catalogue versions**: an id, once shipped, is never removed or renamed (display values may change). A conductor entry lists the colours it is made in, and `wire.add` and `wire.pull` refuse others (`unavailable-colour`). `bare` is valid only on an uninsulated conductor entry, never on an insulated one. A cable conductor's colour equals its assembly's `conductors[i].colour` (load check). `RegionProfile.conductorColours` holds the region's rules over colour ids (P4's inspector) and is never part of the load check. A closed enum would have needed a `schemaVersion` bump for every new colour after v0.4.0.
- **`cable.conductor`** is the index in the cable assembly's `conductors[]` (catalogue v2): it says which role (ungrounded, grounded, EGC) and which assembly colour the conductor is, explicitly rather than by the rank of its id. The order of an assembly's `conductors[]` is save format.

### `TerminationV3` and `TerminationArgs`

A termination is **the outcome of the tool steps**, recorded when the end is landed (D8, D9): what was physically made, not what the player asked for, and not the contact resistance. The command resolves the arguments into an outcome, with any seeded spread drawn there and then from the termination's own streams; the engine computes contact resistance from the outcome (ADR 0018). So the save holds physical facts, a better contact model changes old saves' resistances only through `SIM_ENGINE_VERSION` (never their documents), and `world-model` never needs `sim-core`.

```ts
// What a surface sends (the logged argument).
type TerminationArgs = {
  method: TerminationMethodId; // one of the terminal's methods ('wrong-method')
  strip: { tool: CatalogRef; hole: HoleId; lengthMm: Int }; // a tool that can `strip`, one of its holes, 1..100 mm
  accessory: { ref: CatalogRef; tool: CatalogRef; die: DieId } | null; // a ferrule or lug (family `accessory`), crimped with a die
  clamp: { tool: CatalogRef | null; torqueNm: FiniteNumber | null }; // the driver and its torque setting, or null
};
type TerminationArg = 'auto' | TerminationArgs; // 'auto' only at Trainee (D9)

// What the world stores.
interface TerminationV3 {
  id: TerminationId; // from nextTerminationId: its identity and its streams (below)
  method: TerminationMethodId;
  auto: boolean; // made by 'auto' (the ideal outcome); never read by the engine
  stripLengthMm: Int; // as stripped, 0..1000
  nickedStrandFraction: FiniteNumber; // 0..1: the share of the conductor's area lost to the stripper
  torqueNm: FiniteNumber | null; // achieved clamp torque (>= 0); null for a method without one
  accessory: { ref: CatalogRef; crimpQuality: FiniteNumber } | null; // 0..1, 1 = the right die, fully closed
}
```

- **A terminal's termination spec is `methods: TerminalMethodSpec[]`** (catalogue v2), possibly empty: a clip-only terminal (P2's lamp, resistor lugs and fuse), on which `wire.land` is refused (`wrong-method`). Each is `{ method, ratedConductors, maxConductors, awgRange: { smallest, largest }, stranding: ('solid' | 'stranded' | 'strandedFerrule')[], stripLengthMm: { nominal, tolerance }, torqueNm: number | null, alRated, entryMm, exitAxis }`. `method` is unique within the terminal; `exitAxis` is one of ±x, ±y, ±z; `entryMm` is integer mm in the device frame. Gauge checks compare integer AWG designations through the catalogue gauge table (4/0 = −3), never floating-point areas. `terminal-full` and the conductor count given to the compiler count conductors landed **by the same method on the same terminal**; lead clips are never counted. `maxConductors` may have a game-design source.
- **`'auto'`** resolves to the terminal's **first** method at its `stripLengthMm.nominal` and `torqueNm`, with no nicks and no accessory, and `auto: true`. So **the order of a terminal's methods is save format** (a reorder needs a new entry version). Above Trainee `'auto'` is refused (`termination-required`); the difficulty is the world's, so replay decides the same way.
- **Tools travel inside the termination.** One landing uses up to three tools (a stripper, a crimper, a driver), so a single `tool` field couldn't check them. Each step names its tool, and the command checks the tool's capability for the step (below), its hole (`unknown-hole`) and its die (`unknown-die`). A `screw` method with `clamp.tool: null` is refused (`wrong-tool`).
- **Which command a surface logs.** A route completed between two terminals is one `wire.add` with both ends landed (each end's termination collected by the prompts before `exec`); `wire.land` lands a free end (a cable or pulled conductor, or a re-land after `wire.unland`). Either way one gesture is one command and one undo step: D9's "strip and ferrule fold into one action per end; torque is a separate tool action" is a sequence of prompts ending in one logged command, never two (a half-landed end would be a persisted state with no physical meaning). Apprentice preselection comes from `suggestTermination(terminalSpec, conductor, tools)` in `world-model/src/lib/termination/` (next to `resolveTermination`), so no surface encodes which hole, die or torque is right. At Realistic the UI shows no part of the stored outcome (D9); only the D16 debug readouts (`when: console.available`) do.
- **What the outcome depends on** (D8): the strip hole's AWG size and stranding against the conductor's (nicks; integer designations, not areas), the strip length against the method's specification, the accessory and die against the conductor, and the clamp tool and its torque setting (a torque driver's stated accuracy, or a plain screwdriver's seeded spread around the specified torque). Two things are **not** stored, because they follow from the world and change after the landing: how many conductors share the terminal by that method (counted by the compiler), and whether an aluminium conductor sits on a method not rated for it (catalogue data). For methods without a clamp torque (`springCage`, `backStab`, `twistOn` in P3) the quality inputs are the strip length, the nicks and the conductor combination; ADR 0018 states this abstraction. **The clamp geometry the contact model needs** (clamp type, clamp depth, the as-made contact resistance, the heat path and the hot-spot heat capacity; ADR 0018 §8) **is terminal catalogue data** (ADR 0016), never part of the outcome. **The engine never reads `auto`:** two terminations with equal physical fields behave identically.
- **Methods are ids from a registry in `@controls/catalog`** (`screw`, `springCage`, `backStab`, `twistOn` in P3), like `MODEL_KINDS`: a new method (a lever nut) is code and catalogue data, not a schema change. A twist-on rating is stored as count, AWG and total-size bounds paraphrased from public data, never a reproduced combination chart.
- **`resolveTermination(args, methodSpec, conductor, tools, streams)`** lives in `world-model/src/lib/termination/` (pure, `+ − × ÷` and `Math.sqrt` only, under the D6 lint), owned by `sim-engine-engineer` with F3.3 part 1. It is command semantics: golden vectors (arguments, seed, termination id → outcome, bit-exact) freeze it at v0.4.0. After that, changing an outcome is a save-format review and lands as a new method id or a versioned resolver, never as a silent edit. Each step draws from its own stream (below), so no outcome depends on how many draws another step made.

### Termination identity: `nextTerminationId`

**Decision: a termination's identity is a world-allocated id, `TerminationV3.id`, from `WorldV3.nextTerminationId`**, not the `seq` of the command that made it. Every command that lands an end (`wire.add` for each landed end, `a` then `b`; `wire.land`) takes the next id. Undo restores the counter; redo and undo of an unland or a delete restore the same termination object, id included.

Why, over keying on `seq` (this ADR's draft):

- **Surface independence.** View commands (`toolbelt.select`, `view.mode`, `view.overlay`, `view.focus`) are logged and take `seq`s, so a mouse session and a palette or keyboard session that build the same circuit land their terminations at different `seq`s. Keyed on `seq`, the stored outcome (a screwdriver's torque draw) and therefore `world.hash` would depend on which surface did the wiring, and the cross-surface hash E2Es (plan acceptance: mouse, keyboard-only and palette reach the same hash) would fail. A world counter advances only with world changes, so equal circuits get equal ids and equal outcomes.
- **Uniqueness without a rule.** `seq` isn't unique within a world: `CommandBus.firstSeq` defaults to 0, `sim run --world` and fixture and level worlds start new logs, and P4's pre-wired levels will hold terminations made by another log. A world counter is unique by construction; no "`firstSeq` must exceed every stored termination seq" rule is needed.
- **Checkpoint-safe.** A save's log is rebased onto a checkpoint (D19, kickoff step 4), moving `firstSeq`; identities and draws that live in the world don't care.
- **Cost:** one more counter, and `seq` no longer says when a termination was made (the log does).

Consequently **no P3 world command draws from `commandStreamKey(seq)`**; that key stays for commands whose randomness is about the command itself.

### `CableV3`

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
  entry: EntryId; // one of its catalogue entries; open, with room
}
```

- **A cable owns its conductors.** `cable.add` creates the cable and one `ConnectionV3` per assembly conductor (`cable: { id, conductor: i }`, `ref` the assembly's pinned conductor ref, `colour` the assembly's, both ends null, `route` null, `lengthMm` the cable's). A cable conductor is never deleted or rerouted on its own (`in-cable`); `cable.delete` removes all of them.
- **Tails are stored, not derived.** `tailsMm` is how much cable was left past each entry (into the box), from `defaultTailsMm` in `routing/` (sourced or game-design, shared by the mouse, the console's `auto` and `game.autoRoute`); `jacketStripMm` is how much of that has had its jacket removed. A cable conductor can land on a terminal only if the terminal is within the tail's reach, compared as integers (`d² ≤ tailsMm[end]²`, d the straight distance from the entry point to the method's entry point), and the jacket at that end has been stripped (`jacketStripMm[end] > 0`); otherwise `tail-too-short`. ADR 0017 may tighten the reach rule (bends, the jacket's minimum inside the clamp) before v0.4.0.
- **Tail shapes are baked, never stored.** Each entry has an inward direction (catalogue `axis`); an unlanded cable conductor's tail is baked as a stub along it, fanned by `cable.conductor`, and a landed one from the entry to the terminal.
- **Free ends are allowed.** The demo's supply is a stand-in utility entity with no entries (D12), so a cable end may be `null` (the cable stops in the open, its free end on its route's first or last waypoint).

### The route shape

```ts
interface WaypointV3 {
  kind: 'free' | 'duct' | 'conduit' | 'staple' | 'bore';
  positionMm: PositionMm;
  entity: EntityId | null; // the duct, conduit stick or stud entity it is on
  fixture: FixtureId | null; // or the level fixture (a stud) it is on
  tool: CatalogRef | null; // a bore's drill bit or hole saw (one tool entry per size); null for every other kind
}
```

- **Integer millimetres, ordered from end `a` to end `b`,** at most `MAX_ROUTE_WAYPOINTS` (1 024, game-design: a 1 km run stapled every metre fits) per route. A `free` waypoint has neither host; every other kind has exactly one of `entity` and `fixture`; a `bore` has a `tool` (which sets the hole), the others none. The schema checks those shapes; which kinds a command accepts where is ADR 0017's (`bad-waypoint`). A bore exists only as a waypoint in P3 (deleting the cable removes the hole); P4 may need bores as stud state.
- **A hosted waypoint's `positionMm` is the domain snapper's point on its host's axis:** a duct's or conduit's centreline, a staple's point on the stud face, a bore's axis at the stud's mid-plane. Lanes, conductor radius and lead-outs are bake offsets, never stored.
- **The route's points are** end `a`'s terminal entry point (if `a` is landed), the waypoints, then end `b`'s (if landed). For a cable, a non-null end's point is its entry's position.
- **Each null end has a rest waypoint:** the first (end `a`) or last (end `b`) waypoint, which must be of kind `free`. `wire.unland` appends a rest waypoint at the terminal's entry point; `wire.land` **replaces** that end's rest waypoint with the terminal point, and the result must still fit `lengthMm` (`too-short`). So a route's waypoint count is unchanged by any land and unland cycle, and no cycle makes a zero-length segment. `wire.pull` routes start and end with `free` rest waypoints outside the conduit. **Consecutive route points (terminal points included) are distinct** (`bad-waypoint` at the command; the schema checks the waypoints among themselves).
- **Duct lanes** are assigned at bake, ordered by cable occupants by cable id, then single conductors by connection id (ADR 0017 may change the order, but it must cover both id spaces).
- **Logged arguments carry explicit waypoints** (D5). The console writes arrays (and empty objects) as a compact JSON word (`--route [{…}]`) and every other object, a nullable object or a union's object member included, as dotted flags (`--a.termination.method screw`); `formatConsoleLine` writes them so (the ADR 0008 amendment, P3 PR 5a; corrected here in P3 PR 8, which found the earlier wording said unions were JSON words). `MAX_CONSOLE_LINE_LENGTH` is raised to admit the largest legal `wire.add` and `wire.pull`, pinned by a round-trip spec against the real schemas (`world-model/src/lib/wiring/console-line.spec.ts`). `--route auto` and `--lengthMm auto` (the flag is the argument's key) are console shorthand, expanded by `expandConsoleArgs` in `@controls/scripting-api` (owner: main agent) through the shared router and `routeDefaultLengthMm`, per line on the live world, before `exec`, on every console surface (the game console, `sim run`, `sim-cli`). `'auto'` as a termination is not shorthand: it is a logged value. A console file that uses the shorthand re-pins its hashes when the router changes; a replay log never does. P3 has no `3:L1` terminal shorthand.
- **Never persisted:** the baked centreline, duct lanes, the live Verlet preview and tail shapes. They are pure functions of the world (ADR 0017), recomputed on load. The bake uses only `+ − × ÷ √` and quantisation (the D6 lint): a parabolic sag depth from `√(3 · L · (s − L) / 8)`, never a catenary (`cosh`) or arc length (`asinh`). Taut spans along raceways are one instance per span; only free spans are subdivided. The bake draws the polyline plus lane offsets and lead-outs, with extra length shown as sag on free spans up to a cap set by ADR 0017; length beyond the cap is drawn as a coil at a deterministic place. **The drawn length is a picture; `lengthMm` is what is wired.**
- **Geometry needs axis-aligned hosts.** A terminal's, entry's, mount's or hosted waypoint's world position is the entity's position plus a catalogue offset rotated by the entity's orientation. With orientations in millidegrees that needs sine and cosine, which ECMAScript doesn't pin across engines, and ADR 0014 (`dmath`) is deferred. So in P3 every command that needs the world position of a terminal, entry, mount **or hosted waypoint** refuses an entity whose yaw, pitch and roll aren't each a multiple of 90 000 (`not-axis-aligned`). That covers the host of a duct, conduit, staple or bore waypoint, the mounted device itself, and its host. Quarter-turns composed in yaw-pitch-roll order give integer signed-permutation matrices, so positions stay exact integers. Mouse placement only produces quarter-turns (`snap/placement.ts`); only a console or script `entity.rotate` makes others. One exact helper, **`entityPointMm(transform, offsetMm)` / `entityDirection(transform, dir)`** (an integer quarter-turn table, never `Math.cos`; owner `renderer-engineer`, next to `snap/`), is used by the commands, `checkWorldReferences`, `routing/` and the renderer's terminal picker.

### The length rule (D5, amended)

- **`lengthMm` is a logged argument, computed by the surface and checked by the command.** `routeDefaultLengthMm(points, slack, tails)` in `world-model/src/lib/routing/` (the polyline plus a game-design slack allowance (5 %, P3 PR 8) until ADR 0017, rounded up to a millimetre) is what the mouse, the console's `--lengthMm auto` and `game.autoRoute` fill in. The command refuses a length below the floor (`too-short`) or above `MAX_CONDUCTOR_LENGTH_MM` (1 000 000, game-design: 1 km).
- **The floor is `routeFloorMm(points)`** in `routing/`, used by both the command and the surface: `ceil(Σ √(Δx² + Δy² + Δz²))`, each `√` of a safe integer (property: `routeDefaultLengthMm ≥ routeFloorMm`). **Its point set (terminal entry points and waypoints only; no lead-outs, lanes or tunable constants) is save format from v0.4.0**: changing it changes which logged commands replay. For a cable the floor is `routeFloorMm(route points) + tailsMm.a + tailsMm.b`.
- **Why it moved from the command to the surface.** D5 computes the length inside `run`, so a later change to the slack allowance would change what an old log replays to (and every save with a wire would restart its log on load). As an argument, the meaning of a logged `wire.add` never changes, and a player or script can cut to a chosen length: the voltage-drop acceptance needs exactly 30 m of 14/2, which no "polyline plus slack" route gives without contortions. The floor uses only `+ × √` on integers, the same in every engine.
- **The length is fixed once cut.** `wire.reroute` and `cable.reroute` keep `lengthMm` and refuse a route that doesn't fit (`too-short`); to change it, delete and add again (there is no re-cut command in P3).
- **The netlist reads `lengthMm` only.** Route geometry never reaches `sim-core`.

### Mounting and occupancy (D11)

- **`entity.place` gains `mountedOn`** (`{ entity, mount } | null`, default `null`). Non-null is checked against the catalogue: the host exists and is axis-aligned, has that mount (`unknown-mount`), the device declares a matching mount type (`mount-mismatch`), the mount has room (`mount-full`: one for a yoke, by overlap along a rail), the device's position lies on the mount (`off-mount`, F3.5's integer check), and **the mounted device's `orientationMdeg` equals the host's orientation composed with the mount's catalogue frame** (`off-mount` otherwise). `entity.place` doesn't test against wire routes in P3.
- **An enclosure is occupied** when a device is mounted on it, a cable end is in one of its entries, or a route waypoint names it. `entity.move`, `entity.rotate` and `entity.delete` refuse an occupied entity (`occupied`).
- **A mounted device can't be rotated** (`mounted`) **or moved off its mount** (`off-mount`). `entity.move` may slide it along the same mount, re-checked with `off-mount` and `mount-full` / `overlaps`, unless it is `wired`. Moving it to another mount is delete and place in P3.
- **An entity with a landed conductor end can't be moved or rotated** (`wired`): its terminals would leave its wires' routes and lengths behind. Unland first, or delete and place again.
- **`entity.delete`** removes every lead with an end on the entity (as in v2) and **unlands** every conductor end on it (a rest waypoint where the terminal was), in the same change; undo restores the entity, the leads and the conductors exactly, terminations included.
- **Obstacles that aren't axis-aligned** (for `route-collides`) are tested as the integer cube centred on their `positionMm` with half-side `ceil(√(w² + h² + d²))`: conservative, no trigonometry.

### Tool capabilities

Tool entries (`content/tools/`, D10) declare `capabilities: { step, maxAwg | null }[]`, with `step` from `cut | strip | stripJacket | crimp | drive | torque | openEntry | bore | pull | label`. **A command checks the capability its step needs** (`wrong-tool` if absent, `beyond-tool-capacity` over its size limit), never the tool kind alone; the kind is for the tool belt and the UI. So a stripper with cutting jaws can cut. Hole and die ids are save format per tool entry version: a renamed or removed id needs a new tool entry version. A drill bit or hole saw is one tool entry per size, so `WaypointV3.tool` names the hole. Tools are sandbox-owned in P3 (no ownership check).

### Commands

Every id and argument shape here is save format from the moment it is logged; the commands PR freezes each in `json-schema/command-args/<id>.args.schema.json`. Each command is undoable, restores ids and counters on undo, and **never reads sim-owned state** (a property test, as for `device.operate`). Comments name the capability each tool must have.

```ts
type LandedEndArg = { entity: EntityId; terminal: TerminalId; termination: TerminationArg };
type EndArg = LandedEndArg | null;
type ToolRef = CatalogRef; // a tool entry (content/tools)

'wire.add':      { ref: CatalogRef; a: EndArg; b: EndArg; route: WaypointV3[]; lengthMm: Int; colour: ConductorColourV3; tool: ToolRef }        // cut
'wire.delete':   { id: ConnectionId }
'wire.reroute':  { id: ConnectionId; route: WaypointV3[] }
'wire.land':     { id: ConnectionId; end: 'a' | 'b'; at: LandedEndArg }                                                              // tools inside the termination
'wire.unland':   { id: ConnectionId; end: 'a' | 'b' }
'wire.label':    { id: ConnectionId; text: LabelText | null; tool: ToolRef }                                                         // label
'wire.pull':     { route: WaypointV3[]; lengthMm: Int; conductors: { ref: CatalogRef; colour: ConductorColourV3 }[]; tool: ToolRef } // pull; 1..16 conductors
'cable.add':     { ref: CatalogRef; a: CableEndV3 | null; b: CableEndV3 | null; route: WaypointV3[]; lengthMm: Int; tailsMm: { a: Int; b: Int }; tool: ToolRef } // cut
'cable.strip':   { id: CableId; end: 'a' | 'b'; jacketMm: Int; tool: ToolRef }                                                       // stripJacket
'cable.delete':  { id: CableId }
'cable.reroute': { id: CableId; route: WaypointV3[] }
'cable.label':   { id: CableId; text: LabelText | null; tool: ToolRef }                                                              // label
'enclosure.openEntry': { id: EntityId; entry: EntryId; tool: ToolRef } // the capability the entry type's registry row lists
'entity.place':  { ref: CatalogRef; positionMm: PositionMm; orientationMdeg: OrientationMdeg; mountedOn: { entity: EntityId; mount: MountId } | null } // mountedOn defaults to null
'entity.label':  { id: EntityId; text: LabelText | null; tool: ToolRef }                                                             // label
// unchanged ids and shapes: entity.move, entity.rotate, entity.delete (new refusals), lead.connect, lead.disconnect (byte-unchanged)
```

- **Ids:** `wire.add` takes `nextConnectionId` and a termination id per landed end; `wire.land` takes a termination id; `wire.pull` takes one connection id per conductor, in array order; `cable.add` takes `nextCableId` and then one connection id per assembly conductor, in assembly order. Undoing restores every counter; undoing a delete reinserts the same ids and data.
- **`wire.pull`** is how conductors get into conduit: a route containing a `conduit` waypoint is refused by `wire.add` and `cable.add` (`needs-pull`) and accepted only here, which the fish-tape minigame logs on success (D10). It creates the conductors with both ends free at the run's ends. The plan's `{conduit, conductors, tool}` named the conduit; the route names it (its `conduit` waypoints), which is what the world stores, so the argument is the route. **The minigame's play never becomes an argument:** skipping (Trainee) and succeeding log identical `wire.pull` arguments; failing or abandoning logs nothing. Surfaces pre-check with the same pure validation `run` uses (exported from `world-model`) before starting it.
- **Labels are their own commands** (`wire.label`, `cable.label`, `entity.label`), each taking a tool that can `label`, so `wire.add` and `cable.add` don't carry a label without the tool that prints it (D10). `text: null` removes a label.
- **`wire.add` and `cable.add` take a tool that can `cut`.** `cable.strip` sets `jacketStripMm[end]` and can only strip more (`cannot-unstrip`), up to the tail (`strip-too-long`).
- **`lead.connect` and `lead.disconnect` keep their ids and argument schemas byte for byte** (D2). `lead.connect` now builds a lead-shaped `ConnectionV3` with the lead kind's initial bags; `lead.disconnect` refuses a conductor (`not-a-lead`), and the `wire.*` commands refuse a lead (`not-a-wire`).
- **Not commands:** `wire.info <id>` is a read-only console query (D16), never logged; the console's query path must accept an argument (it rejects arguments on queries today).

#### Refusal codes

| Code                                                                    | When                                                                                                                                                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not-found`                                                             | No entity, connection or cable with that id                                                                                                                                              |
| `not-a-conductor` · `not-a-cable` · `not-an-enclosure` · `unknown-tool` | Decided by what the `ref` resolves to in the one catalogue namespace: not a conductor entry, a cable assembly, an enclosure, or a tool                                                   |
| `not-a-wire` · `not-a-lead`                                             | A `wire.*` command on a lead; `lead.disconnect` on a conductor                                                                                                                           |
| `in-cable`                                                              | `wire.delete` or `wire.reroute` on a cable conductor                                                                                                                                     |
| `wrong-tool` · `beyond-tool-capacity`                                   | A tool without the step's capability (or a `screw` method with no clamp tool); a tool whose capability doesn't reach the conductor's size                                                |
| `unknown-hole` · `unknown-die`                                          | A hole or die the tool doesn't have                                                                                                                                                      |
| `wrong-drive`                                                           | A driver whose drive types (`slotted`, `phillips`, `pozidriv`, `square`, `hex`) share none with the screw's or the entry type's (F3.4 part 1; implementation note 16)                    |
| `no-terminals` · `unknown-terminal` · `same-terminal`                   | As `lead.connect` (ADR 0013)                                                                                                                                                             |
| `already-landed` · `not-landed`                                         | `wire.land` on a landed end; `wire.unland` on a free one                                                                                                                                 |
| `terminal-full`                                                         | The terminal already holds the method's physical maximum (`maxConductors`); above `ratedConductors` is allowed and makes a worse termination (D8)                                        |
| `gauge-out-of-range`                                                    | The conductor's AWG designation is outside the method's `awgRange`, or its stranding isn't accepted                                                                                      |
| `wrong-method` · `wrong-accessory`                                      | A method the terminal doesn't list (including a clip-only terminal); an accessory that doesn't fit the conductor or the method                                                           |
| `combination-out-of-range`                                              | A wire-nut splice outside its rated count, AWG or total-size bounds                                                                                                                      |
| `termination-required`                                                  | `'auto'` above Trainee                                                                                                                                                                   |
| `unavailable-colour`                                                    | A colour the conductor entry isn't made in (or `bare` on an insulated conductor)                                                                                                         |
| `too-short` · `tail-too-short`                                          | The length is below the floor (or the new route's); a cable conductor's terminal is out of the tail's reach, or the jacket isn't stripped                                                |
| `route-collides` · `bad-waypoint` · `needs-pull`                        | A segment through a device body (straight segments until F3.2 part 1); a waypoint whose host is missing or of the wrong kind, or repeated points; a conduit waypoint outside `wire.pull` |
| `not-axis-aligned`                                                      | A terminal, entry, mount or hosted waypoint on an entity that isn't at quarter-turns                                                                                                     |
| `entry-closed` · `entry-full` · `unknown-entry` · `already-open`        | A cable through an unopened entry; one with no room (`maxCables`); an entry the enclosure doesn't have; `openEntry` on an open entry                                                     |
| `unknown-mount` · `mount-mismatch` · `mount-full` · `off-mount`         | As in [Mounting and occupancy](#mounting-and-occupancy-d11)                                                                                                                              |
| `occupied` · `mounted` · `wired`                                        | As in [Mounting and occupancy](#mounting-and-occupancy-d11)                                                                                                                              |
| `cannot-unstrip` · `strip-too-long`                                     | `cable.strip` to less than already stripped, or past the tail                                                                                                                            |
| `ids-exhausted`                                                         | A counter would pass `Number.MAX_SAFE_INTEGER`                                                                                                                                           |
| `same-entry` (P3 PR 8)                                                  | `cable.add` with both ends in the same entry (schema invariant 7 refuses the world it would make)                                                                                        |

Refusals aren't logged, so their codes aren't save format; they are API for scripts and the UI, and tests pin them.

### What the netlist compiler reads (D4)

**One branch per netlisted connection** (ADR 0011 §7 kept). For each connection, in id order:

1. **Netlisted only if** its ref resolves to a connection kind with a model, **both ends are non-null**, both name netlisted entities and existing terminals, and neither end's state is `intermittentOpen`. Otherwise it is absent, with a reason: the existing ones, plus `unlanded` (a null end) and `intermittent-open`. Absent connections are in no node, branch or hash. **Only open versus not-open is topological:** `ok` ↔ `intermittentClosed` ↔ `arcing` are value changes and never recompile. An intermittent end's open and closed periods are whole multiples of `INTERMITTENT_MIN_DWELL_TICKS` (a sourced game-design constant fixed in ADR 0018, at least 100 ticks), so each intermittent end causes at most one topology event per dwell. Every period after the first is a whole multiple of the dwell; the first ends at the next bucket boundary, so onset can add one extra topology event per end, once (ADR 0018). The engine checks only ends in a non-`ok` state, held in a preallocated compact list, never every end on every tick. `sim bench` gains `intermittent-toggle-wired` (one toggle on the wired 2,000-node plant) under the calibrated 2 ms re-solve gate.
2. **The element is static.** `ConnectionNetlistModel.element(params)` becomes `element(input)`: `input` holds the entry's params, `lengthMm` (or the lead's catalogue length), and per end the `TerminationV3` (or null for a clip), the method spec and the landed count. It returns static values: the conductor's resistance at the reference temperature and each end's as-made contact resistance R0. The connection bank's `dcValue`/`acValue` stamps R = R_cond(T) + R0a · degradationA + R0b · degradationB (+ the end's regime resistance, ADR 0018 §6) at solve time, as the lamp filament does. **The compiler reads the connection's sim state only through `simTopologyKeys` (`endAState`, `endBState`), and only the open versus not-open distinction.** A lead's static value is v2's; its solve-time value follows its temperature. AC conductors are purely resistive in P3 (no inductance), a stated abstraction.
3. **Landed counts.** The compiler counts, on every compile, the conductor-kind ends landed on each terminal by each method, netlisted or not; lead clips don't count. The count goes in a preallocated per-terminal array. A connection's cache entry records its two end counts and the engine's view of its `simTopologyKeys`, and is rebuilt when either differs, so a count change is a values-only compile. `CompileOptions` gains `connectionSim(id)`, the engine's live connection bag, as `sim` is for entities. The factorisation cache is unaffected: counts are values.
4. **It never reads** `route`, `colour`, `label`, `cable`, waypoints or positions. Conductors in one cable are electrically and (in P3) thermally independent (D7).
5. **End voltages** are derived after the solve as V_terminal ∓ I · R_contact (exact for series elements) and published in the connection record (protocol 6); they add no unknowns.

So no new element kind or stamp is needed, the oracle corpus is unchanged, and a lead's value is the same as in v2.

### Connection state bags and their owners

Both bags have ADR 0013's generic shape (`DeviceStateBag`), checked per kind at load against `MODEL_KINDS`, which now declares keys for connection kinds too (registered as stateful connections; `json-schema/connection-state.<kind>.schema.json`).

- **`state` (commanded):** written only by commands. **Empty for `lead` and `conductor`.** It is kept so a later connection kind with a commanded setting needs no shape change. Termination, route, length, colour and label are typed fields, also commanded.
- **`sim` (sim-owned):** written only by `materialiseWorld`, inert in the live world, never read by a command. **The renderer and the readouts read connection state only from records** (protocol 6), never from `connection.sim`. Owner `sim-engine-engineer`; `save-format-guardian` reviews every key. **`lead` and `conductor` share one key set of ten keys** (D2: leads join the thermal model):

| Key                                      | Type                                                             | Initial | Meaning                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conductorTempK`                         | number or null                                                   | `null`  | The conductor's lumped temperature; null until first simulated (the engine starts it at ambient)                                                                                                                                                                                                                             |
| `endATempK`, `endBTempK`                 | number or null                                                   | `null`  | The end's termination hot spot; null while the end has no termination node (unlanded, or not yet simulated)                                                                                                                                                                                                                  |
| `endADegradation`, `endBDegradation`     | number ≥ 1                                                       | `1`     | Irreversible growth of the end's contact resistance as a multiple of its as-made value (D8: monotone, never reversed by cooling). Kept while the end is unlanded                                                                                                                                                             |
| `endATerminationId`, `endBTerminationId` | integer or null                                                  | `null`  | The termination identity the end's temperature, degradation and state belong to. Kept while unlanded                                                                                                                                                                                                                         |
| `endAState`, `endBState`                 | `'ok' \| 'intermittentClosed' \| 'intermittentOpen' \| 'arcing'` | `'ok'`  | The end's contact state; `intermittentOpen` takes the connection out of the netlist. The open/closed phase is a pure function of (the bag's degradation, the as-made contact resistance, the termination's stream, tick bucket; refined by ADR 0018); a materialised bag always equals it at the export tick (property test) |
| `insulationDamaged`                      | boolean                                                          | `false` | Sticky: set once the conductor passed its insulation's damage temperature (an event and a flag only in P3)                                                                                                                                                                                                                   |

- **Degradation is a multiplier** because sourced failure thresholds are ratios of the initial resistance, R0 changes with the landed count, and a multiplier survives contact-model changes. **The state is persisted** (the blown and tripped pattern): the starting compile reads the topology from the bags, and the saved `topologyHash` must match.
- **For a lead, every end key stays at its initial value** (clips have no termination node, D2); a property test enforces it.
- **The key set is provisional until v0.4.0** (like v3 itself) and is finalised by ADR 0018 (F3.3 part 1, F3.6 parts 1–2), with fixtures updated in the same PR. Adding a key after v0.4.0 is a `schemaVersion` bump (ADR 0013's rule).
- **The thermal bank covers every connection of a known connection kind, netlisted or not.** An unlanded conductor carries no current and relaxes towards ambient, and its other end keeps its degradation. So `materialiseWorld` overwrites the `sim` bag of every connection whose kind the catalogue knows, not only the netlisted ones. The engine updates the bank when the set of known connections, or any end's termination, changes, whether or not the netlist changed.
- **The bank integrates on a fixed absolute schedule** (ticks where `t % SOLVE_INTERVAL_TICKS === 0`, with the exact dt since the previous scheduled tick), never on solve events, so a bag never needs a "last integrated" key and save/load parity is structural. `tick-wired-plant` times the layers of a **cadence** tick (the solve excluded and measured under its own budget), never a non-cadence one, with the allocation gate. A synthetic-bank version of the case lands with the boundary-and-gate PR, so the budget is measured before the model. Over budget on a CI runner is reported to the user, never loosened. The update is never staggered by id (the 1 % re-solve rule would then re-solve every tick).
- **An end's sim values belong to one termination.** Whenever the engine builds a bank or applies a command, for each end: if the world's end is null, the end's temperature is null and its degradation, state and `end*TerminationId` are kept, so undoing an unland or a delete restores the same contact as it was. If the termination's `id` equals the bag's `end*TerminationId`, the end continues. Otherwise the end resets: temperature = the conductor's, degradation 1, `end*TerminationId` = the new id, and **state = the §6 decision for (D = 1, R_made, the new termination's stream, bucket(t))** (ADR 0018). This is a pure function of (bag, world), the same after a load, through either transport and on replay; it needs no end tombstones. Deleted connections use id tombstones, as entities do.

### PRNG stream keys

`deriveStream(seed, key)` and its golden vectors are unchanged (ADR 0007). New key functions in `world-model/src/lib/prng.ts`, next to `commandStreamKey(seq)` = `command:<seq>` and `entityStreamKey(id)` = `entity:<id>`:

```ts
connectionStreamKey(id: ConnectionId): string   // `connection:${id}`
cableStreamKey(id: CableId): string             // `cable:${id}`
terminationStreamKey(id: TerminationId): string // `termination:${id}`
// per-purpose suffixes, each its own stream:
//   `${terminationStreamKey(id)}:strip` | `:crimp` | `:clamp`      command time (resolveTermination)
//   `${terminationStreamKey(id)}:intermittent` | `:arcing`         engine time (ADR 0018)
```

- **Command-time draws** (a screwdriver's torque spread, nicks from a wrong hole) use the termination's step streams, and their outcome is stored in the `TerminationV3`; the engine never draws them again. Keyed by the world-allocated termination id, the same circuit gets the same outcomes whichever surface built it.
- **Engine draws for an end** (intermittent bucket draws; the arc voltage, drawn once per termination) use the termination's `:intermittent` and `:arcing` streams. A termination belongs to one end, so the key needs no end; a re-made termination is a new contact with a new sequence, and the same one is identical across runs, replays, transports and a save and load. **Per-tick draws use only `Math.imul`, `>>>`, `^` and `+` on the stream's cached first output and the tick bucket**, as sfc32 does: no persisted generator state, no string built per tick, no draw-order dependence on other ends.
- **`connectionStreamKey`** is for per-conductor randomness that lives as long as the conductor (manufacturing tolerance, if a later model wants it); **`cableStreamKey`** is reserved: no P3 consumer is planned, and defining it now means a later one can't collide.
- The prefixes `command:`, `entity:`, `connection:`, `cable:` and `termination:` are distinct, so keys can't collide across kinds. The key functions and suffixes are frozen with v3 at v0.4.0, with golden strings in `prng.spec.ts`.

### Schema invariants

Zod refinements on `WorldV3` (not in the JSON Schema), each with a refused fixture:

1. Fixtures, entities, connections and cables are each sorted by strictly ascending id; entity, connection and cable ids are below their counters, and every termination id is below `nextTerminationId` and unique in the world.
2. `mountedOn.entity` exists, isn't the entity itself, and mounting has no cycle.
3. A non-null connection end names an existing entity; two landed ends aren't the same terminal.
4. **Shape consistency:** `lengthMm === null` exactly when the connection is lead-shaped (`route`, `cable`, `colour` and `label` null, both ends non-null with null terminations); otherwise `colour` is non-null, exactly one of `route` and `cable` is non-null, and every non-null end has a termination.
5. A conductor's `cable.id` names an existing cable; per cable, its conductors' indices are exactly `0 … n − 1` with n ≥ 1, and each has the cable's `lengthMm`.
6. Routes: at most 1 024 waypoints; host and tool fields as in [The route shape](#the-route-shape); hosts exist; a null end has a `free` first (or last) rest waypoint; at least two points in all; consecutive waypoints are distinct.
7. Cables: non-null ends name existing entities and aren't the same entry; `jacketStripMm[e] ≤ tailsMm[e]`; `tailsMm.a + tailsMm.b < lengthMm` (the full floor, with the entry points, is in the load check).
8. The solution record as in v2.

**In the load check** (it needs the catalogue): `checkWorldDevices` becomes `checkWorldReferences` and still fails as `invalid-device-state` (no new `LoadGameError` kind). It checks: the plan's "`lengthMm` ≥ the straight-line distance between landed ends" (as integers, `lengthMm² ≥ Δx² + Δy² + Δz²`, exact since coordinates are at most 10 km) and the cable floor; `mountedOn` names a mount the host has and the device fits; connection refs are connection kinds, lead-shaped exactly when the kind is `lead`; terminals and methods exist; cable refs are assemblies, with one conductor per assembly conductor whose ref and colour match; cable ends are open entries; landed and hosted entities are axis-aligned; colours are in the table and made by the conductor entry; tool refs, holes and dies exist; each bag has exactly its kind's keys. A ref the catalogue doesn't know is still left alone (its connections and cables round-trip untouched and aren't netlisted).

### Hash scope

- **`world.hash`** is unchanged in definition (SHA-256 of the canonical JSON of the parsed world, ADR 0007), so it now covers cables, the new counters, routes, lengths, colours, labels, terminations, `mountedOn`, entity labels and every connection's bags. Every world gains `"cables":[]`, `"nextCableId":1`, `"nextTerminationId":1` and per-entity `"label":null,"mountedOn":null`, so **every pinned world hash is re-pinned once**, at the world v3 PR, listed old → new in the CHANGELOG (the plan's list). Because termination ids and outcomes don't depend on `seq`, wiring the same circuit by the mouse, the keyboard or the palette reaches the same hash.
- **`topologyHash`** keeps its encoding (`CNT`, version byte 1): a conductor is a branch like a lead, named `c<id>`, with model kind `conductor`. Lengths, terminations, temperatures and degradation are values and stay out; an `intermittentOpen` end changes it (the branch goes). Unlanded connections aren't in it. `hash.spec.ts` gains a `conductor` golden (F3.1 part 1).
- **`snapshotHash`** gains the connection records with protocol 6 (F3.6 part 3).
- **Not in any of them:** the baked centreline (its own cross-runtime golden, ADR 0017), lanes, the live preview, display state.

### The v2 → v3 migration

Pure and total (`v3/from-v2.ts`, kept forever; the tests deep-freeze the input and run it twice). It doesn't read the catalogue.

- **World:** `schemaVersion: 3`, `nextCableId: 1`, `nextTerminationId: 1`, `cables: []`. Each entity gains `mountedOn: null` and `label: null`. Each connection (every v2 connection is a lead, or a ref the catalogue doesn't know) becomes lead-shaped: `a` and `b` gain `termination: null`; `cable`, `route`, `lengthMm`, `colour` and `label` are `null`; `state: {}`; `sim` is **the lead kind's initial bag** (the ten keys above at their initial values), held as a frozen constant in `from-v2.ts`. (The plan said "empty bags"; the lead kind gains keys in v3, so an empty bag would fail the load check. A ref the catalogue doesn't know keeps whatever bag it got, untouched, as ever.)
- **Replay log:** `initialWorld` migrated as above; every entry whose `id` is `entity.place` and whose `args` has no own `mountedOn` key gains `mountedOn: null` (any other entry, including `lead.connect` and `lead.disconnect`, is copied verbatim). The rule never throws on an odd entry: one that doesn't fit is copied and fails at replay, as before.
- **Manifest:** `schemaVersion: 3`; `catalogVersion` and `simEngineVersion` kept as saved.
- Every v1 and v2 fixture migrates and validates as v3; P1 saves (`0`/`0`) still verify by replay (their `entity.place` entries gain `mountedOn: null`, which is what a v3 bus logs).

### `catalogVersion` 2

Catalogue v2 (ADR 0016) lands before world v3. The requirements this ADR puts on it:

- **A shipped `(id, version)` resolves in every later catalogue version.** An existing entry keeps its version when it only **gains** data (termination method specs, mount declarations, thermal parameters a new engine reads) and every existing value is unchanged; behaviour that changes as a result is a `SIM_ENGINE_VERSION` change (D2). Any change to an existing value gets a new entry version beside the old. From catalogue 2 on, termination spec values (torque, strip length, counts, gauge range) count as electrical: changing them after v0.4.0 needs a new entry version.
- **One id namespace** for every catalogue family, prefixed (`tool.*`, `cable.*`, `conductor.*`, `ferrule.*`, `lug.*`, …). Accessories are entries of family `accessory` (`content/accessories/`), each with its accepted AWG range, stranding and the die ids that crimp it. Assembly-to-conductor references are pinned `(id, version)` refs.
- **Tables are pinned:** entries reference table rows by `{ table, version, key }`; a changed table value is a new table version, and only new entry versions point to it. (The `DeviceDefinition` v2 change is ADR 0016's; this ADR names the requirement.)
- **Source-coverage paths** extend to `terminals.<id>.methods.<method>.<field>`, `entries.<id>`, `mounts.<id>`, `conductors.<i>`, `capabilities`, `holes.<id>` and `dies.<id>`. `tailsMm` defaults, `MAX_ROUTE_WAYPOINTS` and `MAX_CONDUCTOR_LENGTH_MM` are game-design constants and say so.
- **The `lead` kind gains the ten sim keys above** (registered as a stateful connection; `connection-state.lead.schema.json` exported); that is a key change to an existing kind, which is why it rides on this `schemaVersion` bump.
- **0.3.0 saves** (`catalogVersion` 1, engine 6) load as `engine-changed`, never refused: migrated to v3, the solution record dropped, solved again at the save's tick, log restarted, leads' new keys initialised by the engine from their nulls. A fixture test proves it (`fixtures/v2/ctrl/*-engine-6.ctrl`, never regenerated). The `sources.spec.ts` rule ("`sim-step-engine-${SIM_ENGINE_VERSION}.ctrl` loads as `continued`") can't hold for a catalogue-1 file once the build is catalogue 2, so engine-numbered fixtures written from catalogue 2 on are named `*-engine-N-catalog-C.ctrl` and the rule checks the current pair.
- Saves are still references (ADR 0004): a conductor, cable, enclosure, accessory or tool is a `CatalogRef`, never inlined.

### Protocol 6 connection records (finalised by the ADR 0011 amendment in F3.6 part 3)

Listed here so the persisted keys and the published fields are designed together; **the byte layout, the validity rule and the sign-offs belong to the ADR 0011 amendment** (`sim-engine-engineer` with `renderer-engineer` and `angular-ui-engineer`), which finalises everything in this section.

- **One record per connection in the thermal bank** (every connection of a known connection kind, netlisted or not), in connection-id order, laid out by its kind's `ConnectionOutputSchema` (the device schema's rules: `f64` first, then 4-byte, then `u8`, padded to 8).
- **The descriptor gains** `connections: { connection: ConnectionId; kind: string; recordOffset: number; branch: number }[]` (`branch` −1 when not netlisted). Readers join by (id, kind), as for devices. **The descriptor's generation follows the bank's membership as well as the topology**, since `connections[]` lists connections that aren't netlisted. Readers carry display steps across generations by joining on connection id, so an intermittent toggle doesn't reset every overlay (recorded in the amendment).
- **Fields** (draft, 12 × `f64` + 4 × `u8`, 104 bytes): `currentA`, `conductorDropV`, `endADropV`, `endBDropV`, `endAVolts`, `endBVolts` (solved); `conductorResistanceOhm` (at its temperature), `endAContactOhm`, `endBContactOhm`, `conductorTempK`, `endATempK`, `endBTempK` (own state); `u8 endAState`, `u8 endBState` [`none`, `ok`, `intermittent`, `arcing`] (`none` for a free end; open and closed intermittent both publish `intermittent`); `u8 insulationDamaged` [`no`, `yes`]; `u8 status`.
  - `endAVolts`/`endBVolts` are |V(end) − V(islandReference)|, by the same rules as node voltages: on AC the phase means they can't be rebuilt from magnitudes, and the voltage overlay needs them.
  - `currentA` and the three drops are magnitudes (RMS for AC); direction comes from the connection's branch through `NetlistReadout.branchDirection`, exactly as for leads. **The end and conductor drops split the solved terminal-to-terminal voltage in proportion to the resistances the solution was stamped with,** so the drops always add up to that voltage.
  - **`status` gains `open`**: not netlisted, so `currentA = 0` and the drops = 0 are readings, not unknowns.
  - Readers treat an end's temperature and contact fields as absent when its state is `none` (never 0 K or 0 Ω); the writer puts 0 there, so every value is finite. Temperatures are own state, valid whenever the record is in the current descriptor.
- About 208 KB of records at 2,000 conductors: the overlay and snapshot read cases in `sim bench` include them.
- The overlays recolour the conductor meshes from these records and their branches; their own lead segments stay for leads only (D15).

### Sizes

A conductor with ten waypoints is about 1 KB of JSON; 2 000 conductors with their bags are about 3 MB, inside `world.json`'s 16 MiB cap, and a `wire.add` log entry is about 1 KB, so `replay.log`'s 32 MiB holds about 30 000 of them. A checkpointed save's `replay.log` holds a materialised world as its `initialWorld` (D19), so it is about the size of `world.json` plus its tail. No cap changes.

## Deviations from the plan

Decided here under the instruction to proceed autonomously; the plan is corrected in the same PR.

1. **`lengthMm` is a logged argument** checked against `routeFloorMm`, not computed in `run` (D5): replay stability across routing fixes, and cut-to-length.
2. **Tools are inside `TerminationArgs`** (strip, crimp, clamp); `wire.land` is `{ id, end, at }`.
3. **Labels have their own tool commands**; `wire.add` and `cable.add` take no label, and take a cutting tool. `entity.label` and `cable.label` are added.
4. **`wire.pull` takes the route** (with its `conduit` waypoints) instead of a conduit id.
5. **No re-cut:** reroutes keep the length.
6. **`ConnectionV3.cable` is `{ id, conductor }`; `CableV3` gains `tailsMm`; cable ends may be null.**
7. **Migrated leads get the lead kind's initial `sim` bag**, not an empty one.
8. **Two invariants move from the schema to the load check** (length against the chord; the mount exists).
9. **New refusals:** `mounted`, `wired`, `not-axis-aligned`, `unavailable-colour`, `beyond-tool-capacity`; terminals have per-method rated and physical conductor counts.
10. **Custom enclosure entries are catalogue `drillSite` entries**, not a world list.
11. **Termination identity and draws:** a world counter `nextTerminationId`; command-time spreads key on `termination:<id>:<step>` (not D8's `commandStreamKey(seq)`), and intermittent and arcing draws on `termination:<id>:…` (not D8's `connectionStreamKey`).
12. **Tools are checked by capability**, not by kind alone (D10).
13. **Product colours come from an append-only colour table** listed per conductor entry (F3.1 said "colours from `RegionProfile.conductorColours`"; the region profile holds rules, not products).

## Consequences

- `save-format`: `v3/{world,manifest,replay-log,from-v2}.ts`, the chain extended, `CURRENT_SCHEMA_VERSION` 3, the `LabelText`, `ColourId`, `TerminationMethodId`, `MountId`, `EntryId`, `HoleId` and `DieId` primitives (new names; v2's primitives untouched), `*.v3.schema.json`, fixtures under `fixtures/v3/{world,manifest,replay-log,ctrl}` (the plan's list, plus a checkpointed `.ctrl` from a session past 10 000 ticks) and `fixtures/v3/refused/` per invariant; a fast-check arbitrary for v3 worlds (routes, cables, terminations) with the JSON and container round-trip properties.
- `catalog`: connection kinds declare keys; `connection-state.<kind>.schema.json`; the termination-method and entry-type registries; the colour and gauge tables; capabilities; the requirements above for ADR 0016.
- `world-model`: the commands, `checkWorldReferences`, `resolveTermination` and `suggestTermination`, `routing/` (`routeFloorMm`, `routeDefaultLengthMm`, `defaultTailsMm`), `entityPointMm` / `entityDirection` (`renderer-engineer`), the new stream keys, properties (undo restores ids and counters; only undo and redo re-add old ids; no command reads `sim`; deleting an entity never leaves a dangling end; land and unland never change a route's waypoint count).
- `sim-core` and `sim-protocol`: `ConnectionNetlistModel` input, static values and `simTopologyKeys`, `CompileOptions.connectionSim`, the absent reasons `unlanded` and `intermittent-open`, the per-terminal landed counts, materialising every known connection's `sim` bag, tombstones for connection ids, the bank's absolute schedule, `INTERMITTENT_MIN_DWELL_TICKS`, the bench cases `tick-wired-plant` (cadence tick) and `intermittent-toggle-wired`.
- `scripting-api`: `game.autoRoute`, `expandConsoleArgs` (`--route auto`, `--length auto`), the engine-numbered fixture naming.
- **Palette and console (`angular-ui-engineer`), in their own PR before the commands PR:** `buildArgForm` gains a choice field (an `anyOf` of null, const scalars and at most one object: nullable objects and `'auto' | TerminationArgs`), nullable scalars (blank is null when the key has no default), and a list field for arrays (items an object or a scalar, `minItems`/`maxItems` kept, field ids like `route.3.positionMm.x`). No command is excluded from the palette; the every-command spec stays as it is. `ArgRefKind` gains `connection` and `cable` (prefilled from `selection.connectionId` / `selection.cableId`). Because hints are written into the frozen argument schemas, the hint vocabulary lands before the commands PR, whose schemas use it from the start. The console maps nullable objects and unions (`typed()` null checks, assignment into unions), writes the compact JSON word, and accepts an argument on queries (`wire.info <id>`); console history skips lines over its settings cap. This replaces the commands caveat "a union of scalar types is the only union an argument may use".
- **UI (F3.2 part 3 onwards):** Tab cycling covers entries and mounts as well as terminals, and connections and cables on a selected device; the viewport publishes `selection.connectionId` and `selection.cableId`; Delete on a selected wire is `wire.delete`, on a `when` disjoint from `entity.delete` (by selection kind); a tool or spool slot on the belt arms its flow, never placement; a tool the player didn't pick is the first matching tool on the belt, else the first catalogue tool with the capability by id, always shown in the prompt. The fish tape is step-based and untimed (WCAG 2.2.1), with no `Math.random`.
- Docs (in the implementing PRs): save-format caveats (v3), commands caveats (stream keys, counters, new refusals, the union rule), ADR 0008 amendment (console arrays and unions), `world-and-saves.md`, the new `wiring.md`, `docs/history.md` (`schemaVersion` 3), the glossary.

## Alternatives considered

- **A separate `wires` array** (D1 rejected): two id spaces and two compiler inputs, and leads would still need the same fields.
- **Three branches per wire with internal end nodes** (D4 rejected): about twice the unknowns for no new physics; the series-element rule gives the end voltages exactly.
- **Storing contact resistance in the termination:** the command would need `sim-core`'s model, and a model fix would leave old saves' numbers stale; storing the physical outcome avoids both.
- **Termination identity by command `seq`** (this ADR's draft): world hashes and outcomes would depend on which surface did the wiring, and `seq` isn't unique within a world without a `firstSeq` rule. See [Termination identity](#termination-identity-nextterminationid).
- **Computing `lengthMm` in `run`** (the plan's D5): see the length rule.
- **An intermittent open end as a very large resistance:** no topology event, but phantom voltages through ground leakage, merged islands and poor conditioning. Removing the branch with a minimum dwell bounds the topology events instead.
- **Degradation in ohms:** failure thresholds are ratios, and R0 moves with the landed count.
- **Staggering the thermal update by id:** spreads the cost, but the 1 % rule would re-solve every tick.
- **A typed `sim` object on connections instead of bags:** precise, but ADR 0018 isn't written and later connection kinds (P10 network cables) will want other keys; bags keep ADR 0013's one mechanism.
- **A closed colour enum:** every new insulation colour after v0.4.0 would be a `schemaVersion` bump.
- **Tool kinds instead of capabilities:** a stripper with cutting jaws couldn't cut without a second kind list.
- **Comparing floating-point areas for gauge checks:** the AWG area formula needs a fractional power (lint-forbidden), and stored areas are rounded, so equal gauges could be refused.
- **Deterministic trigonometry now (ADR 0014)** instead of quarter-turn hosts: real panels are axis-aligned; `dmath` stays deferred until a model or a free-angle mount needs it.
- **Transform-inheriting mounts** (D11 rejected for P3): moving a box would move its devices, but every host change would rewrite descendants and their routes.
- **An `entity.remount` command:** sliding along the same mount through `entity.move` covers the common case.

## Review

All four reviews (2026-11-11) were "approve with changes"; every required change is applied above.

- **`sim-engine-engineer`:** ten sim keys (degradation as a multiplier ≥ 1; `end*TerminationId`; the persisted four-valued state whose phase is a pure function of the tick); an open end removes the branch, with `INTERMITTENT_MIN_DWELL_TICKS` and the `intermittent-toggle-wired` bench case; the thermal bank on an absolute schedule, with `tick-wired-plant` timing a cadence tick; no clamp area in the outcome, `auto` never read; landed counts in the connection cache and `CompileOptions.connectionSim`; static compiler values with the bank stamping R(T) at solve time; golden vectors and per-step streams for `resolveTermination`; the end-reset rule as a pure function of (bag, world); bank membership drives the descriptor generation; drops split in proportion; the `open` record status; integer-only per-tick draws.
- **`renderer-engineer`:** the quarter-turn rule covers hosted waypoints and mounted devices and their hosts, with the mount-frame orientation check and the `entityPointMm` helper; conservative cubes for non-axis-aligned obstacles; rest waypoints replaced on land (no growth, no zero-length segments); the meaning of hosted waypoint positions; lanes across both id spaces; baked tail stubs and the integer reach check; `routeFloorMm` (its point set save format from v0.4.0) and the cable floor with tails; 1 024 waypoints; sliding along a mount; `endAVolts`/`endBVolts`, magnitudes with direction from the branch, `none` as absent; bake maths without transcendentals; one instance per taut span.
- **`angular-ui-engineer`:** a palette and console PR before the commands PR (choice, nullable and list fields; `connection` and `cable` ref kinds; the console's JSON words, raised line cap and query arguments); `wire.add` for a two-terminal gesture and `wire.land` for free ends, with `suggestTermination`; `expandConsoleArgs` for the console shorthand; the fish tape's play never an argument; `defaultTailsMm`; keyboard reach, selection keys, the Delete binding and tool-belt arming. Their "Other 1" (outcomes depending on `seq`) is resolved by `nextTerminationId`.
- **`content-designer`:** per-method terminal specs with integer AWG ranges and the method order as save format; entry and mount fields with an entry-type registry and `drillSite` entries; the append-only colour table, per-conductor colours and `unavailable-colour`; tool capabilities, `beyond-tool-capacity` and stable hole and die ids; the catalogue-versioning rule, one namespace, accessories, pinned table refs, source-coverage paths, twist-on ratings as bounds.
- **Conflicts resolved:**
  - _Intermittent open:_ the renderer offered a large resistance or a dwell; the sim engineer required branch removal. Decided: remove the branch, bound the rate with a minimum dwell, and carry overlay steps across generations by connection id.
  - _Record size:_ the sim engineer estimated 88 bytes; the renderer needs per-end voltages for AC. Decided: the 104-byte draft with `endAVolts`/`endBVolts`; the ADR 0011 amendment finalises the layout.
  - _Conductor counts:_ "conductor ends landed on the terminal" (sim) and "by the same method" (content) combine as per (terminal, method), conductor kinds only.
  - _Tool checks:_ the plan's kind check (D10) gives way to content's capabilities; the UI's tool-picking rule reads capabilities.
  - _Termination identity:_ the sim engineer offered a uniqueness rule or a world counter; the UI asked for surface independence; the main agent recommended the counter. Decided: `nextTerminationId`.
  - _`wire.land` shape:_ the UI's optional `at` reshape is adopted, so `wire.add` and `wire.land` share `LandedEndArg`.
- **Deferred suggestions** (not required, not taken now; each can be raised in its feature's PR):
  - sim: arcing resistance drawn once per (termination, onset) from the `:arcing` stream with no state (ADR 0018's call); the bank layer returning none/value/topology; twist-on quality reusing `torqueNm`.
  - renderer: recolouring through a per-instance conductor index and a colour texture; capping the pooled `InstancedMesh` at about 16 000 instances; drawing leads with the wire renderer; bores as stud state (P4); a `THIRD_PARTY_NOTICES.md` row if a label atlas font needs one.
  - UI: an auto-route fill button in the palette's route and length fields; a colour datalist and tool fields filtered by capability; Trainee defaulting to `'auto'`; `tool: null` on label removal (kept required for one rule); prompt limits for `LabelText`.
  - content: torque from device markings (Art. 110.14(D) by number), never UL 486A-B tables; a field-study source for the screwdriver spread, or game-design; metal boxes declaring their grounding-screw terminal as data now; the conductor's own ampacity figure, with P4 applying the NM-cable rule.

## Implementation notes (P3 PR 8)

The world v3 commands PR (main agent; `save-format-guardian` reviews afterwards) implements the commands above exactly. Where this ADR left a contract question open, it was decided conservatively here (refusing more rather than less, since a refusal can be relaxed later without changing what an old log replays to, while accepting something later refused breaks old logs):

1. **One new refusal, `same-entry`**: `cable.add` with both ends in one entry. Invariant 7 refuses the world it would make, and no listed code fitted.
2. **Clamp tools and torque settings.** For a clamp-torque method: `clamp.tool` must be a tool that can `drive` (`wrong-tool` if null or not); a tool that can also `torque` must be given its setting (`wrong-tool` if `torqueNm` is null) inside its range (`beyond-tool-capacity` outside); a tool that can't `torque` takes no setting (`wrong-tool`). For any other method (`springCage`, `backStab`, `twistOn`) `clamp` must be `{ tool: null, torqueNm: null }` (`wrong-tool` otherwise), so no logged argument is silently ignored.
3. **Accessories.** A ref that isn't an accessory of the catalogue is `wrong-accessory` (as is an accessory kind the method doesn't take, or one that doesn't fit the conductor's AWG and stranding). A stranded conductor counts as `strandedFerrule` only in a ferrule; a die the tool has but the accessory doesn't list is allowed and makes a worse crimp (the plan's "under-crimped lug"), while a die the tool lacks is `unknown-die`. The crimper's capability is checked against the conductor's size.
4. **The route cap counts landed ends**: a route's waypoints plus its landed ends are at most `MAX_ROUTE_WAYPOINTS` (`bad-waypoint`), so `wire.unland` and `entity.delete` (which add a rest waypoint) can never overflow a route.
5. **Waypoint hosts are checked for existence and quarter-turns only.** Which host kinds a waypoint kind accepts (a duct waypoint on a duct, a conduit waypoint on a conduit stick) needs F3.5 part 2's raceway kinds and is ADR 0017's; until then any existing, axis-aligned entity or existing fixture is accepted as a host, and a bore's tool must be able to `bore` (`unknown-tool`, `wrong-tool`). `wire.pull` needs at least one `conduit` waypoint (`bad-waypoint`). A conductor or cable already routed through conduit can't be rerouted (`needs-pull`): delete and pull again.
6. **`route-collides`** tests straight segments against the open interior of each body: catalogue devices with a size and built-in props, never an enclosure (hollow: routes run inside it) and never the entity at either end of the segment (a landed end's device, a cable end's enclosure, a waypoint's host). Touching a face is clear.
7. **Where a mounted device sits (`off-mount`, F3.5's integer check).** A mount's `positionMm` is where a mounted device's origin (the corner its body spans +x, +y, +z from) goes: a `single` mount takes it exactly there; a `linear` mount (a rail) anywhere along its `axis` from 0 to `extentMm − widthMm`, with nothing across or along `facing`; an `area` mount (a backplate) anywhere in its plane with both in-plane offsets from 0 to `extentMm` minus the device's width (along the axis) or height (across it), a square until a backplate declares its second extent. Room (`mount-full`): a `single` mount holds one device; spans along a rail, or footprints on an area, don't overlap (touching is fine). A mounted device must be axis-aligned (`not-axis-aligned`). The load check still checks only the mount, its type and alignment, not the position.
8. **`entity.delete` and unknown geometry.** Deleting an entity unlands a single conductor's end at its method's entry point; if the catalogue can't place that point (a device it doesn't know), the delete is refused as `wired` rather than inventing a rest point. A cable conductor's end just comes free (its tail stays in the cable). `wire.unland` refuses the same case as `unknown-terminal`.
9. **Tail reach at a free cable end** is measured from the cable's rest waypoint at that end (there is no entry point), and `cable.reroute` re-checks the reach of conductors landed at a free end, since the rest waypoint may move.
10. **Counters**: `wire.add` takes its termination ids in end order (`a` then `b`) only for landed ends; `wire.land` takes one; `cable.add` checks every counter before anything else. All restored by undo (property tests in `wiring/properties.spec.ts`).
11. **`resolveTermination`'s numbers are game-design and provisional** (nicks per AWG step a hole is too small, a stranding mismatch, crimp quality with a die the accessory doesn't list or a size outside the die's range, a plain screwdriver's ±40 % spread, a torque driver's stated accuracy), each step drawing at most once from its own stream. They are decided in the F3.3 part 1 PR (`sim-engine-engineer` + `electrical-realism-reviewer`), which re-pins the golden vectors in `termination/resolve.spec.ts`; otherwise they freeze as game-design at v0.4.0 (ADR 0018 owns the contact model, not these numbers). The resolver is held to the D6 lint (`termination/` joins `routing/`).
12. **Console shorthand.** `CONSOLE_EXPANDERS` registers `--lengthMm auto` for `wire.add`, `wire.pull` and `cable.add` through `routeDefaultLengthMm` (`routing/length.ts`: the floor plus `ROUTE_SLACK_PERCENT` = 5 %, game-design, plus the tails; `defaultTailsMm` gives `DEFAULT_CABLE_TAIL_MM` = 200 mm, game-design around NFPA 70-2023 Art. 300.14's free-conductor length, cited by number). `--route auto` waits for F3.2 part 1's router; until then `auto` there is a parse error.
13. **No keybinding** is added: Delete stays `entity.delete` on a selected entity. When the viewport publishes `selection.connectionId` (F3.2 part 3), Delete on a selected wire must be `wire.delete` on a `when` disjoint from `entity.delete`'s (by `selection.kind`).
14. **No real content yet.** No conductor, cable, enclosure or tool entry ships before F3.1, F3.4 and F3.5, so the commands are tested on `world-model`'s TEST-ONLY catalogue (`@controls/world-model/testing`), and there is no `sim-cli` scenario with a wire until the phase-acceptance scenarios.
15. **`twistOn` landings are refused** (`combination-out-of-range`) until the catalogue's twist-on `combination` bounds land (ADR 0018 §4.4, the ADR 0018 catalogue fields PR, F3.6 part 1): without them the command can't check a splice's rated count, AWG and total size. A refusal can be relaxed later without changing what an old log replays to.
16. **Drive types and `wrong-drive`** (F3.4 part 1, after the `electrical-realism-reviewer` review; `save-format-guardian` to review). A capability alone let a nut driver land a slotted terminal screw, and `suggestTermination` picked it. The catalogue now gives every tool that can `drive` its `drives` (the `DRIVE_TYPES` registry), every clamp-torque method spec its screw's `drives`, and every `ENTRY_TYPES` row the drives a tool opening it by `drive` needs (`slotted` for knockouts, pryouts and clamps). `checkSteps` refuses a clamp tool whose drives share none with the screw's, and `enclosure.openEntry` refuses a tool that opens the entry only by `drive` without a fitting tip, both with the new refusal **`wrong-drive`** (message names both sides: "Nut driver, 5/16 in (hex) doesn't fit the terminal screw (slotted or square)"). `suggestTermination` and `defaultTool` pick only fitting drivers. It is a catalogue-format addition only (ADR 0016 amendment): no world field, no argument shape, no stored outcome changes; it can only refuse commands that were accepted before, and no shipped log uses a catalogue-2 tool. Drive **sizes** are names, not modelled (game-design).
