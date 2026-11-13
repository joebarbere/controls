# ADR 0017: Routing and bake

**Status:** Proposed (2026-11-12). F3.2 part 1. Drafted by `renderer-engineer`; for review by `save-format-guardian` (the persisted surface, below) and `test-engineer` (the goldens, the parity e2e and the bench budget). The slack allowance is labelled game-design and is listed for `electrical-realism-reviewer`.
**Date:** 2026-11-12 (Phase 3)
**Deviates from:** [ADR 0010](0010-wire-routing-spike.md) ("What P3 must build" item 3: a fixed-step Verlet rope bake). Decides what [ADR 0015](0015-world-document-v3.md) left to this ADR (which waypoint kinds a command accepts where, the sag cap and the coil, the lane order, the default length's slack) and the open F3.5 part 2 question of which entry a conduit connector occupies.
**Sources:** [phase 3 plan](../../plans/phase-3-wiring.md) F3.2, decision D5 "Length and bake", the Budgets bullet (`route-bake-500-wires`), PR 14, the F3.5 part 2 follow-ups; [ADR 0010](0010-wire-routing-spike.md) (the measured design: two-click auto-route through ducts, lanes instead of rope collision, instanced segments, screen-space terminal picking, the 12 mm lead-out, the 15 mm sample spacing, "slack has to depend on context"); [ADR 0015](0015-world-document-v3.md) ("The route shape", "The length rule", implementation notes 5, 6 and 12 (P3 PR 8) and note 4 (F3.5 part 2)); [ADR 0016](0016-catalogue-format-v2.md) (`sizeMm`, mounts, the F3.5 part 2 amendment: `crossMm`, raceway kinds, `racewayPorts`); [ADR 0018](0018-conductor-and-termination-physics.md) (the netlist reads `lengthMm` only); [rendering](../caveats/rendering.md), [commands](../caveats/commands.md) and [save-format](../caveats/save-format.md) caveats

## Context

World v3 stores a conductor's route as explicit integer waypoints and its cut length as an integer logged argument (ADR 0015, D5). Everything else about a route is derived: the waypoints a surface proposes, where a waypoint snaps, whether a route passes through a body, how long a surface cuts it by default, which lane it takes in a duct, and the centreline it is drawn with. ADR 0010 measured the interaction and recommended a deterministic Verlet bake: a fixed number of rope steps from the command arguments, quantised. That costs about 8 ms a wire (200 steps), so about 4 s to load 500 wires, and the plan's D5 replaced it with an analytic bake. This ADR records the maths, the rules and the measured budget, all in `libs/domain/world-model/src/lib/routing/` (`type:domain`, under the D6 lint: `+ − × ÷`, `Math.sqrt` and rounding only), so `sim-cli`, scripts, the console and the mouse share one implementation.

## Decision

### 1. The modules

| File                 | What                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `floor.ts`           | `routeFloorMm`, `coversChord` (unchanged, ADR 0015)                                                                              |
| `length.ts`          | `routeDefaultLengthMm`, `ROUTE_SLACK_PERCENT`, `defaultTailsMm` (unchanged maths; see §5)                                        |
| `collide.ts`         | `segmentCrossesBox`, `conservativeCube`, `boxFromCorners`, and the shared `routeCollision` (§4)                                  |
| `ends.ts`            | `terminalPlace`: a terminal's method entry point and its exit direction in the world (exact quarter-turns)                       |
| `raceways.ts`        | `racewayPaths`: every axis-aligned duct and conduit part's axis, body, lane frame and drawn centreline (an elbow's legs and arc) |
| `auto-route.ts`      | `autoRoute(world, catalog, a, b, options)` (§2)                                                                                  |
| `snap.ts`            | `snapWaypoint(world, catalog, cursor, options)` (§3)                                                                             |
| `hosts.ts`           | `waypointHostProblem`: which host a waypoint kind accepts (§3)                                                                   |
| `lanes.ts`           | `assignLanes` (§6)                                                                                                               |
| `bake.ts`            | `bakeNodes`, `bakeWorldRoutes`, `centrelineHash` (§7)                                                                            |
| `connector-entry.ts` | `connectorEntries` / `connectorEntry`: which entry a conduit connector is in, derived (§8)                                       |
| `parity.ts`          | `routingDigests` / `routingDigestsOfDocument`: the cross-runtime goldens (§10)                                                   |
| `constants.ts`       | Every tunable, each with its source or its game-design label                                                                     |

### 2. The auto-router (one function for every surface)

`autoRoute(world, catalog, a, b, { ducts?, slackPercent? })` proposes a route between two terminals. Each end is `{ entity, terminal, termination? }`, where the termination (`'auto'` or absent: the terminal's first method, as `'auto'` lands it; or `{ method }`) picks the method whose `entryMm` is the route's end point and whose `exitAxis` (turned with the device) is the way the conductor leaves.

1. **Into the nearest duct.** For each duct, the terminal's candidate entry is the point of the duct's axis nearest the terminal (integer: the axis runs along one world axis). Candidates are ranked: ahead of the exit direction first (`(entry − terminal) · exit > 0`), then nearest, then lowest entity id. The four best per end are kept.
2. **Along the duct network.** Two ducts whose closed body boxes touch or overlap are joined where their axes come closest: crossing axes are each clamped to the other's fixed coordinate; parallel axes meet at the middle of their overlap (rounded down) or at their nearest ends. A riser is just a duct turned a quarter about the plate normal. Dijkstra over the junction points finds the shortest path along axes (costs with `Math.sqrt`, ties by vertex index).
3. **Out to the other terminal.** Candidate pairs are tried in order of their combined rank (at most 16); the first whose stored polyline is distinct point to point and clear of every body (`routeCollision`, exactly the command's check, §4) wins. Each vertex becomes a `duct` waypoint on its duct; consecutive repeats are dropped.
4. **Fallbacks.** With no duct, or no clear duct route: the direct line (no waypoints), then a `free` lead-out 50 mm out of each terminal (game-design); otherwise `route-collides` with a message asking for waypoints.

It returns `{ route, lengthMm, floorMm, points }`: explicit waypoints, `routeDefaultLengthMm` of the route's points, `routeFloorMm`, and the points themselves. **It only proposes.** Every surface expands it into explicit waypoints before `exec`, so a logged `wire.add` never holds `auto` and a later change to the router never changes what a log replays to (D5):

- `game.autoRoute(a, b, options)` in `@controls/scripting-api`, taking `"<entityId>:<terminalId>"` or an end object, and an optional `catalog`;
- the console's `--route auto` on `wire.add` (between its two landed ends) and `wire.reroute` (between the connection's landed ends, with their stored methods), registered before `--lengthMm auto` in `CONSOLE_EXPANDERS` so one line can use both;
- the mouse's two-click gesture (F3.2 part 3).

A console file that uses `--route auto` re-pins its hashes when the router changes; a replay log never does. Measured: about 0.38 ms a route on the 512-entity bench panel (`obstacleBoxes` dominates), well inside a click.

### 3. Waypoint snapping and the host rule

`snapWaypoint(world, catalog, cursor, { kinds?, boreTool?, captureMm? })` is the domain snapper every surface uses. A hosted waypoint's `positionMm` is the snapper's point on its host's axis (ADR 0015):

- **`duct`:** the nearest point of a duct's axis, the middle of its trough: (x, ⌊h/2⌋, ⌊d/2⌋) in the duct's frame for x from 0 to its cut length (half-sizes rounded down, so every axis is whole millimetres);
- **`conduit`:** the nearest point of an EMT-lite stick's or connector's axis (between its `racewayPorts`), or the nearer port of an elbow (a mid-bend waypoint would cut the corner);
- **`staple`:** on a stud's face of a `prop.stud-wall` fixture, at the stud's centre line and the cursor's height;
- **`bore`:** on the stud's axis at mid-depth (round(88.9 / 2) = 44 mm behind the face), only when the caller names the bit or hole saw it stores.

The nearest candidate within 40 mm (game-design, the DIN-rail capture band) wins; ties go duct, conduit, staple, bore, then the lower entity id or fixture id and stud. Otherwise the waypoint is `free` at the cursor rounded to whole mm.

**The host rule (`bad-waypoint`, decided here as ADR 0015 asked):** a `duct` waypoint's host is an entity whose catalogue kind is a duct; a `conduit` waypoint's, a conduit part (stick, elbow or connector); a `staple` or `bore` waypoint's, a stud-wall fixture (P3 has no stud entities). Only the host's kind is checked, never whether the position lies on its axis: the snapper puts it there, the floor reads the stored position, and the bake draws it where it is stored plus its lane, so an off-axis waypoint from a hand-written line is a picture problem, not a different circuit. The load check does not apply the rule (it accepts what earlier commands made).

### 4. `route-collides`

The command's check **stays on the stored polyline's straight segments** (terminal entry points and waypoints, the floor's point set), tested against the catalogue `sizeMm` bodies (`obstacleBoxes`: `deviceBodySizeMm` boxes of devices and built-in props, quarter-turn exact, the conservative cube otherwise; enclosures and raceways hollow), skipping the entities at each segment's own ends. It moved into `routing/collide.ts` as `routeCollision`, which the command (`checkCollisions`) and the auto-router share, so the router never proposes a route a command refuses. **The bake's lead-outs, lanes and sag are a picture and are never checked**: a sag that dips into a body is drawn, never refused. This is what "replacing the straight-segment check" means in F3.2 part 1: the check is now defined against the routed polyline that the router produces, rather than an interim one; checking the drawn shape would make a picture setting (the sag cap, the lane pitch) decide which logged commands replay.

### 5. The length rule (D5)

- **The floor** is unchanged: `routeFloorMm(points) = ceil(Σ √(Δx² + Δy² + Δz²))` over the terminal entry points and waypoints (save format from v0.4.0, ADR 0015).
- **The default** is unchanged: `routeDefaultLengthMm = floor + ceil(floor × ROUTE_SLACK_PERCENT / 100) + tails.a + tails.b`, whole millimetres, never below the floor.
- **The slack allowance is game-design, and says so.** `ROUTE_SLACK_PERCENT` stays 5 %. Neither the P3 source pre-audit nor this ADR found a vetted public source for a cutting allowance along a route (as a percentage or otherwise); estimating guides add waste factors for purchasing, which is a different quantity, and NFPA 70 sets free-conductor lengths at boxes (Art. 300.14, cited by number, which `DEFAULT_CABLE_TAIL_MM` already follows), not along a route. So the allowance is labelled `game-design` and listed for `electrical-realism-reviewer`. Because `lengthMm` is a logged argument, a reviewed value later changes only what `--lengthMm auto` and the router propose, never a replay.
- **No termination allowance is added** for a single conductor: the strip length lives inside the clamp at the terminal entry point, and ADR 0010's lead-out is a drawing offset.
- **Cable tails:** the reach rule (`d² ≤ tailsMm[end]²`) is **not** tightened here; F3.2 part 4 (cables, staples, jacket) owns cable shapes and may tighten it before v0.4.0.

Hand-measured golden (`auto-route.spec.ts`): on the raceway-panel scenario's parts, two screw blocks at x = −69 and −63 on rail 1 drop from terminal b (−66 and −60, 126, 52) into the duct below, whose axis is y = 90, z = 44: each drop is √(36² + 8²) = √1360 = 36.878 mm, the run 6 mm, so 79.757 mm, floor 80 mm, default 84 mm, and `wire.add` refuses 79.

### 6. Lanes

Every raceway's occupants are the cables and single conductors with a waypoint hosted on it, ordered **cables by cable id, then single conductors by connection id** (both id spaces, ADR 0015). Each takes the next lane, in integer tenths of a millimetre:

- **A duct** packs lanes across its trough from the inside of one wall, each an occupant's width (a conductor's overall diameter `ceil((d_bare + 2 (insulation + jacket)) × 10)`, from the gauge table and the conductor entry; a cable's jacket width), starting a new layer above the tallest one when a layer is full; a layer past the cover wraps back to the floor (an over-full duct draws overlapping lanes; it never refuses anything; fill rules are P4's inspector).
- **A tube** stacks its occupants along the part's own +z, centred on the axis (constant through an elbow's bend).

Lanes are assigned at bake and never stored, never by collision (ADR 0010: rope-to-rope collision rejected), and are a pure function of the set of (owner, route) pairs and the catalogue. Properties (`lanes.spec.ts`): the same lanes, and the same centreline hash, whatever order `world.connections` lists the wires in, and whatever order the same (id, route) pairs were inserted in.

### 7. The analytic bake (deviation from ADR 0010)

`bakeWorldRoutes(world, catalog)` draws every routed single conductor (connection id order) and every cable (cable id order) as a quantised polyline:

1. **Nodes:** a landed end's method entry point and a **straight lead-out** of 12 mm along its exit axis (ADR 0010's pin); each waypoint, moved onto its lane if it is a duct or conduit waypoint on a part of that kind; the other end. A cable runs between its entry points; its tails and its conductors' tails are F3.2 part 4's.
2. **Taut inside raceways:** consecutive hosted waypoints are one taut segment, along one part (an elbow's legs and a quarter circle drawn from literal 15° cosines, never `Math.cos`) or across a joint or a duct junction.
3. **Sag on free spans:** the cut length beyond the taut drawn length is shared by the free spans in proportion to their chords, at most **1 %** of each chord (game-design from ADR 0010's measurement: 3 % sagged 55 mm on a 300 mm span, "too much for panel wiring"); then raceway runs take up to **10 %** of their length out of sight; what is left is drawn as a **coil** at the middle of the longest free span only when it is more than **20 %** of the cut length (a deliberately long cut, such as 30 m on a 1 m route), and is not drawn otherwise. A span with extra e over chord c sags a parabola of depth h = √(3 c e / 8) (ADR 0015's formula; never `cosh` or `asinh`), towards −y across the chord (+z for a vertical chord), sampled every 15 mm (at most 32 segments; ADR 0010's spacing). Below 0.05 mm it is drawn taut.
4. **Quantised:** every coordinate is rounded to an integer number of tenths of a millimetre; consecutive equal points are dropped.

The output per route is `{ owner, points (flat x, y, z in tenths), coil | null }`; `centrelineHash` is SHA-256 of its canonical JSON. **The drawn length is a picture; `lengthMm` is what is wired.** Nothing of the bake is stored or in any world, snapshot or topology hash.

**Why a deviation.** ADR 0010 asked for a fixed-step rope bake so the result would be a pure function of the arguments. The analytic bake is also a pure function of the world, needs no particle count or step count, runs in microseconds per wire instead of milliseconds, and its maths uses only operations ECMAScript rounds exactly, which a 200-step Verlet loop also does but at about 2 000 times the cost. Verlet stays for the renderer's live preview only (F3.2 part 2/3), never persisted or hashed. Rejected: a fixed-step Verlet bake in domain code (D5).

### 8. Which entry a conduit connector occupies: derived, not stored

**Decision: routing derives it, and storage (if any) stays with F3.4 part 2's `wire.pull`.** `connectorEntries` says a connector is in an entry exactly when, in integer world geometry, its `entry` port is the entry's world point, that port points along the entry's inward axis, their trade sizes are equal, and the entry is open. The save-format caveats' three ambiguous cases each get one answer:

- **(a) two connectors on one entry** (a script's `entity.place` allows it): the lowest entity id is in it, the others in none;
- **(b) a connector at a closed entry, or at one of another trade size:** in none;
- **(c) an enclosure moved away from its connectors:** in none.

Why this is enough for F3.2: routing reads it only to **propose** (where a pulled run meets a box). A logged route carries its waypoints explicitly (`conduit` waypoints on the parts, `free` rest waypoints at the ends), no command reads the derivation, and the bake draws stored waypoints, so the rule can't change what a log replays to. What still needs storage, or a rule frozen as save format, is occupancy that **refuses commands**: an enclosure held by its connectors for `entity.move` and `entity.delete`, and an entry's room for `entry-full`. Those are `wire.pull`'s (F3.4 part 2), which must decide before v0.4.0 freezes v3; if it stores the relation, a v3 → v4 step can derive it with exactly these rules. No world field is added now.

### 9. Pickers (design; implemented in F3.2 part 3)

- **Terminals** are data points (`terminalPlace`: entry point and exit axis), never meshes. The renderer picks in screen space: the nearest projected entry point within `min(16 px, pitch / 2)`, filtered by occlusion with the existing BVH picker (the ray's first hit must be the terminal's own device, within a tolerance), with the would-be pick highlighted before the click. Where a device's terminal pitch is under 24 CSS px (WCAG 2.2 2.5.8), the hover offers a one-key zoom (`view.focus` on the device). Keyboard: with a device focused, Tab and Shift+Tab cycle its terminals (and its entries and mounts, ADR 0015), Enter picks.
- **Waypoints:** the pointer ray hits a fixture face or a raceway body (BVH); the hit point, rounded, goes to `snapWaypoint`, and the ghost shows the snapped waypoint and its kind. Backspace removes the last waypoint, Esc cancels. Two clicks with no waypoint use `autoRoute`.
- **Wires:** a BVH over baked segment bounds, with an exact ray-to-capsule test whose radius is widened to at least 4 px on screen (ADR 0010: brute force cost 1 to 2 ms at 200 wires).
- The live rope (Verlet) is drawn from the proposed route while the gesture is open; the committed command carries the explicit waypoints and the default length (or the length a prompt set).

### 10. Goldens and the budget

- **Cross-runtime parity:** `routingDigests(world)` = `{ centreline: centrelineHash(bake), proposals: SHA-256 of autoRoute between every routed conductor's landed ends and snapWaypoint at a point off each raceway's axis midpoint }`. `routing/parity.spec.ts` pins both for the routing panel (`world-model/src/testing/routing-panel.ts`: two ducts, a riser, twenty blocks, eight wires) in `libs/domain/world-model/goldens/routing/`; `apps/game-e2e/src/routing-parity.spec.ts` computes them in Chromium through the `?e2e=1` hook (`routingDigests(json)`) and expects the same files.
- **`route-bake-500-wires`** (`sim bench`, `apps/sim-cli/src/bench/route-bake.ts`): the bake of a panel of ten rows of fifty 4 mm² screw blocks, eleven ducts and a riser, with 500 auto-routed wires (block i's top clamp to block (7i + 13) mod 500's bottom clamp, most through the riser); 6 377 baked points. **Measured 1.92 ms median, p90 2.59 ms, p99 3.37 ms** (21 runs after 3 warm-ups, the developer's desktop under `sim bench`, 2026-11-12): about 3.8 µs a wire, against ADR 0010's 8 ms. **Budget: 16 ms**, one 60 Hz frame, so loading or rebuilding every wire fits in a frame, with 8× headroom over the measurement (more than CI's 5× runner spread). Uncalibrated (a load-time ceiling). Its `--smoke` form bakes one row (50 wires): `prepare` now receives the smoke flag (a harness addition), and the whole `bench --smoke` stays at about 3.6 s. The centreline hash is the case's untimed checksum. Building the panel (untimed) takes about 0.46 s.

## Persisted surface (for `save-format-guardian`)

- **World v3 fields:** none added, removed or changed. **`wire.add` (and every other) argument shape:** unchanged; no frozen `json-schema/command-args/*.args.schema.json` changed.
- **One command-semantics change, refusing more:** the host rule (§3) makes `wire.add`, `wire.reroute`, `wire.pull`, `cable.add` and `cable.reroute` refuse a hosted waypoint on the wrong kind of host as `bad-waypoint`. ADR 0015 implementation note 5 reserved exactly this for ADR 0017. A refusal is never logged, so no log can contain such an entry unless an earlier build accepted it: world v3 is unreleased (provisional until v0.4.0) and no shipped scenario or fixture logs a hosted waypoint (the v3 fixtures that hold one are world documents, which the load check still accepts). Four tests in two world-model specs (`wire-commands.spec.ts`, `wiring/properties.spec.ts`) used arbitrary hosts and were moved onto real ones (a stud-wall fixture and an EMT stick, `wiringBench`'s new `extras`).
- **`routeFloorMm` and `routeDefaultLengthMm`:** unchanged, so no `--lengthMm auto` result moves.
- **Not persisted, not hashed:** the baked centreline, lanes, coils, the router's proposals and the snapper's points. Their goldens (§10) are test goldens, not save format; a routing change re-pins them and console files that use `--route auto`, never a replay log.
- **Hashes:** no world hash, scenario hash, fixture or `.ctrl` moved. New pins: the two routing digests, and `scripting-api/src/lib/routing.spec.ts`'s hash of a panel wired by `--route auto` (`16da996f…`).
- **Connector-in-entry:** derived, not stored (§8).

## Deviations from the plan and earlier ADRs

1. **ADR 0010 "What P3 must build" item 3:** the bake is analytic, not a fixed-step Verlet rope (D5).
2. **The plan's "`route-collides` against catalogue `sizeMm` boxes, replacing the straight-segment check":** the check stays on the stored polyline's straight segments against `sizeMm` bodies, now shared with the router; the drawn shape is never checked (§4).
3. **The plan's "a sourced slack allowance":** no citable source exists, so the 5 % allowance is labelled game-design and listed for review (§5).
4. **ADR 0015 "Duct lanes are ordered by cable occupants by cable id, then single conductors by connection id":** kept exactly.

## Consequences

- F3.2 part 2 (the wire renderer) draws `bakeWorldRoutes`' polylines as instanced segments and coils; part 3 binds the pickers and gestures to `autoRoute` and `snapWaypoint`; part 4 bakes cable tails and staples and may tighten the tail-reach rule.
- `wire.pull` (F3.4 part 2) decides whether to store connector occupancy, using §8's rules.
- A routing change moves the routing goldens, the `--route auto` console spec's hash and the bench checksum, never a replay.
- The ADR 0010 manual routing protocol runs after F3.2 part 3; its results amend this ADR.

## Alternatives considered

- **A fixed-step Verlet bake in domain code** (ADR 0010): deterministic but about 8 ms a wire; rejected by D5.
- **A catenary sag:** needs `cosh`/`asinh`, which ECMAScript doesn't pin across engines (D6); the parabola is within a few per cent at panel sags.
- **Checking `route-collides` against the drawn shape:** a picture setting would decide which commands replay.
- **Storing lanes:** they follow from ids and routes; storing them would let a save disagree with its own routes.
- **Storing connector occupancy now:** nothing in F3.2 refuses on it; the command that does (`wire.pull`) should own the field and its migration.
- _*A* over a grid for free routing:_* no grid exists in the world model, and panel wiring follows ducts; free routes stay explicit waypoints.
- **Snapping hosted waypoints off-axis as well (a duct's slot):** finger slots are drawn, not modelled (F3.5 part 2); the axis keeps the floor simple and integer.

## Review

Pending: `save-format-guardian` (persisted surface, host rule, connector decision) and `test-engineer` (goldens, parity e2e, bench budget and smoke form). `electrical-realism-reviewer`: the 5 % slack allowance (game-design).
