# ADR 0020: Catalogue format v3 and `catalogVersion` 3

**Status:** Proposed (2026-11-17); revised after both reviews requested changes (2026-11-17). P4 PR 6, the catalogue v3 kickoff PR (decision D2). `catalogVersion` 3 stays provisional until v0.5.0 ships, then it is frozen with `schemaVersion` 4, `SIM_ENGINE_VERSION` 8 and `SIM_PROTOCOL_VERSION` 8 (ADR 0019 "Versions").
**Review:** both reviews requested changes (2026-11-17), all applied: `electrical-realism-reviewer` (R1 250.148(C)'s trigger, R2 210.11(C)(1)'s 20 A circuits and scope, R3 the 1-15P rows accepted and the plan corrected, R4 no maker URL in content) and `save-format-guardian` (S1 free versus neutral v3 fields in the shipped check, S2 ADR 0019 amended; the follow-ups below). Re-review requested from `save-format-guardian` (the persisted grammars, the key types, the shipped mask, the fixtures; see [For review](#for-review)) and `electrical-realism-reviewer` (every value in [Values for the realism review](#values-for-the-realism-review)). Written by `content-designer`.
**Date:** 2026-11-17 (Phase 4)
**Sources:** [phase 4 plan](../../plans/phase-4-residential.md) decisions D2, D3, D7, D8, D12–D14, the "Catalogue format v3" kickoff section, the [pre-audit outcome](../../plans/phase-4-residential.md#pre-audit-outcome-2026-11-17) and Q1/Q2 (decided: fill is reported, not judged; NFPA 70-2023 by article number only); [ADR 0019](0019-world-document-v4.md) "`catalogVersion` 3: what this ADR depends on" and its review items C1–C12, R1–R5; [ADR 0016](0016-catalogue-format-v2.md) (catalogue v2, the template); [ADR 0013](0013-world-document-v2.md) (`MODEL_KINDS`); [ADR 0004](0004-save-format.md) (saves reference entries); [ADR 0003](0003-licence-policy.md) (no NEC text or tables); the [content](../caveats/content.md) and [save-format](../caveats/save-format.md) caveats.

## Context

Catalogue v2 (ADR 0016, frozen by v0.4.0) describes what P3 wires: termination specs, mounts, enclosures, conductors, cables, tools and accessories. ADR 0019 fixed what world v4 and engine 8 read from the catalogue for P4's house: contacts a mounted device makes with its host (a breaker on a bus stab, a bulb in an E26 socket, a yoke on a metal box, a main bonding jumper), plugs and outlets, momentary buttons, a panel directory, area uses, and the data only the inspector reads (what a terminal is for, a box's marked volume and material, a terminal's two-conductor cap). This ADR records the format that carries all of it, the inspector's rule-set family, the registries, the region data for GFCI and AFCI protection, what changes for the shipped entries, and the versioning rules.

The P4 products themselves (breakers, the load centre, wiring devices, bulbs, appliances, metal boxes, the ground rod, the service) arrive in later PRs (10, 12–15); this PR proves the shapes on test-only fixtures and ships one new entry version (`tb.quennick-st4@2`) and the seed rule set.

## Decision

### `catalogVersion` 3

`CATALOG_VERSION` is 3, provisional until v0.5.0: later P4 PRs add entries, kinds, rows and rules to it without a bump, and fixtures written under it are replaced in place in the PR that changes them (the P3 rule). Every save this build writes records catalogue 3.

- **Fixtures.** `engineCompatible` compares the catalogue version by equality, so 0.4.0's `*-engine-7-catalog-2.ctrl` saves now load as `engine-changed`, never refused (a new test in `apps/sim-cli/src/sources.spec.ts` loads every one). This build's fixtures are the twelve new `*-engine-7-catalog-3.ctrl` (written by each scenario's `pnpm sim run … --save` line, rebuilt byte-identical by the collision guard); engine 8 (PR 9) replaces them with `-engine-8-catalog-3` ones (ADR 0019).
- **No hash moved.** The manifest isn't hashed, no value the engine reads changed, and every scenario places the version-1 block; `SOURCES_HASH` and every other pin are unchanged.

### Terminals: role, side, access

`DeviceTerminal` gains three required fields.

- **`role`**: `ungrounded | grounded | egc | traveller | common | line | load | null` (`TERMINAL_ROLES`), what the terminal is for, in NFPA 70-2023 Art. 100's words (cited by number) and switch practice. **Read by the inspector only, never by the simulator**, which joins what is landed whatever a terminal is called.
- **`side`**: `line | load | null`, a GFCI device's supply or downstream pair. The inspector traces protection through it; the engine's GFCI model takes its pairs from the kind's terminal ids, not from `side`.
- **`access`**: `land | clip | none` (ADR 0019 C5). `land`: conductors land on it (a lead's clip fits too); `clip`: only a lead's clip (no methods); `none`: nothing from outside (a plug's blade, a slot behind a face), and `lead.connect` refuses it (`inaccessible`, the commands PR). Load rule: **a terminal is `land` exactly when it has methods.**

All three are part of the terminal layout and covered by the `terminals` path (which covers only the layout, ADR 0016).

### Terminal families

`ModelKindDef.terminalFamilies?: { prefix, min, max }[]` (ADR 0019 C3): an entry of such a kind has `prefix`1 … `prefix`n for one n in `[min, max]`, with no gap, besides the kind's fixed `terminals` (a load centre's neutral bar, `n1` … `n<k>` with k from 1 to 64; ADR 0019's P4 PR 14 amendment). Without families the rule is ADR 0016's: exactly the kind's terminals.

### The multi-conductor cap and `tb.quennick-st4@2`

`TerminalMethodSpec.multiConductor: { awgRange, equalSize } | null` (the carried P3 item): when two or more conductors are landed by that method, each must lie in `awgRange` and, if `equalSize`, all be the same size. Non-null only with `maxConductors ≥ 2`, inside the method's own `awgRange`, coverage `terminals.<id>.methods.<method>.multiConductor`. `null` on every catalogue-2 spec. It is a termination spec value, so electrical (ADR 0016).

**`tb.quennick-st4@2`** is version 1 with the cap `{ awgRange: { smallest: 22, largest: 16 }, equalSize: true }` on both clamps: the 4 mm² screw class takes two conductors only of equal size and only up to 1.5 mm², and 16 AWG (1.3087 mm²) is the largest AWG size at or under it (15 AWG is 1.6502 mm²; recomputed in `builtin.spec.ts`). **`@1` is unchanged** (two of any size) and gains `supersededBy: tb.quennick-st4@2`, so 0.4.0 saves keep loading and simulating what they did. The tool belt already offers each id at its newest version, so new blocks are `@2`. Enforcing the cap at `wire.land` is the commands PR's (below).

### Mount contacts, anchors and host mounts

ADR 0019 "What the netlist compiler reads" 1–2, C1, R1–R5.

- **`MOUNT_TYPES` rows gain `hostContacts` and `bus`**, and the P4 rows land: `busStab` (linear, `bus: true`, host contact `stab`), `mainFeed` (single; `l1`, `l2`), `mbj` (single; `neutral`, `chassis`), `groundBarKit` (single; `chassis`), `e26` (single; `shell`, `centre`). `deviceYoke` gains the host contact `chassis` (a yoke's screws on a metal box). `din35`, `backplate` and `studFlange` offer none. Host contact ids are append-only.
- **A device's fit** (`DeviceMount`) gains **`contacts: { id, terminal, host, positionOffset, contactOhm }[]`**: the device terminal, the host contact it touches (one of its type's `hostContacts`), the whole stab positions along a bus from its own (line 1 → 0, line 2 → 1; 0 off a bus) and the contact's resistance. Contact ids are unique within the fit and are what the compiled branch's `ElementRef` carries and `topologyHash` hashes (ADR 0019 §8).
- **A host's mount** (`EnclosureMount`, also in `hostMounts`) gains **`contacts: { id, terminal }[]`** (which host contacts it offers, each mapped to one of its terminals; `[]` offers none, so a yoke on a nonmetallic box bonds nothing) and **`bus: { pitchMm, stabs, legs } | null`**: on a `busStab` mount, stab k sits at k × `pitchMm` along the mount (looked up exactly by world-model's `busStabIndex`, never divided out) and reaches `legs[k mod 2]`, so each column alternates legs by row. A column counted the other way lists its legs the other way round. A bus mount maps its stabs through `bus`, never through `contacts`; `(stabs − 1) × pitchMm` lies within `extentMm`.
- **The anchor** (R4): `DeviceMount.alongMm` (new) and `crossMm` place a device's origin from a `single` mount's origin, so different bulbs share an E26 socket's axis. `alongMm` is 0 off a single mount; `crossMm` is 0 on an area mount (it was 0 everywhere but linear mounts). Every catalogue-2 fit declares 0.
- **`DeviceDefinition.hostMounts`** (R5): the mounts a device that isn't an enclosure offers (a lampholder's `e26`), in the same `EnclosureMount` shape, ids unique with its terminals, coverage `mounts.<id>`. `[]` on an enclosure, whose mounts stay `enclosure.mounts`; **`offeredMounts(device)`** reads either. `enclosure !== null` keeps meaning "is an enclosure" everywhere it is read (the renderer, route collisions, entries).

### Enclosures: marked volume, material, spaces

`EnclosureSpec` gains **`markedVolumeMm3`** (the maker's marking, UL 514A/514C by number; `null` where none is stated, every catalogue-2 box, and only where there is an interior volume), **`material: steel | nonmetallic`** (required: the inspector expects a metal enclosure to be bonded) and **`spaces: { mount, index }[]`** (a load centre's panel spaces in order, at most 42: space n is `spaces[n − 1]`, a stab of one of its bus mounts, each once). The shipped boxes and panel gain their materials from their own product-class sources (steel boxes and panel `steel`, PVC boxes `nonmetallic`), each with a new `material` source; `interiorVolumeMm3` stays the drawn geometry, never a fill allowance.

### Outlets, plugs and `NEMA_CONFIGS`

ADR 0019 C5–C6, D12.

- **`DeviceDefinition.outlets: { id, config, positionMm, contactOhm, pins: { pin, terminal }[] }[]`** (at most 4): each receptacle face, its configuration, the face point plug reach is measured to, each pin-to-slot contact's resistance, and every slot of the configuration mapped once to a methodless terminal. Outlet ids are save format per entry version once shipped (`EntityV4.pluggedInto.outlet`).
- **`DeviceDefinition.plug: { config, cordAwg, cordLengthMm, cordExitMm, pins } | null`**: the cord's size and length (the appliance model derives its resistance, D12), where it leaves the body, and every blade mapped once to a methodless terminal.
- **`NEMA_CONFIGS`** (registry, NEMA WD 6 by number): `1-15P`, `5-15P/R`, `5-20P/R`, `6-15P`, `6-20P/R`, `14-30P/R`, `14-50P/R`, each with its form, pins (`hot`, `neutral`, `ground`; `x`, `y` for the 250 V line blades), the rating its designation names, and for a receptacle the plugs it accepts: **5-15R takes 1-15P and 5-15P; 5-20R takes 1-15P, 5-15P and 5-20P; 6-20R takes 6-15P and 6-20P; 14-30R and 14-50R take their own plug only.** `nemaMates(plug, receptacle)` is the `wrong-configuration` check. Geometry and mating only: contact resistance is the outlet's.
- **Load rules:** an outlet's config is a receptacle form and a plug's a plug form; pins are exactly the configuration's; **an entry with a plug fits no mount** (ADR 0019's relaxable rule); a connection has neither.

### `supersededBy`

`DeviceDefinition.supersededBy: CatalogRef | null` (C12): another device entry of the same catalogue, never looping back. The build menu hides a superseded entry and the inspector words its finding "replace". Saves that name it keep loading it. Shipped: `tb.quennick-st4@1 → @2`. The shipped steel boxes, which have no `chassis` terminal, gain theirs when the metal-box entries land (F4.3 part 1).

### State value types and the momentary control

ADR 0019 C7, D7, D14.

- **`text`**: a commanded nullable `LabelText` (printable ASCII, 1–32 characters), initial `null` (`textKey`). **No control type drives one**, so `device.operate` can never set a directory entry.
- **`counter`**: a commanded non-negative safe integer, initial 0 (`counterKey`): a momentary control's press count.
- **`momentary`** control type `{ id, label, type: 'momentary' }`, driving a `counter` key. `checkControlValue` refuses it with "`<id>` is a button: press it with device.press", so `device.operate` refuses a button today (`invalid-value`; the commands PR gives it its own `momentary` code).

No kind in this PR uses them; the P4 kinds that do (the load centre's `directory1` … `directory42`, a GFCI's `test` and `reset`) bring their `device-state.<kind>.schema.json` with them.

### `AREA_USES`

ADR 0019's append-only registry of area uses: `kitchen`, `bathroom`, `garage`, `outdoor`, `laundry`, `bedroom`, `living`, `hall`, `basement`, `crawlSpace` (game-design: the location categories the inspector's rules read, after NFPA 70-2023 210.8(A) and 210.12(B) by number). A new use is a catalogue addition, never a `schemaVersion` bump.

### Rule sets: the `content/rules/` family

D13. One file per rule-set version, `content/rules/<ruleSet>.v<version>.json` (`RuleSetDocument`: `{ ruleSet, version, title, edition, rules, sources, extensions }`), mirrored into `builtin-rules.generated.ts` (the `MIRRORS` row deferred from PR 4) and loaded by `parseCatalog` (`CatalogInput.rules`; `Catalog.ruleSets`, `Catalog.ruleSet(name, version)`). A rule is `{ id, article, title, paraphrase, severity, check }`:

- **`article` is a number only**, in the document's `edition` (`NFPA 70-2023`): `ARTICLE_PATTERN` accepts `240.4(D)`, `314.16(B)(1)`, `100`, never words. **`paraphrase`** is our own short words (at most 300 characters), never the code's text.
- **`severity`**: `violation | warning | report` (`report` has no pass or fail: Q1's box and conduit fill).
- **`check`**: `{ kind, params }` or `null`. **Check kinds are code** in `@controls/inspector` (PR 20), which validates each rule's parameters against its kind; the catalogue checks only the shape. `null` means listed, not checked, so the inspector never claims a full inspection.
- **Coverage:** `rules.<id>.article` (the article and our paraphrase of it) and `rules.<id>.check.params.<name>` per parameter. A number a check needs is a parameter with its own source, or read from the entry it judges; never a gauge-to-amperes, fill-allowance or other code table.
- **Rule ids are append-only** across a rule set's versions (load-checked, like colour ids); a shipped rule-set version keeps every rule's id, article, severity and check (prose may be corrected).
- **Seed:** `nec.v1.json` lists 240.4(D) (`smallConductorOcpd`) and 250.148(C) (`metalBoxBonded`), the two acceptance findings, and 210.11(C)(1) (`kitchenSmallApplianceCircuits`), the plan's example of a rule listed but not checked. All three have `check: null` until PR 20 adds the check kinds.

### Region data

`RegionProfile` gains (D7, D8, D13; NEC only):

- **`protection.gfci`**: Class A (UL 943 by number): pickup 4 mA (must not trip below) to 6 mA (must trip), and the inverse-time limit t = (20 mA / I)^1.43 s **tabulated offline** at the pre-audit's points (6, 10, 20, 30, 50, 100, 150 and 264 mA → 5.594, 2.695, 1.000, 0.560, 0.2697, 0.1001, 0.0561, 0.0250 s), each within 0.15 % of the curve (recomputed in `catalog-v3.spec.ts`). The engine reads it as a rate, interpolated linearly in rate (D7); it is an upper limit only.
- **`protection.afci`** (UL 1699 by number): nothing required below 5 A; 1 s at 5 A; under 0.2 s at 1.5 × rating.
- **`inspectorRules: { ruleSet: 'nec', version: 1 }`**, which must resolve in the built-in catalogue (tested).

### Coverage paths

Added to ADR 0016's table:

| Family   | New paths                                                                                                                                                                                                                                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| device   | `terminals.<id>.methods.<method>.multiConductor`; `fits.<type>.contacts.<id>.contactOhm`; `mounts.<id>` for `hostMounts` too (host contacts and the bus pattern under it); `markedVolumeMm3`, `material`, `spaces`; `outlets.<id>.{config,positionMm,pins,contactOhm}`; `plug.{config,cordAwg,cordLengthMm,cordExitMm,pins}` |
| rule set | `rules.<id>.article`, `rules.<id>.check.params.<name>`                                                                                                                                                                                                                                                                       |

**`fits.<type>` now covers only the fit's layout**, never its contacts' resistances below it, exactly as `terminals` covers only the terminal layout: a game-design layout source can't silently cover a sourced contact resistance. No shipped source covered anything below `fits.<type>`, so nothing changes for them.

### JSON Schema

`device.v3.schema.json` replaces `device.v2.schema.json` and `rule-set.v3.schema.json` is new; `cable.v2`, `tool.v2`, `accessory.v2` and `table.v2` keep their names, unchanged since catalogue v2 (a family's schema carries the format version that last changed it). The catalogue format isn't save format; no `device-state.*` or `connection-state.*` file changed.

### The shipped entries in catalogue 3

**Every shipped entry keeps its version and only gains data** (ADR 0016's rule): `role: null`, `side: null` and `access` (`land` with methods, `clip` without) on every terminal; `multiConductor: null` on every method; `alongMm: 0` and `contacts: []` on every fit; `contacts: []` and `bus: null` on every enclosure mount; `markedVolumeMm3: null`, its `material` (sourced) and `spaces: []` on every enclosure; `hostMounts: []`, `outlets: []`, `plug: null` and `supersededBy: null` (`tb.quennick-st4@1`: `@2`). For a catalogue-1 or catalogue-2 release, `shipped.spec.ts` treats them in two groups (save-format-guardian's review): **free** (`role`, `side`, `markedVolumeMm3`, `material`, `supersededBy`: inspector data and metadata, dropped before comparing, any value allowed) and **neutral** (every other v3 field: it must hold its "nothing" value on a shipped entry, `multiConductor: null`, `access` following the methods and never `none`, `alongMm: 0`, no fit or host-mount contacts, `bus: null`, `spaces: []`, `hostMounts: []`, `outlets: []`, `plug: null`, because each changes what an old save simulates or accepts; any other value fails). Self-tests prove each: a free value passes for 0.4.0, a two-conductor cap or `access: 'none'` on a shipped entry fails, a catalogue-2 value beside them stays locked, and a catalogue-3 release masks nothing. From catalogue 3 a frozen list carries `rules` (`pnpm catalog:freeze` writes them).

### Vetted values and the must-avoid list

From the P4 pre-audit (electrical-realism-reviewer, 2026-11-17), for the content PRs that land on this format; sources in the PRs' reference notes, never maker names in content `source` strings:

- Split-phase 25 kVA, 2 %, X/R 2: Z_line 10.30 + j20.61 mΩ, Z_n −2.576 − j8.243 mΩ; I_LN 8230 A, I_LL 5208 A. Utility neutral grounding 5 Ω (game-design inside 1–25 Ω).
- Ground rod 8 ft × 5/8 in at ρ = 100 Ω·m: 39.9 Ω by Dwight's formula with the radius (IEEE Std 142 by number), computed offline.
- Plug-on 15/20 A: instantaneous 240–400 A; opening above it 8–20 ms (top read from the curve, bottom game-design); the P2 bimetal law (τ 60 s, k_u 1.25) inside the read thermal bands at 135 %, 200 %, 500 % and 10×; pole contact 5–10 mΩ.
- GFCI Class A: pickup 4–6 mA; the limit as rate points above; mechanism 3–14 ms.
- AFCI: ≤ 1 s at 5 A, < 0.2 s at 1.5 × rating; nothing required below 5 A.
- Push-in: 14 AWG solid copper, 15 A devices only (receptacles UL 498, switches UL 20, by number); none on 5-20R or GFCI receptacles.
- NEMA WD 6 mating: 5-15R takes 1-15P and 5-15P; 5-20R takes 1-15P, 5-15P and 5-20P; 6-20R takes 6-15P and 6-20P; 14-30R and 14-50R take their own plug only (the pre-audit as corrected by the realism review, 2026-11-17; deviation 10). LED driver: constant power from 108 V, dropout about 90 V (labelled), PF 0.9. Appliances as labelled class figures; the dryer and range carry a 120 V L1–N share; constant-power loads state a PF.
- **Must avoid:** NEC table values anywhere (314.16 allowances, Chapter 9 Table 1, 310.16, Annex C, 250.66/250.122); quoting NEC or UL text; real maker names in content; Dwight with the diameter; linear-in-t GFCI interpolation; an 8–12× band or IEC 60898 curves on plug-on breakers; earth as an effective fault path; AFCI trips below 5 A or on non-arcing joints; UL 943C values for Class A; `Math.log`/`Math.pow` in sim code.

## What the next PRs read from this

- **World v4 (PR 7)** (save-format-guardian's review):
  - move `OutletId`, `AreaUseId` and `AreaId` into `save-format`'s primitives and **delete the catalogue copies**, re-exporting them here (ADR 0016's precedent): two schemas registering the same `.meta({ id })` collide;
  - load checks in `checkWorldReferences`: an area's `use` in `AREA_USES`; a `pluggedInto.outlet` in the host entry's `outlets`; the configurations mate and the cord reaches (`nemaMates`, `checkPlugInsert`); a load centre's `directory<n>` keys above its `spaces` are `null`; counters are non-negative;
  - resolve `mountedOn` through `offeredMounts` (so a bulb's host may be a lampholder's `hostMounts`), with one cycle walk over mounts, entries, plugs and host mounts;
  - decide the fate of the never-shipped `-engine-7-catalog-3.ctrl` fixtures once world v4 writes saves (kept as `engine-changed` regressions under `fixtures/v3`, like the engine-6 catalogue-2 ones, or deleted with a note);
  - the `LAMP_INCANDESCENT_REFS_V3` parity test against the frozen catalogue-2 list;
  - check the load centre's bag (`coverOn`, `openEntries` and 42 `directory` keys, 44 commanded keys) against `MAX_DEVICE_STATE_KEYS` (64). _Corrected by ADR 0019's P4 PR 14 amendment: there is no `on` key; "45" was an error._
  - `DeviceStateValue`'s description in v4 covers `text` (label text, not only an enum string).
- **World v4 commands (PR 8):** `wire.land` enforces `multiConductor` (the refusal code is that PR's, with `save-format-guardian`); `checkMount`, snapping and the ghost read the single-mount anchor (`alongMm`, `crossMm`; until then no entry declares a non-zero anchor on a single mount, tested) and offered mounts through `offeredMounts`; `device.operate`'s `momentary` refusal; `lead.connect`'s `inaccessible` on `access: 'none'`; the build menu hides `supersededBy` entries and `beltChoices` filters them (today it offers each id's newest version, which is the same entry for `tb.quennick-st4`); `busStabIndex` over `bus`.
- **Engine 8 (PR 9):** contact branches from `fits.*.contacts`, `EnclosureMount.contacts` and `bus`, and outlets' `pins`; terminals from the entry (families). `ElementRef.part` is at most 32 characters, so a contact id with a prefix (`mount:<id>`) could overflow it: add a `contact` element-ref kind (ADR 0019 §8) or cap `ContactId` lower. _Done (PR 9, [ADR 0021](0021-service-grounding-and-protection-physics.md) §4–§5): a `contact` element-ref kind, so `ContactId` keeps its 32-character grammar._
- **Inspector (PR 20):** the check-kind registry validates each rule's `check`; **250.148(C)'s trigger is circuit conductors spliced or terminated in a metal box** (the realism review's correction of the first draft, which said an EGC passing through), so the check fires on a metal box holding a splice or a termination of a circuit whose EGC doesn't reach the box; the conductor-vs-breaker rule needs **a published circuit rating on conductor entries** (plan F4.5: "each conductor entry's own published circuit rating"), which no format field carries yet: a `ConductorSpec` field added to catalogue 3 while it is provisional, with `save-format-guardian` and the realism review.

## Deviations from the plan and from ADR 0019

1. **A device contact names its host contact (`host`).** ADR 0019 listed `{ id, terminal, positionOffset, contactOhm }`; a two-pole breaker's two contacts both touch a `stab`, so the contact id can't double as the host contact's.
2. **A contact's resistance is covered at `fits.<type>.contacts.<id>.contactOhm`**, not ADR 0019's `mounts.<type>.contacts.<id>.contactOhm`: `mounts.<id>` is an enclosure's mount (ADR 0016 deviation 3), and `fits.<type>` now covers only the fit's layout.
3. **`mainFeed`, not `mainBreaker`** (ADR 0019 left the choice here): one mount type takes a main breaker or a main-lug kit, so one load-centre kind is either (C3).
4. **R5's choice: a top-level `hostMounts`**, not a mounts-only `enclosure` block: dozens of readers take `enclosure !== null` to mean "an enclosure" (hollow for routes, entries, the renderer), and a lampholder isn't one.
5. **The bus pattern lists its legs in stab order** (`legs: [even, odd]`) instead of a "reversed" flag.
6. **`RegionProfile.inspectorRules` is `{ ruleSet, version }`**, not the plan's `{ table, version }`: a rule set isn't a catalogue table, and the name says which family resolves it.
7. **`material` is required on every enclosure**, so the shipped boxes and panel gain it with sources (data only, masked for 0.4.0), instead of a nullable field the inspector would have to guess about.
8. **The seed rule set has `check: null` on every rule**: check kinds are the inspector's code (PR 20), and naming them here would freeze names before their registry exists.
9. **Catalogue-3 fixtures are `-engine-7-catalog-3`** between this PR and engine 8, which replaces them (ADR 0019 named only the engine-8 ones).
10. **A 1-15P mates a 5-15R and a 5-20R.** The pre-audit's matrix said 5-15R takes "its own plug only", but ADR 0019 C6 adds 1-15P to `NEMA_CONFIGS`, and a two-blade plug physically enters both. **Accepted by the realism review (2026-11-17)**; the plan's pre-audit outcome is corrected. The 1-15P is modelled polarised (`hot` and `neutral` pins): a non-polarised one that goes in either way round is not modelled.

## For review

**`save-format-guardian`** (anything a save references or the load check reads):

- The grammars `OutletId` (TerminalId's), `AreaUseId` and `ContactId` (camelCase, at most 32), defined here until PR 7 moves the first two into `save-format`.
- The `text` (`LabelText | null`) and `counter` (non-negative safe integer) key types and their helpers; no `MODEL_KINDS` key changed and no kind was added, so no `device-state.*` file and no `schemaVersion` moved.
- Outlet ids, contact ids, host contact ids and the `AREA_USES` and `NEMA_CONFIGS` ids as save format from v0.5.0.
- `tb.quennick-st4@2` beside an unchanged `@1` with `supersededBy`, and the belt offering `@2`.
- The shipped mask (free versus neutral v3 fields, for catalogue-1 and -2 releases only) and `rules` in frozen lists from catalogue 3. _Applied after review (2026-11-17)._
- The twelve `-engine-7-catalog-3.ctrl` fixtures and the 0.4.0 `-engine-7-catalog-2` saves loading as `engine-changed`.

**`electrical-realism-reviewer`**: see [Values for the realism review](#values-for-the-realism-review).

## Values for the realism review

| Value                                                                                                                                                                                             | Where                        | Source                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Two-conductor cap 22–16 AWG, equal sizes                                                                                                                                                          | `tb.quennick-st4@2`          | real-world: the 4 mm² class datasheet (read 2026-11-12); 16 AWG = 1.3087 mm² ≤ 1.5 < 1.6502 mm² (15 AWG), NBS Handbook 100 |
| Materials: two steel boxes and the panel steel, two PVC boxes nonmetallic                                                                                                                         | shipped enclosures           | real-world: their own product-class sources (UL 514A, 514C, UL 50/50E and NEMA 250 by number)                              |
| GFCI Class A pickup 4 / 6 mA                                                                                                                                                                      | `NEC_REGION.protection.gfci` | UL 943 by number, paraphrased; pre-audit                                                                                   |
| GFCI limit points (6–264 mA → 5.594–0.0250 s)                                                                                                                                                     | same                         | t = (20/I)^1.43 from a maker's public FAQ and an industry report (read 2026-11-17), tabulated offline                      |
| AFCI 5 A, 1 s; 1.5 × rating, 0.2 s                                                                                                                                                                | `NEC_REGION.protection.afci` | UL 1699 by number; pre-audit, corroborated by public descriptions of the test levels                                       |
| NEMA ratings (15/20 A 125 V; 15/20 A 250 V; 30/50 A 125/250 V) and mating                                                                                                                         | `NEMA_CONFIGS`               | NEMA WD 6 by number; the 1-15P rows (deviation 10)                                                                         |
| Article numbers 240.4(D), 250.148(C) (trigger: spliced or terminated in a metal box), 210.11(C)(1) (at least two 20 A circuits; number confirmed against secondary sources) and their paraphrases | `content/rules/nec.v1.json`  | NFPA 70-2023 by number; 210.11(C)(1) not in the pre-audit's confirmed list                                                 |
| Mount types' host contacts (yoke screws, MBJ, ground bar kit, E26 shell and centre, bus stabs)                                                                                                    | `MOUNT_TYPES`                | common practice; UL 67, UL 514A, NFPA 70-2023 250.24(B), 250.28 and 250.146 by number                                      |
| Area uses (ten rows)                                                                                                                                                                              | `AREA_USES`                  | game-design, after 210.8(A) and 210.12(B) by number                                                                        |
| `MAX_CORD_LENGTH_MM` 15 m; `MAX_PANEL_SPACES` 42                                                                                                                                                  | `device.ts`                  | game-design (a long extension cord; ADR 0019's 42 directory keys)                                                          |

Not changed: `tb.quennick-pe4@1` (the 4 mm² ground block) has the same two-of-any-size abstraction; the plan versions only the feed-through block, so its cap is raised for the plan rather than shipped here (content caveats).

**Reference notes** (kept out of content `source` strings, which never name makers): the terminal-block voltage-drop acceptance cited by `tb.quennick-st4`'s `tb-screw-contact` source was read on https://www.phoenixcontact.com/en-ch/quality-tests-for-terminal-blocks/electrical-tests-terminal-blocks (2026-11-12); the GFCI inverse-time formula on https://www.se.com/us/en/faqs/FA105578 and in AHRI 8029's final report (https://www.ahrinet.org/sites/default/files/AHRI%208029%20Final%20Report.pdf), both read 2026-11-17; the AFCI test levels in IAEI's "AFCIs in our states" (https://iaeimagazine.org/magazine/2013/julyaugust-2013/afcis-in-our-states-a-standards-perspective/) and US patent 7,362,552, read 2026-11-17.

## Consequences

- `@controls/catalog`: `device.ts` (v3 fields), `registries.ts` (`MOUNT_TYPES` rows and fields, `NEMA_CONFIGS`, `AREA_USES`, the roles and grammars), `model-kinds.ts` (`text`, `counter`, `terminalFamilies`), `rules.ts` (new), `catalog.ts` (the v3 load rules, `offeredMounts`, rule sets, `supersededBy`), `sources.ts` (`fits.<type>`), `region.ts` (`protection`, `inspectorRules`), `json-schema.ts`, `builtin.ts` (`CATALOG_VERSION` 3, the rules mirror); specs `catalog-v3.spec.ts` (new), `builtin.spec.ts`, `shipped.spec.ts`.
- `content/`: every device file gains the v3 fields; `tb.quennick-st4.v2.json`; `content/rules/nec.v1.json`.
- Test catalogues in `sim-core` and `world-model` carry the v3 fields; `tools/freeze-shipped-catalogue.mjs` freezes `rules`.
- `apps/sim-cli`: twelve `-engine-7-catalog-3.ctrl` fixtures; the scenarios' `--save` lines name them.
- Docs: the [authoring guide](../guides/authoring-content.md), the [content](../caveats/content.md) and [save-format](../caveats/save-format.md) caveats, the glossary, `docs/history.md` (`catalogVersion` 3), the CHANGELOG.

## Alternatives considered

- **Optional v3 fields** (`role?`, `contacts?`): fewer edits to shipped files and test catalogues, but ADR 0016's rule ("absent is `null` or `[]`") would have exceptions, and a missing block would look like a forgotten one.
- **A mounts-only `enclosure` block for a lampholder** (R5's other option): no new field, but every reader of `enclosure !== null` would need an exception.
- **Host contacts per enclosure mount only, no registry list**: one fewer registry field, but a device's contact could name a host contact no host of its type can offer, found only at compile time.
- **Check kinds in the catalogue**: the rule data could be validated at load, but the catalogue can't import the inspector (the dependency runs the other way) and the parameters belong to the check's code.
- **Fill allowances as rule parameters**: the pre-audit holds that a per-gauge volume or a fill percentage is the code table however it is cited (Q1); fill is reported, not judged.
- **Versioning every family's schema file to v3**: uniform names, but four files would change name with no change in shape.
