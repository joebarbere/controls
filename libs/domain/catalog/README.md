# catalog (`@controls/catalog`)

Framework-free domain library (`type:domain`): the device catalogue (plan P2 decision D4, ADR 0013).

- `DeviceDefinition`: the catalogue entry format (one file per device in `content/devices/<id>.v<version>.json`).
- `MODEL_KINDS`: each model kind's parameters, terminals and state keys (owner, schema, initial value). The state keys are save format.
- `parseCatalog` / `catalogOrThrow`: validate entries (kind, parameters, terminals, controls, source coverage) and build a `Catalog` that resolves `CatalogRef`s.
- `BUILTIN_CATALOG` and `CATALOG_VERSION` (1): `content/devices`, mirrored into `src/lib/builtin-devices.generated.ts` (regenerate with `pnpm nx test catalog -u`).
- `leadResistanceOhm`: a test lead's resistance from resistivity, length and area, with a temperature coefficient.
- JSON Schema exports in `json-schema/` (`device.v1`, `device-state.<kind>`), staleness-checked.

Must not depend on Angular, the DOM, Electron, Node built-ins or any non-`type:domain` lib, and must stay deterministic ([workspace caveats](../../../docs/caveats/workspace.md)). Gotchas: [save-format caveats](../../../docs/caveats/save-format.md#the-device-catalogue-p2-kickoff-catalogue-v1). Tests: `pnpm nx test catalog` (90 % coverage gate).
