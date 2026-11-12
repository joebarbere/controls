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
/** What a device is mounted on (D11, world v3): an enclosure entity and one of its catalogue mounts. */
export type MountedOn = NonNullable<Entity['mountedOn']>;
/** Fixed level geometry (F1.9): a wall, bench, backplate or DIN rail that comes with the level. */
export type Fixture = World['fixtures'][number];
export type FixtureId = Fixture['id'];
/** A two-ended connection: a test lead (P2, `lead.connect`) or a conductor (P3, world v3). */
export type Connection = World['connections'][number];
export type ConnectionId = Connection['id'];
/** A landed connection end: `{ entity, terminal, termination }` (a lead's clip has `termination: null`). */
export type ConnectionEnd = NonNullable<Connection['a']>;
/** How a conductor end was made (ADR 0015): the outcome of the tool steps, never a resistance. */
export type Termination = NonNullable<ConnectionEnd['termination']>;
/** One point of a conductor's or cable's route (integer mm). */
export type Waypoint = NonNullable<Connection['route']>[number];
/** A conductor's colour: base and optional tracer stripe, colour-table ids. */
export type ConductorColour = NonNullable<Connection['colour']>;
/** A cable assembly in the world (world v3): owns its conductors. */
export type Cable = World['cables'][number];
export type CableId = Cable['id'];
/** A cable end: an enclosure entity and one of its catalogue entries. */
export type CableEnd = NonNullable<Cable['a']>;
/** One end of a connection as `lead.connect` names it: `{ entity, terminal }`. */
export type TerminalRef = Pick<ConnectionEnd, 'entity' | 'terminal'>;
/** The last electrical solution (ADR 0011 §9.6), or `null`. Written only by `materialiseWorld`. */
export type SimSolution = World['sim'];
