import { BUILTIN_DEVICE_DOCUMENTS } from './builtin-devices.generated';
import { type Catalog, catalogOrThrow } from './catalog';

/*
 * The device catalogue built into the game (plan P2 decision D4): `content/devices/*.json`, mirrored
 * into `builtin-devices.generated.ts` so every domain lib, the game and `sim-cli` resolve refs the same
 * way without reading files (domain code can't import `content/`). The JSON files are authoritative;
 * `builtin.spec.ts` fails when the mirror is stale (regenerate with `pnpm nx test catalog -u`).
 */

/**
 * `catalogVersion` of the built-in catalogue, written into every save's manifest (ADR 0004). Catalogue
 * v1 is the P2 device set; like a schema version it may still change until the release that ships it
 * (v0.3.0) and is frozen from then on. Recorded in `docs/history.md`.
 */
export const CATALOG_VERSION = 1;

/** The built-in catalogue, validated when this module loads. */
export const BUILTIN_CATALOG: Catalog = catalogOrThrow(CATALOG_VERSION, BUILTIN_DEVICE_DOCUMENTS);
