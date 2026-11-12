# catalog (`@controls/catalog`)

Framework-free domain library (`type:domain`): the catalogue (plan P2 decision D4, ADR 0013; catalogue format v2, P3 D3, ADR 0016). Authoring: [guide](../../../docs/guides/authoring-content.md).

- `DeviceDefinition` (catalogue format v2): one file per device in `content/devices/<id>.v<version>.json`, with per-method termination specs on terminals, mount declarations, enclosure data and conductor data. `CableDefinition`, `ToolDefinition`, `AccessoryDefinition`: the other families of the one id namespace (`cable.*`, `tool.*`, `ferrule.*`/`lug.*`).
- Tables (`TableDocument`, `TABLE_KINDS`, `TableRef`): `content/tables/<table>.v<version>.json` (materials, insulation, colours), pinned by `{ table, version, key }`.
- `AWG_GAUGES` and `Awg`/`AwgRange`: the one gauge table, integer designations (4/0 = −3), computed from the AWG formula.
- Registries: `TERMINATION_METHODS`, `MOUNT_TYPES`, `ENTRY_TYPES`, tool steps and kinds.
- `MODEL_KINDS`: each model kind's parameters, terminals and state keys (owner, schema, initial value). The state keys are save format; the lead's are `CONNECTION_SIM_KEYS` (world v3).
- `parseCatalog` / `catalogOrThrow`: validate every family and table (kinds, parameters, terminals and methods, registries, pinned rows, colours, controls, source coverage) and build a `Catalog` that resolves `CatalogRef`s and table rows.
- `BUILTIN_CATALOG` and `CATALOG_VERSION` (2, provisional until v0.4.0): `content/devices` and `content/tables`, mirrored into `src/lib/builtin-*.generated.ts` (regenerate with `pnpm nx test catalog -u`).
- `leadResistanceOhm`: a test lead's resistance from resistivity, length and area, with a temperature coefficient.
- `RegionProfile` and `REGION_PROFILES` (F2.2 part 2): each region's supply frequency and nominal system voltages, sourced (NEC: 60 Hz, 120/240 V, 208Y/120 V, 480Y/277 V), and from catalogue 2 its conductor colour rules (`conductorColours`, `matchesColourRule`).
- JSON Schema exports in `json-schema/` (`<family>.v2`, `table.v2`, `table-row.<table>`, `device-state.<kind>`, `connection-state.<kind>`), staleness-checked.

Must not depend on Angular, the DOM, Electron, Node built-ins or any non-`type:domain` lib, and must stay deterministic ([workspace caveats](../../../docs/caveats/workspace.md)). Gotchas: [content caveats](../../../docs/caveats/content.md), [save-format caveats](../../../docs/caveats/save-format.md#the-device-catalogue-p2-kickoff-catalogue-v1). Tests: `pnpm nx test catalog` (90 % coverage gate).
