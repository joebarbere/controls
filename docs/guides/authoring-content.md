# Authoring catalogue content

How to add or change a device, conductor, cable, tool, accessory or table in `content/`, so it loads, is sourced and stays compatible with every save. The format is [ADR 0016](../decisions/0016-catalogue-format-v2.md) (catalogue v2) on top of [ADR 0013](../decisions/0013-world-document-v2.md); the gotchas are in the [content caveats](../caveats/content.md). Content work belongs to the `content-designer` agent, and every new or changed value goes to `electrical-realism-reviewer` before the PR merges.

## The realism charter, in practice

- **Every number has a source**, and loading checks it: a value no source covers, or a source that covers nothing, fails `parseCatalog`.
- **`real-world` sources** cite a standard by number, a datasheet class ("typical published figures for the class, not one vendor's"), a physics derivation, or a public reference such as an NBS handbook. Paraphrase; never copy text or tables. A source you couldn't read isn't a source: say "unverified" and label it `game-design` until someone reads it.
- **`game-design` sources say so** in their citation (start it with `game-design:`) and never pose as measurements.
- **Never NEC/NFPA text or tables**, anywhere (content, comments, docs, tests): no ampacity table values, no Chapter 9 conductor properties, no insulation-type table, no box-fill volumes. Cite the article number and paraphrase ("NFPA 70-2023 Art. 110.14(D) requires the marked torque"). A manufacturer sheet that reprints an NEC table is an NEC table. No UL 486A-B torque tables: torque comes from the device's own (fictional) marking.
- **Compute, don't tabulate.** Resistance is ρ · L / A · (1 + α ΔT) from a pinned `materials` row; a gauge's area comes from the AWG formula (`AWG_GAUGES`); ampacity is derived by the thermal model (P3 D6).
- **Fictional brands only.** No real vendor names, model numbers or trade dress; industry terms (THHN, NM-B, CO/ALR, NEMA 5-15) are fine. Use a brand from the list below or add one to it.

## Workflow

1. **Check the phase plan's fence** (`plans/phase-N-*.md`, "Not in PN"). Out of scope: stop.
2. **Find sources first.** Write each citation and its `covers` paths before typing a value.
3. **Write the JSON** in `content/<family>/<id>.v<version>.json` (tables: `content/tables/<table>.v<version>.json`). The file name must match the id and version (a test checks).
4. **Regenerate the mirrors and schemas:** `pnpm nx test catalog -u`, then `pnpm nx test catalog`. Commit the JSON and the regenerated `builtin-*.generated.ts` together.
5. **Write the hand calculation** of every derived value in a spec (resistance per metre, area, any ratio), written out in a comment, at most 0.5 % tolerance.
6. **Run the dependants:** `pnpm nx test world-model sim-core sim-cli`. If a value feeds the simulator, run the affected `sim-cli` scenarios; if a pinned hash moves, that is a `SIM_ENGINE_VERSION` change for `sim-engine-engineer`.
7. **Docs:** a `docs/history.md` `catalogVersion` row for a new kind, entry or format change; a CHANGELOG line; the value list for `electrical-realism-reviewer`.
8. `pnpm verify`.

## Families and ids

One id namespace covers the whole catalogue (ADR 0015); the prefix says the family:

| Family    | Id prefix            | Directory              | Notes                                                                              |
| --------- | -------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| device    | anything else        | `content/devices/`     | Placed devices, enclosures, leads; conductors use `conductor.*` and only they      |
| cable     | `cable.*`            | `content/cables/`      | From F3.1 part 2: an assembly of pinned conductor entries in a jacket              |
| tool      | `tool.*`             | `content/tools/`       | From F3.4 part 1: capabilities, holes, dies, torque range, bore size               |
| accessory | `ferrule.*`, `lug.*` | `content/accessories/` | From F3.1 part 2: ferrules and ring or fork lugs, with the die ids that crimp them |
| (table)   | —                    | `content/tables/`      | Pinned by `{ table, version, key }`; not entries                                   |

`prop.*` is reserved for the built-in props. A new `content/` directory needs a row in `MIRRORS` (or `UNMIRRORED`) in `libs/domain/catalog/src/lib/content-mirrors.spec.ts`, a `.prettierignore` line for its generated mirror, and its documents passed to `parseCatalog` in `builtin.ts`.

## Coverage paths

A `covers` path covers itself and everything below it; `*` (not first) matches one segment. The bare `terminals` path is only the terminal layout.

- **Device:** `model.params.<name>`, `sizeMm`, `terminals`, `terminals.<id>.methods.<method>.<field>` (`ratedConductors`, `maxConductors`, `awgRange`, `stranding`, `stripLengthMm`, `torqueNm`, `drives`, `alRated`, `entryMm`, `exitAxis`), `fits.<mountType>`, `mounts.<id>`, `entries.<id>`, `interiorVolumeMm3`, `conductor.<field>`.
- **Cable:** `conductors.<index>`, `jacket.<field>`. **Tool:** `capabilities`, `holes.<id>`, `dies.<id>`, `torque`, `boreDiameterMm`, `drives`. **Accessory:** `awgRange`, `stranding`, `dies`, `barrelLengthMm`, `studDiameterMm`.
- **Table:** `rows.<key>.<field>`, or `rows.<key>` for a row, or `rows.*.<field>` for a column.

Shortcuts: `terminals.*.methods.screw` covers every field of both terminals' screw specs; split it when the fields have different sources (a real torque, a game-design strip length).

## Conductors

A conductor is a `conductor.*` device entry of model kind `conductor` (category `conductor`, `sizeMm: null`, no terminals, mounts or controls). Write:

- the `conductor` block from the product's sheet: `awg` (integer designation), `stranding` and `strandCount`, the pinned `materials` and `insulation` rows, `insulationThicknessMm` and, for an insulation row with a jacket layer (THHN's nylon), `jacketThicknessMm`, and the colours the product is made in;
- `model.params.layFactor`: 1 for solid, 1.02 for Class B/C stranding (cite NBS Handbooks 100 and 109).

Never store a diameter, an area, a resistance or an ampacity: they are derived (`conductorPhysics`, `conductorResistanceOhm`, `derivedAmpacityA`). Aluminium starts at 12 AWG (Art. 310.3(A), by number). A spec sheet with an ampacity column is an NEC table: find one without (see the [content caveats](../caveats/content.md)). Add the entry's derived values to the reviewer's list (`conductors.spec.ts` and `thermal.spec.ts` compute them).

## Cables

A cable is a `cable.*` entry in `content/cables/` that pins its conductor entries; it never inlines conductor data.

- **Author the conductors first.** Every member is a `conductor.*` device entry: the insulated conductors from the cable's own construction (NM-B's are THHN-type, so they pin `thhnThwn2` with the THHN walls of the size), the bare EGC as its own entry with `insulation: null`, null thicknesses and colours `[bare]`. The member's `colour` must be one its entry is made in, and `insulated` must match the entry.
- **Order is save format** (`ConnectionV3.cable.conductor`): ungrounded first (black, then red), then the grounded (white), then the EGC. `index` equals the position.
- **Jacket:** pin the `nmbJacket` insulation row; the colour, wall and outer size are product data. A flat cable stores `heightMm` (minor) and `widthMm` (major); a round one stores its diameter in both. `cables.spec.ts` checks the size is at least the conductors' geometric minimum and at most 20 % above it.
- **No ampacity, anywhere.** NM-B's 60 °C limit (Art. 334.80, by number) is P4's rule; derived ampacity uses `NM_CABLE_AMPACITY_TEMP_K` when P4 asks.
- **Cover** `conductors` (or `conductors.<index>`) and each `jacket.<field>`. Add the per-metre resistance of each new conductor to `cables.spec.ts` with its hand calculation.

## Accessories

Ferrules (`ferrule.*`, kind `ferrule`) and insulated ring and fork lugs (`lug.*`, kinds `ringLug`, `forkLug`) in `content/accessories/`.

- `dies` lists the crimper die ids that crimp it properly; any other die is an under-crimp (ADR 0018 §4.3). Lugs use the colour-code ids `red`, `blue`, `yellow`, the dies of `tool.veltmark-cr-2210`; ferrules use `square` (a ferrule crimper is still to come, F3.4 follow-up).
- `awgRange` and `stranding` are what the accessory fits (`wrong-accessory` otherwise); ferrules are stranded only. `barrelLengthMm` is what the strip length must match; `studDiameterMm` is a lug's screw size (`null` for a ferrule), computed for Unified numbered sizes as (0.060 + 0.013 N) in.
- **Twist-on wire nuts are not accessories.** ADR 0018 §4.4 makes them `splice.twistOn` devices with a `twistOn` terminal method whose `combination` bounds (conductor count, AWG range, total `areaUm2`) are paraphrased from public packaging data under a fictional brand, never a reproduced chart. They arrive with F3.3 part 1, which adds the fields.

## Termination specs

- A terminal's `methods` is empty for a clip-only terminal. Give a terminal methods only where a conductor really lands on that product.
- **Order is save format:** `'auto'` (Trainee) takes the first method.
- `torqueNm` is the device's **marked** torque, non-null exactly for `screw`; `drives` (the screw head's drive types from `DRIVE_TYPES`) is non-empty exactly for `screw`. A tool that can `drive` lists the drives its tip fits. Gauges are integer AWG designations (`awgRange: { smallest: 14, largest: 10 }`; 1/0 = 0 … 4/0 = −3).
- `entryMm` and `exitAxis` are game-design geometry unless the product's drawing is cited.

## Entry versions

- Saves reference `{ id, version }`, never the data, so a shipped entry is never edited or deleted.
- **Gaining data keeps the version** (a termination spec on a P2 device, a mount declaration), as long as no existing value changes. From catalogue 2, termination spec values count as electrical.
- **Changing any existing value is a new version:** copy the file to `<id>.v<n+1>.json`, change it there, keep the old one.
- **Text-only fixes** to a citation keep the version (they change no value).
- A table value change is a new **table** version; only new entry versions pin it. Colour ids are append-only across colour-table versions.
- While a `catalogVersion` hasn't shipped (catalogue 2 until v0.4.0), its new entries may still change in place.

## Brands

Fictional, one per maker. Add new ones here in the PR that uses them.

| Brand          | Makes                                             |
| -------------- | ------------------------------------------------- |
| -------------- | ------------------------------------------------  |
| Brindlecore    | Bench DC supply                                   |
| Calderyn       | Torque screwdrivers                               |
| Emberlyn       | Cartridge fuse                                    |
| Ferrovane      | Sealed lead-acid battery                          |
| Hearthvale     | Heater element                                    |
| Larkmoor Power | Utility services (one brand for the utility)      |
| Lumivane       | Incandescent lamps                                |
| Orrinwood      | Power resistor                                    |
| Pellmoor       | Control-panel enclosures                          |
| Penmarrow      | Label printers                                    |
| Quillfern      | Test leads                                        |
| Quorvale       | Aluminium building wire (XHHW-2)                  |
| Railwick       | DIN-rail power supply                             |
| Saltmere       | Circuit breaker                                   |
| Sorrelby       | NM-B cable and its conductors                     |
| Tallowmere     | Copper building wire (THHN/THWN-2) and MTW        |
| Tessaline      | Toggle switch                                     |
| Testbrand      | Test-only fixtures in specs, never in `content/`  |
| Thimbleby      | Ferrules and insulated ring and fork lugs         |
| Tinmoor        | Outlet and junction boxes (steel and PVC)         |
| Veltmark       | Hand tools (strippers, cutters, drivers, crimper) |
