import { BUILTIN_DEVICE_DOCUMENTS } from './builtin-devices.generated';
import { BUILTIN_TABLE_DOCUMENTS } from './builtin-tables.generated';
import { BUILTIN_TOOL_DOCUMENTS } from './builtin-tools.generated';
import { type Catalog, catalogOrThrow } from './catalog';

/*
 * The catalogue built into the game (plan P2 decision D4, P3 D3): `content/devices/*.json`,
 * `content/tables/*.json` and `content/tools/*.json` (F3.4 part 1), mirrored into
 * `builtin-*.generated.ts` so every domain lib, the game and `sim-cli` resolve refs the same way without reading files (domain code can't import `content/`). The
 * JSON files are authoritative; `content-mirrors.spec.ts` fails when a mirror is stale (regenerate with
 * `pnpm nx test catalog -u`). Cables and accessories join as their first entries land (F3.1 part 2,
 * F3.3 part 1), each with its own mirror.
 */

/**
 * `catalogVersion` of the built-in catalogue, written into every save's manifest (ADR 0004). Catalogue
 * v1 (the P2 device set) is frozen since v0.3.0. Catalogue v2 (P3: format v2, the tables, the P3
 * content) may still change until the release that ships it (v0.4.0) and is frozen from then on; a
 * shipped `(id, version)` resolves in every later catalogue version (ADR 0016). Recorded in
 * `docs/history.md`.
 */
export const CATALOG_VERSION = 2;

/** The built-in catalogue, validated when this module loads. */
export const BUILTIN_CATALOG: Catalog = catalogOrThrow(CATALOG_VERSION, {
  devices: BUILTIN_DEVICE_DOCUMENTS,
  tools: BUILTIN_TOOL_DOCUMENTS,
  tables: BUILTIN_TABLE_DOCUMENTS,
});
