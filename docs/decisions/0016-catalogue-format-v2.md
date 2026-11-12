# ADR 0016: Catalogue format v2 and `catalogVersion` 2

**Status:** Accepted (2026-11-11). P3 PR 6, the catalogue v2 kickoff PR (decision D3). `catalogVersion` 2 stays provisional until v0.4.0 ships, then it is frozen.
**Review:** `save-format-guardian` and `electrical-realism-reviewer` approved with changes, all applied (see [Review](#review)).
**Date:** 2026-11-11 (Phase 3)
**Sources:** [phase 3 plan](../../plans/phase-3-wiring.md) decisions D3, D6, D10 and D11, the "Catalogue format v2" kickoff section and F3.1; [ADR 0015](0015-world-document-v3.md) ("`catalogVersion` 2", terminal method specs, enclosure entries and mounts, cable assemblies, colours, tool capabilities, accessories, the content-designer review); [ADR 0013](0013-world-document-v2.md) (catalogue v1, `MODEL_KINDS`); [ADR 0004](0004-save-format.md) (saves reference entries); [ADR 0003](0003-licence-policy.md) (no NEC text or tables); the P3 source pre-audit by `electrical-realism-reviewer` (2026-11-11), whose vetted values and must-avoid list this ADR follows

## Context

Catalogue v1 (ADR 0013) describes P2's bench devices: a model kind, numeric parameters, terminals where a test lead's clip lands, controls and sources. P3 puts real wiring on top of it, and ADR 0015 fixed what world v3 will reference: per-method termination specs on terminals, enclosure mounts and entries, cable assemblies whose conductors a save indexes, tools checked by capability with stable hole and die ids, accessories, and colours as ids from an append-only table. Conductors need shared physical data (copper and aluminium, insulation types) that many entries pin and that must not drift under old saves.

This ADR records the catalogue format that carries all of it, what changes for the P2 entries, and the versioning rules. The P3 products themselves (THHN, MTW, XHHW-2, NM-B, boxes, tools, ferrules) arrive in later PRs (F3.1, F3.3, F3.4, F3.5); this PR proves the shapes on test-only fixtures.

## Decision

### One namespace, four families, and tables

A `CatalogRef` `{ id, version }` names at most one entry of the whole catalogue. Families are told apart by id prefix, enforced at load:

| Family      | Ids                                                                 | Files                                     | Schema                |
| ----------- | ------------------------------------------------------------------- | ----------------------------------------- | --------------------- |
| `device`    | any prefix but the reserved ones; `conductor.*` for conductors only | `content/devices/<id>.v<n>.json`          | `DeviceDefinition`    |
| `cable`     | `cable.*`                                                           | `content/cables/` (from F3.1 part 2)      | `CableDefinition`     |
| `tool`      | `tool.*`                                                            | `content/tools/` (from F3.4 part 1)       | `ToolDefinition`      |
| `accessory` | `ferrule.*` (ferrules), `lug.*` (ring and fork lugs)                | `content/accessories/` (from F3.3 part 1) | `AccessoryDefinition` |

`prop.*` stays reserved for the built-in props. Devices include everything with a model kind: placed devices, enclosures (an enclosure kind), leads and conductors (connection kinds). `Catalog.family(ref)` says which family a ref resolves to, so a command decides `not-a-cable` or `unknown-tool` by what the ref is, never by its spelling.

**Tables** are not entries. Each table version is a file `content/tables/<table>.v<n>.json` (`TableDocument`: `{ table, version, title, rows, sources, extensions }`), and entries pin a row by **`TableRef` `{ table, version, key }`**. The table kinds are a registry in code (`TABLE_KINDS`), each with its row schema, its key grammar and the fields that need a source. Catalogue 2 ships three:

- **`materials` v1**: `copperAnnealed` (IACS) and `aluminiumAa8000` (the 8000-series building-wire alloy at 61.0 % IACS): conductivity, ρ₀ and α at T₀, the top of the linear-α range (the engine's R(T) clamp, D7), density, specific heat.
- **`insulation` v1**: `thhnThwn2`, `mtw`, `xhhw2`, `nmbJacket`: dry and wet temperature ratings (wet `null` where not rated), thermal conductivity of the insulation and of an outer jacket layer (`null` for one layer), surface emissivity. Insulation **thickness is product data, stored per conductor entry** (the pre-audit's rule: diameters are derived per entry, and no size-to-thickness column is reproduced).
- **`colours` v1**: twelve ids with a name and a display sRGB value (`bare`, `black`, `blue`, `brown`, `green`, `grey`, `orange`, `pink`, `purple`, `red`, `white`, `yellow`).

All files under `content/tables/` are mirrored into `builtin-tables.generated.ts`, staleness-checked like the devices. Cables, tools and accessories get their mirror rows when their first real entries land.

### The device entry, v2

`DeviceDefinition` keeps every v1 field and gains, with no field optional (absent is `null` or `[]`):

- **`terminals[].methods: TerminalMethodSpec[]`**, possibly empty (a clip-only terminal: `wire.land` is refused, `wrong-method`). A spec is `{ method, ratedConductors, maxConductors, awgRange: { smallest, largest }, stranding, stripLengthMm: { nominal, tolerance }, torqueNm, alRated, entryMm, exitAxis }` exactly as ADR 0015 lists it. `method` comes from the **`TERMINATION_METHODS` registry** (`screw`, `springCage`, `backStab`, `twistOn`; each says whether it is clamped to a torque and which accessories it takes); it is unique within the terminal; `torqueNm` is non-null exactly for a clamp-torque method. **The order of a terminal's methods is save format** (`'auto'` takes the first).
- **`mounts: { type, widthMm }[]`**: the mount types the device fits (D11), each once, from the **`MOUNT_TYPES` registry** (`din35`, `backplate`, `deviceYoke`, `studFlange`; each with an occupancy rule, `single`, `linear` or `area`, for `mount-full`). A connection mounts on nothing.
- **`enclosure: { mounts, entries, interiorVolumeMm3 } | null`**, present exactly for a model kind that `requires: 'enclosure'` (such a kind must declare the commanded number key `openEntries`, ADR 0015). A mount is `{ id, type, positionMm, axis, facing, extentMm }`; an entry is `{ id, type, tradeSize, maxCables, internalClamp, positionMm, axis }`, `type` from the **`ENTRY_TYPES` registry** (`knockout`, `pryout`, `clamp`, `drillSite`, each naming the tool capabilities that open it). At most 32 entries, and **their order is save format** (bit _i_ of `openEntries`). Terminal, mount and entry ids are unique together within the entry.
- **`conductor: ConductorSpec | null`**, present exactly for a model kind that `requires: 'conductor'` (a connection kind, F3.1): `{ awg, stranding, strandCount, material: TableRef, insulation: TableRef | null, insulationThicknessMm, colours: { base, stripe }[] }`. A bare conductor (`insulation: null`) is made in `bare` only, and `bare` appears on no insulated conductor. The model's numeric parameters stay in `model.params`.
- Categories `conductor` and `enclosure` join `lead`, `source`, `load`, `switch` and `protection`; `lead` and `conductor` go with connection kinds only, `conductor` and `enclosure` with their kinds only.

`ModelKindDef` gains an optional `requires: 'conductor' | 'enclosure'`; no P2 kind sets it.

### Gauges: one table, integer designations

AWG sizes are integer designations everywhere a catalogue entry or a save names them: 18, 14, …, 1, then **1/0 = 0, 2/0 = −1, 3/0 = −2, 4/0 = −3**. `AwgRange` is `{ smallest, largest }` with `smallest ≥ largest` (the thinnest conductor has the larger number). Every gauge check compares these integers; none compares floating-point areas. The catalogue's **one gauge table**, `AWG_GAUGES` in code (4/0 to 40), carries each size's name, diameter and area, computed from the AWG definition d = 0.127 mm × 92^((36 − n)/39) (NBS Handbook 100 §2) and rounded to six significant figures; `gauge.spec.ts` recomputes every row. It lives in code, not in `content/tables/`, because it is a definition rather than measured data and every family's validation needs it without loading a table.

### Cables, tools and accessories

- **`CableDefinition`** `{ id, version, title, brand, modelName, conductors, jacket, sources, extensions }`. `conductors[i]` is `{ index, conductor: CatalogRef, role: 'ungrounded' | 'grounded' | 'egc', insulated, colour }`; `index` must equal `i`, **the order is save format** (`ConnectionV3.cable.conductor`), the ref is pinned to a conductor entry of the same catalogue, `insulated` matches it and `colour` is one it is made in. `jacket` is `{ material: TableRef (insulation), colour, thicknessMm, widthMm, heightMm }`.
- **`ToolDefinition`** `{ id, version, title, brand, modelName, kind, capabilities, holes, dies, torque, boreDiameterMm, sources, extensions }`. `kind` is D10's list (for the belt and the UI); `capabilities: { step, maxAwg | null }[]` with `step` from `cut | strip | stripJacket | crimp | drive | torque | openEntry | bore | pull | label`, each once. A tool has holes `{ id, awg, stranding }` exactly when it can `strip`, dies `{ id, label, awgRange }` exactly when it can `crimp`, a `torque` range and accuracy exactly when it can `torque`, and a `boreDiameterMm` exactly when it can `bore` (one entry per bit or saw size). **Hole and die ids are save format per tool entry version.**
- **`AccessoryDefinition`** `{ id, version, title, brand, modelName, kind: 'ferrule' | 'ringLug' | 'forkLug', awgRange, stranding, dies, barrelLengthMm, studDiameterMm, sources, extensions }`; `dies` lists the die ids that crimp it, and `studDiameterMm` is `null` exactly for a ferrule.

### Sources and coverage

`DeviceSource` becomes `CatalogSource`, shared by every family and table (the old name stays as an alias). Its `covers` paths are dotted segments, and a cover covers its own path and everything below it; a `*` segment (not the first) matches any one segment, so `terminals.*.methods.screw` covers both terminals' screw specs and `rows.*.srgb` a whole column. **The bare `terminals` path is the terminal layout and covers nothing below it**, so a game-design layout source never silently covers a torque. The paths an entry needs:

| Family    | Paths                                                                                                                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| device    | `model.params.<name>`, `sizeMm`, `terminals`, `terminals.<id>.methods.<method>.<field>` (every spec field but `method`; `torqueNm` when non-null), `fits.<mountType>`, `mounts.<id>`, `entries.<id>`, `interiorVolumeMm3`, `conductor.<field>` |
| cable     | `conductors.<index>`, `jacket.<field>`                                                                                                                                                                                                         |
| tool      | `capabilities`, `holes.<id>`, `dies.<id>`, `torque`, `boreDiameterMm`                                                                                                                                                                          |
| accessory | `awgRange`, `stranding`, `dies`, `barrelLengthMm`, `studDiameterMm`                                                                                                                                                                            |
| table     | `rows.<key>.<field>` for each field the table kind marks as sourced                                                                                                                                                                            |

A cover that covers nothing the entry has is refused, as in v1. ADR 0015 named `mounts.<id>` and `entries.<id>` for an enclosure's mounts and entries; a device's own mount declarations, which have no id, use **`fits.<type>`** so the two can't be confused. Game-design constants of later PRs (`defaultTailsMm`, `MAX_ROUTE_WAYPOINTS`, `MAX_CONDUCTOR_LENGTH_MM`) are code constants with game-design sources, not catalogue data.

### Region colour rules

`RegionProfile.conductorColours` holds the region's identification rules over colour ids, for P4's inspector; it is never part of the load check and says nothing about products. For NEC (cited as NFPA 70-2023 by article number, paraphrased, no text reproduced): grounded conductors white or grey, or a white or grey stripe on any base but green (200.6); equipment grounding conductors bare, green, or green with yellow (250.119); white, grey and green not for ungrounded conductors (200.7, 250.119); ungrounded colours by system, **labelled convention, not code** (black and red for 120/240 V; black, red and blue for 208Y/120 V; brown, orange and yellow for 480Y/277 V), with 210.5(C) and 215.12(C) cited for the posting requirement; the high leg's orange marking (110.15). `matchesColourRule` checks a colour against a rule. The world stores one stripe per conductor, so the code's "three continuous stripes" is one stripe id.

### The P2 entries in catalogue 2

Every P2 entry **keeps entry version 1**: it only gains data, and no existing value changes (ADR 0015's rule).

- **Termination methods only where a conductor really lands.** The 15 A breaker's `load` and the DIN supply's `neg` and `pos` get a `screw` method from their product classes (CU/AL 14–10 AWG at a marked 4.0 N·m, the panelboard branch-breaker class; copper 24–12 AWG at 0.5 N·m with ferrules). The breaker's `line` gets the same values as a game-design stand-in: that class's line side is a bus stab, not a wire screw. The split-phase service's `l1`, `l2` and `n` get a game-design `screw` method, because it is the stand-in supply of D12's demo circuit (labelled as standing in for P4's load centre). Every other terminal is clip-only (`methods: []`): the W5W lamp, the resistor's lugs, the fuse holder, the battery's tabs, the bench supply's binding posts, the switch and heater bases and the headless three-phase services.
- **DIN mounts**: the breaker and the DIN supply declare `din35`, each 40 mm along the rail (the supply's real body width; the breaker's base width, game-design, since a real one-pole DIN breaker is one 17.5–18 mm module and resizing the base would be a new entry version).
- **Text-only fixes:** the test lead's copper source now says the IEC adopted the annealed copper standard in 1913 (1925 is a revised edition); the lamp's time-constant source no longer claims 0.4 mJ/K and states the engine-6 model's 0.34 mJ/K against the 0.17–0.27 mJ/K physics estimate (the P2 follow-up). No value changed.

### The lead kind's connection keys

The `lead` kind registers ADR 0015's ten sim keys (`conductorTempK`, `endATempK`, `endBTempK`, `endADegradation`, `endBDegradation`, `endATerminationId`, `endBTerminationId`, `endAState`, `endBState`, `insulationDamaged`) as `CONNECTION_SIM_KEYS`, shared by F3.1's `conductor` kind, and exports `connection-state.lead.schema.json`. World v2 connections carry no bags, so the keys mean nothing to a v2 save; they enter saves with world v3 (PR 7), which is the `schemaVersion` bump ADR 0015 rides them on. They are provisional until v0.4.0 and finalised by ADR 0018.

### Versioning rules

- **A shipped `(id, version)` resolves in every later catalogue version and keeps its values.** Once a release ships an entry or a table version, it is never deleted and no value in it changes; it may only gain data (next rule). Prose (`title`, a source's `citation`) may be corrected in place: only people read it, and it is in no hash. Any other change is a new entry or table version beside the old, and only new entry versions pin a new table version. `shipped.spec.ts` pins every shipped ref and its values (`libs/domain/catalog/fixtures/shipped/<release>.json`, taken from the release tag; each release appends its own list).
- **An entry keeps its version when it only gains data** and every existing value is unchanged; behaviour that changes as a result is a `SIM_ENGINE_VERSION` change. From catalogue 2 on, **termination spec values count as electrical** (torque, strip length, counts, gauge range): changing one after v0.4.0 needs a new entry version.
- **Colour ids are append-only** across every version of the colour table (load-checked: a later version must hold every id of the one before); display values may change; and every shipped colour table version stays in the catalogue (pinned by `shipped.spec.ts`).
- **The order of a terminal's methods, an enclosure's entries and a cable's conductors, and the ids of methods, mounts, entries, holes and dies, are save format** once v0.4.0 ships.
- **`catalogVersion` 2 is provisional until v0.4.0**, like `schemaVersion` 3: later P3 PRs add entries and kinds to it without a bump, and fixtures written under it are replaced in the PR that changes it.

### Fixtures under catalogue 2

`engineCompatible` compares the catalogue version by equality, so the engine-6 `.ctrl` fixtures (catalogue 1) now load as `engine-changed`, never refused. Engine-numbered fixtures written from catalogue 2 on are named **`<scenario>-engine-N-catalog-C.ctrl`**, and `apps/sim-cli`'s collision guard checks both numbers; the current pair (`-engine-6-catalog-2`) must load as `continued` and rebuild from its scenario. No `world.hash` moved: the manifest isn't hashed, and no catalogue value the engine reads changed.

## Deviations from the plan and from ADR 0015

1. **Insulation thickness is per conductor entry**, not a table column (the pre-audit's rule; the plan listed "thickness classes" with the insulation data).
2. **The gauge table is code** (`AWG_GAUGES`), computed from the definition, not a `content/tables/` file.
3. **A device's mount declarations are covered by `fits.<type>`**, a path ADR 0015 didn't name.
4. **ADR 0015's mount field `yoke` is replaced** by the mount type's occupancy (`MOUNT_TYPES`) and an explicit frame: `axis` (the mounted device's +x and the sliding direction) and `facing` (its +z), perpendicular. That is the "mount's catalogue frame" ADR 0015's `off-mount` check composes with.
5. **The plan's `content/tools/` loader lands now; its directory and mirror land with F3.4 part 1** (the first real tools), as do `content/cables/` (F3.1 part 2) and `content/accessories/` (F3.3 part 1). An empty directory can't be committed, and the mirror test refuses an unlisted one.
6. **The utility stand-in gets screw terminals now** (game-design), because D12's demo lands NM-B on it.
7. **Aluminium is the AA-8000-series alloy at 61.0 % IACS**, not "EC-grade" as the plan's kickoff step 8 said (the pre-audit's correction).
8. **Clamp geometry for the contact model** (screw diameter, nut-factor class, clamp type, contact material, clamp depth), which ADR 0015 assigns to terminal catalogue data, **is added to `TerminalMethodSpec` by ADR 0018** (F3.3 part 1) at entry version 1 while catalogue 2 is provisional: the contact model decides which fields it needs. So is the twist-on connector's combination bounds (count, AWG, total size).

## Consequences

- `@controls/catalog`: `device.ts` (v2 shapes), `families.ts`, `tables.ts`, `gauge.ts`, `registries.ts` (the method, mount, entry, tool-step, tool-kind and accessory registries, and the `ColourId`, `TerminationMethodId`, `MountId`, `EntryId`, `HoleId`, `DieId`, `TableName`, `TableKey` primitives with ADR 0015's grammar; world v3 (PR 7) defines `ColourId`, `TerminationMethodId`, `MountId`, `EntryId`, `HoleId` and `DieId` in `save-format`'s primitives, the source of truth for persisted grammar, and `@controls/catalog` re-exports them in place of its own copies), `sources.ts`; `parseCatalog(version, devices | { devices, cables, tools, accessories, tables }, kinds)`; `Catalog` gains `cables`, `tools`, `accessories`, `tables`, `family`, `table`, `tableRow`, `colourIds`, `colour`; `CATALOG_VERSION` 2; JSON Schema exports `device.v2`, `cable.v2`, `tool.v2`, `accessory.v2`, `table.v2`, `table-row.<table>` and `connection-state.lead` (`device.v1` removed: the catalogue format isn't save format).
- `content/`: `content/tables/` (three tables), every device file gains the v2 fields.
- Test catalogues in `sim-core` and `world-model` carry the v2 fields (`methods: []`, `mounts: []`, `enclosure: null`, `conductor: null`).
- `apps/sim-cli` and `scripting-api` specs: the catalogue-2 fixture naming, four new fixtures (`sim-step`, `sources`, `bench-lamp`, `protection`, each `-engine-6-catalog-2`); the engine-6 ones are kept.
- Docs: the [authoring guide](../guides/authoring-content.md) (new), the [content caveats](../caveats/content.md) (new), `docs/history.md` (`catalogVersion` 2), the save-format and simulation caveats, the catalog README.

## Review

- **`save-format-guardian` approved with changes (2026-11-11):** the lead kind's ten keys match ADR 0015 exactly (names, types, initial values, owner `sim`). No `schemaVersion` bump here, because no persisted shape changes (world v2 connections carry no bags; the keys enter saves with world v3). `catalogVersion` 2 loads every 0.3.0 save as `engine-changed`, never refused. The id grammars match ADR 0015. Deviations 3, 4 and 8 are accepted. Required changes applied: the shipped-ref test, the versioning and colour wording, and the primitives' home. Recommended changes applied: an explicit `engine-changed` check for each catalogue-1 engine-6 fixture, `parseCatalog` refusing unknown keys in its object form, the `TableKey` example.
- **`electrical-realism-reviewer` (2026-11-11): changes required → applied:** the breaker's line terminal re-attributed as a game-design stand-in for the bus connection (the panelboard class has a bus stab there), with the real-world class source limited to the load terminal and the DIN-mount source saying the terminals follow the panelboard class, not the DIN-rail (UL 489 box-terminal) class. Optional notes applied: the stand-in supply's citation no longer implies a neutral bar takes 4.0 N·m (they are commonly about 2.3 N·m; the value stays, game-design and provisional); the NM-B jacket row's 90 °C is stated as the conductors' rating; the XLPE citation starts with `game-design:`; the 30 m golden's comment reads 0.248565 Ω; content caveats on aluminium building wire starting at 12 AWG (NFPA 70-2023 Art. 310.3(A)) and on a real DIN breaker's 18 mm module; a plan note for ADR 0018 that NM-B's ampacity is limited to its 60 °C rating (Art. 334.80), so derived ampacity never uses 90 °C for NM-B.

## Alternatives considered

- **Optional fields** for the new blocks (`methods?`, `enclosure?`): shorter entries, but the world v3 schema's rule ("absent is `null`") would differ from the catalogue's, and a missing block would be indistinguishable from a forgotten one.
- **A `family` field in every document** instead of id prefixes: explicit, but ADR 0015 chose prefixes so a ref is self-describing in logs and console lines.
- **Tables inlined in entries** (each conductor carrying its own ρ and α): no pinned refs, but a corrected constant would need every conductor entry re-versioned, and two entries could disagree on copper.
- **The gauge table as content**: uniform with the other tables, but every family's validation would need it loaded, and its values are a definition, not data.
- **A `bare`-free colour model** (bare as `colour: null`): one fewer id, but ADR 0015's `ConductorColourV3.base` is non-null and `bare` is what a player sees.
- **Keeping `device.v1.schema.json`**: it would describe a format no code reads; saves never held it.
