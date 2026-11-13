import {
  type Axis,
  type BodyState,
  type Catalog,
  deviceBodySizeMm,
  deviceMountWidthMm,
  type EnclosureMount,
  mountType,
} from '@controls/catalog';
import { type CommandFailure, fail } from '@controls/commands';
import { findEntity } from '../entity-commands';
import { entityPointMm, isAxisAligned, rotateQuarterTurns } from '../snap/quarter-turn';
import type { CatalogRef, Entity, EntityId, MountedOn, OrientationMdeg, PositionMm, World } from '../types';

/*
 * Mounting (ADR 0015, "Mounting and occupancy"; D11; ADR 0016 deviation 4). A mount is a frame in its
 * enclosure: the mounted device's +x lies along the mount's `axis` and its front (+z) faces `facing`,
 * so its +y is `facing × axis`. Everything is exact quarter-turn integer geometry (`entityPointMm`).
 *
 * Where a mounted device sits (the `off-mount` integer check, decided here for F3.5): its origin (the
 * corner its body spans +x, +y, +z from) lies on the mount, offset from the mount's `positionMm` by
 * `along` in the axis direction and `cross` in the +y direction, with nothing along `facing`:
 * - `single` (a device yoke): exactly at the mount's position (along = cross = 0);
 * - `linear` (a DIN rail): cross = the device's declared `crossMm` (0 for a DIN 43880 modular device; a
 *   terminal block declares the offset that centres it on the rail, F3.5 part 2) and
 *   0 ≤ along ≤ extentMm − widthMm (the device's declared width);
 * - `area` (a backplate): 0 ≤ along ≤ extentMm − widthMm and 0 ≤ cross ≤ extentMm − heightMm (a square
 *   of side `extentMm` until a backplate declares its second extent, F3.5).
 * Room (`mount-full`): a `single` mount holds one device; on a `linear` mount the devices' spans
 * [along, along + width) don't overlap; on an `area` mount their footprints don't. A cut-to-length
 * raceway (a duct on a backplate) takes its cut length as its width (`deviceMountWidthMm`).
 */

const UNIT: Readonly<Record<Axis, PositionMm>> = {
  '+x': { x: 1, y: 0, z: 0 },
  '-x': { x: -1, y: 0, z: 0 },
  '+y': { x: 0, y: 1, z: 0 },
  '-y': { x: 0, y: -1, z: 0 },
  '+z': { x: 0, y: 0, z: 1 },
  '-z': { x: 0, y: 0, z: -1 },
};

const dot = (p: PositionMm, q: PositionMm): number => p.x * q.x + p.y * q.y + p.z * q.z;
const cross = (p: PositionMm, q: PositionMm): PositionMm => ({
  x: p.y * q.z - p.z * q.y + 0,
  y: p.z * q.x - p.x * q.z + 0,
  z: p.x * q.y - p.y * q.x + 0,
});
const same = (p: PositionMm, q: PositionMm): boolean => p.x === q.x && p.y === q.y && p.z === q.z;

/** The mount's frame in world directions: the device's +x (`axis`), +y and +z (`facing`), or `null`. */
export function mountFrame(
  host: Pick<Entity, 'transform'>,
  mount: EnclosureMount,
): { x: PositionMm; y: PositionMm; z: PositionMm } | null {
  const x = rotateQuarterTurns(host.transform.orientationMdeg, UNIT[mount.axis]);
  const z = rotateQuarterTurns(host.transform.orientationMdeg, UNIT[mount.facing]);
  return x && z && { x, y: cross(z, x), z };
}

/**
 * Whether a device turned to `orientation` sits in the mount's frame: its orientation is the host's
 * composed with the mount's catalogue frame (both quarter-turns, compared exactly on two axes).
 */
export function fitsMountFrame(
  host: Pick<Entity, 'transform'>,
  mount: EnclosureMount,
  orientation: OrientationMdeg,
): boolean {
  const frame = mountFrame(host, mount);
  const x = rotateQuarterTurns(orientation, UNIT['+x']);
  const z = rotateQuarterTurns(orientation, UNIT['+z']);
  return frame !== null && x !== null && z !== null && same(x, frame.x) && same(z, frame.z);
}

/** Where `position` lies in the mount's frame (`along`, `cross`, `normal`, integer mm), or `null`. */
export function mountOffset(
  host: Pick<Entity, 'transform'>,
  mount: EnclosureMount,
  position: PositionMm,
): { along: number; cross: number; normal: number } | null {
  const origin = entityPointMm(host.transform, mount.positionMm);
  const frame = mountFrame(host, mount);
  if (origin === null || frame === null) return null;
  const d = { x: position.x - origin.x, y: position.y - origin.y, z: position.z - origin.z };
  return { along: dot(d, frame.x), cross: dot(d, frame.y), normal: dot(d, frame.z) };
}

/** A device's footprint on a mount: its span along the axis and across it. */
interface Footprint {
  readonly along: number;
  readonly cross: number;
  readonly width: number;
  readonly height: number;
}

/** The footprint of device `ref` at `position` on `mount`, or `null` if it isn't on the mount. */
function footprint(
  catalog: Catalog,
  host: Entity,
  mount: EnclosureMount,
  ref: CatalogRef,
  position: PositionMm,
  state: BodyState,
): Footprint | null {
  const device = catalog.device(ref);
  const fit = device?.mounts.find((m) => m.type === mount.type);
  const width = device && deviceMountWidthMm(device, mount.type, state);
  const offset = mountOffset(host, mount, position);
  if (!device || !fit || width === undefined || offset === null || offset.normal !== 0) return null;
  const height = deviceBodySizeMm(device, state)?.heightMm ?? 0;
  const occupancy = mountType(mount.type)?.occupancy ?? 'single';
  const { along, cross: across } = offset;
  const fits =
    occupancy === 'single'
      ? along === 0 && across === 0
      : occupancy === 'linear'
        ? across === fit.crossMm && along >= 0 && along + width <= mount.extentMm
        : along >= 0 && along + width <= mount.extentMm && across >= 0 && across + height <= mount.extentMm;
  return fits ? { along, cross: across, width, height } : null;
}

const overlap = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;

/**
 * Checks placing (or sliding) device `ref` at `position` turned to `orientation` on `mountedOn`
 * (ADR 0015): the host exists (`not-found`) and is axis-aligned (`not-axis-aligned`), has the mount
 * (`unknown-mount`), the device fits its type (`mount-mismatch`), is axis-aligned itself
 * (`not-axis-aligned`), sits in the mount's frame and on the mount (`off-mount`), and the mount has room
 * (`mount-full`). `self` is the device being slid (it doesn't crowd itself), or `null`; `state` the
 * device's commanded state (a cut part's length), `null` for one not placed yet.
 */
export function checkMount(
  world: Pick<World, 'entities'>,
  catalog: Catalog,
  ref: CatalogRef,
  position: PositionMm,
  orientation: OrientationMdeg,
  mountedOn: MountedOn,
  self: EntityId | null,
  state: BodyState = null,
): CommandFailure | null {
  const host = findEntity(world, mountedOn.entity);
  if (!host) return fail('not-found', `No entity with id ${mountedOn.entity}`);
  if (host.id === self) return fail('unknown-mount', 'A device is never mounted on itself');
  const mount = catalog.device(host.ref)?.enclosure?.mounts.find((m) => m.id === mountedOn.mount);
  if (!mount) return fail('unknown-mount', `Entity ${mountedOn.entity} has no mount "${mountedOn.mount}"`);
  if (!catalog.device(ref)?.mounts.some((m) => m.type === mount.type)) {
    return fail('mount-mismatch', `${ref.id} does not fit a ${mount.type} mount`);
  }
  if (!isAxisAligned(host.transform.orientationMdeg) || !isAxisAligned(orientation)) {
    return fail('not-axis-aligned', 'A mounted device and its host are at quarter-turns');
  }
  if (!fitsMountFrame(host, mount, orientation)) {
    return fail(
      'off-mount',
      `The device isn't turned to mount "${mount.id}": its +x along ${mount.axis}, front ${mount.facing}`,
    );
  }
  const mine = footprint(catalog, host, mount, ref, position, state);
  if (mine === null) return fail('off-mount', `The device's position isn't on mount "${mount.id}"`);
  const occupancy = mountType(mount.type)?.occupancy ?? 'single';
  for (const other of world.entities) {
    if (other.id === self || other.mountedOn?.entity !== host.id || other.mountedOn.mount !== mount.id) continue;
    const theirs = footprint(catalog, host, mount, other.ref, other.transform.positionMm, other.state);
    const crowded =
      occupancy === 'single' ||
      theirs === null ||
      (overlap(mine.along, mine.along + mine.width, theirs.along, theirs.along + theirs.width) &&
        (occupancy === 'linear' ||
          overlap(mine.cross, mine.cross + mine.height, theirs.cross, theirs.cross + theirs.height)));
    if (crowded) return fail('mount-full', `Mount "${mount.id}" has no room there (entity ${other.id})`);
  }
  return null;
}
