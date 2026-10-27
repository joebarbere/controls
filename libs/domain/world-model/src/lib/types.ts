import type { World } from '@controls/save-format';

/*
 * World types, inferred from the `@controls/save-format` schemas (never hand-written parallel
 * interfaces), so the world model can't drift from what a save holds.
 */

export type { CatalogRef, World } from '@controls/save-format';

/** A placed thing in the as-built world. */
export type Entity = World['entities'][number];
export type EntityId = Entity['id'];
export type Transform = Entity['transform'];
/** Integer millimetres, right-handed, +y up. */
export type PositionMm = Transform['positionMm'];
/** Intrinsic yaw/pitch/roll in integer millidegrees, each in [0, 360000). */
export type OrientationMdeg = Transform['orientationMdeg'];
