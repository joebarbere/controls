import type { World } from '@controls/save-format';

/*
 * World types, inferred from the `@controls/save-format` schemas (never hand-written parallel
 * interfaces), so the world model can't drift from what a save holds.
 */

export type { CatalogRef, DeviceStateBag, DeviceStateValue, World } from '@controls/save-format';

/** A placed thing in the as-built world. */
export type Entity = World['entities'][number];
export type EntityId = Entity['id'];
export type Transform = Entity['transform'];
/** Integer millimetres, right-handed, +y up. */
export type PositionMm = Transform['positionMm'];
/** Intrinsic yaw/pitch/roll in integer millidegrees, each in [0, 360000). */
export type OrientationMdeg = Transform['orientationMdeg'];
/** Fixed level geometry (F1.9): a wall, bench, backplate or DIN rail that comes with the level. */
export type Fixture = World['fixtures'][number];
export type FixtureId = Fixture['id'];
/** A two-ended connection between entity terminals: a test lead (P2, `lead.connect`). */
export type Connection = World['connections'][number];
export type ConnectionId = Connection['id'];
/** One end of a connection: `{ entity, terminal }`. */
export type TerminalRef = Connection['a'];
/** The last electrical solution (ADR 0011 §9.6), or `null`. Written only by `materialiseWorld`. */
export type SimSolution = World['sim'];
