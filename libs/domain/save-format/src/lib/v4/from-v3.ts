import type { CatalogRef, DeviceStateValue } from '../primitives';
import type { ManifestV3 } from '../v3/manifest';
import type { ReplayLogV3 } from '../v3/replay-log';
import type { EntityV3, WorldV3 } from '../v3/world';
import type { ManifestV4 } from './manifest';
import type { ReplayLogV4 } from './replay-log';
import type { EntityV4, WorldV4 } from './world';

/*
 * The v3 → v4 migration steps (ADR 0019). Pure and total: each returns a new document and never
 * mutates its argument (the tests deep-freeze it and run each step twice). Kept forever. They don't
 * read the catalogue.
 *
 * - World: no areas; each entity is unplugged (`pluggedInto: null`); each connection has no tape
 *   (`marking: { a: null, b: null }`); each entity whose ref is in `LAMP_INCANDESCENT_REFS_V3` gains the
 *   `lamp.incandescent` kind's two new sim keys (`LAMP_SIM_KEYS_V4`), each only if absent. An entity
 *   with any other ref, an unknown one included, keeps its bags as they are.
 * - Replay log: its initial world migrated as above; every entry copied verbatim (no P3 command's id
 *   or argument shape changed, and no P4 command can be in a v3 log).
 * - Manifest: `schemaVersion` 4; `catalogVersion` and `simEngineVersion` kept as saved.
 */

/**
 * The `lamp.incandescent` catalogue entries a v3 save can name (ADR 0019 deviation 1): catalogue 2 is
 * frozen (v0.4.0), so this list is complete for every save v0.4.0 (or, migrated, any earlier release)
 * wrote. A frozen literal so the step never reads the catalogue; a parity test in `@controls/catalog`
 * (`lamp-migration.spec.ts`) requires it to equal the `lamp.incandescent` entries of the frozen
 * catalogue-2 snapshot (`fixtures/shipped/0.4.0.json`). It never changes.
 */
export const LAMP_INCANDESCENT_REFS_V3: readonly Readonly<CatalogRef>[] = Object.freeze([
  Object.freeze({ id: 'lamp.lumivane-12v-5w', version: 1 }),
  Object.freeze({ id: 'lamp.lumivane-120v-60w', version: 1 }),
]);

/**
 * The sim keys `lamp.incandescent` gains at schemaVersion 4 (ADR 0019), at their initial values: the
 * sticky `burnedOut` and the overvoltage dwell's `overvoltageSinceTick`. A frozen literal for the same
 * reason as {@link LAMP_INCANDESCENT_REFS_V3}; while v4 is current a parity test in `@controls/catalog`
 * requires the kind's initial sim bag to be the v3 keys plus exactly these.
 */
export const LAMP_SIM_KEYS_V4: Readonly<Record<string, DeviceStateValue>> = Object.freeze({
  burnedOut: false,
  overvoltageSinceTick: null,
});

const isShippedLamp = (ref: CatalogRef): boolean =>
  LAMP_INCANDESCENT_REFS_V3.some((lamp) => lamp.id === ref.id && lamp.version === ref.version);

function entityV3ToV4(entity: EntityV3): EntityV4 {
  if (!isShippedLamp(entity.ref)) return { ...entity, pluggedInto: null };
  const own = (key: string) => Object.prototype.hasOwnProperty.call(entity.sim, key);
  const added = Object.fromEntries(Object.entries(LAMP_SIM_KEYS_V4).filter(([key]) => !own(key)));
  return { ...entity, sim: { ...entity.sim, ...added }, pluggedInto: null };
}

export function worldV3ToV4(world: WorldV3): WorldV4 {
  return {
    ...world,
    schemaVersion: 4,
    areas: [],
    entities: world.entities.map(entityV3ToV4),
    connections: world.connections.map((connection) => ({ ...connection, marking: { a: null, b: null } })),
  };
}

export function manifestV3ToV4(manifest: ManifestV3): ManifestV4 {
  return { ...manifest, schemaVersion: 4 };
}

export function replayLogV3ToV4(log: ReplayLogV3): ReplayLogV4 {
  return { ...log, schemaVersion: 4, initialWorld: worldV3ToV4(log.initialWorld), entries: [...log.entries] };
}
