import {
  type Axis,
  type BodyState,
  type Catalog,
  deviceBodySizeMm,
  type DeviceMount,
  deviceMountWidthMm,
  type EnclosureMount,
  mountType,
  offeredMounts,
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
 * - `single` (a device yoke): exactly at the device's anchor on the mount (along = its fit's `alongMm`,
 *   cross = its `crossMm`; both 0 on every catalogue-2 entry, catalogue v3 R4);
 * - `linear` (a DIN rail): cross = the device's declared `crossMm` (0 for a DIN 43880 modular device; a
 *   terminal block declares the offset that centres it on the rail, F3.5 part 2) and
 *   0 ≤ along ≤ extentMm − widthMm (the device's declared width); on a bus mount (`busStab`, P4) along
 *   is exactly a stab position and every contact's stab is on the bus (`busStabIndex`);
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
      ? along === fit.alongMm && across === fit.crossMm
      : occupancy === 'linear'
        ? across === fit.crossMm && along >= 0 && along + width <= mount.extentMm && onStabs(mount, fit, along)
        : along >= 0 && along + width <= mount.extentMm && across >= 0 && across + height <= mount.extentMm;
  return fits ? { along, cross: across, width, height } : null;
}

/**
 * The stab index whose position along a bus mount is exactly `along` (integer mm from the mount's
 * origin), or `null`: stab k sits at `round(k × pitchMm)` (the pitch is an integer, so exactly
 * `k × pitchMm`), found by **exact lookup**, never by division (ADR 0019 "What the netlist compiler
 * reads" 2; ADR 0020 deviation 5). `null` for a mount without a bus pattern.
 */
export function busStabAt(mount: EnclosureMount, along: number): number | null {
  const bus = mount.bus;
  if (bus === null) return null;
  for (let k = 0; k < bus.stabs; k++) if (k * bus.pitchMm === along) return k;
  return null;
}

/**
 * `busStabIndex(host, mount, positionMm)`: the stab index (from 0) of the bus mount `mount` of `host`
 * a device whose origin is at `positionMm` (world integer mm) sits on, or `null` when the position isn't
 * on the mount's plane and cross line or isn't exactly a stab position, or the mount has no bus. The one
 * function `checkMount`, snapping, the ghost, the compiler (P4 PR 9) and the inspector use, so they
 * agree on every breaker's space and leg ({@link busStabLeg}).
 */
export function busStabIndex(
  host: Pick<Entity, 'transform'>,
  mount: EnclosureMount,
  positionMm: PositionMm,
): number | null {
  const offset = mountOffset(host, mount, positionMm);
  if (offset === null || offset.normal !== 0) return null;
  return busStabAt(mount, offset.along);
}

/**
 * The host terminal (a bus bar, `busL1` or `busL2`) stab `index` of a bus mount reaches: `legs[k mod 2]`,
 * each column alternating legs by row, so with both columns starting on the same leg spaces 1 and 2
 * are on L1 and 3 and 4 on L2 (ADR 0019 deviation 6). `null` off the bus or for a mount without one.
 * A multi-pole device's contact reaches the stab `index + positionOffset`.
 */
export function busStabLeg(mount: EnclosureMount, index: number): string | null {
  const bus = mount.bus;
  if (bus === null || !Number.isInteger(index) || index < 0 || index >= bus.stabs) return null;
  return bus.legs[index % 2];
}

/**
 * On a bus mount (`busStab`, catalogue v3), a device's origin is on a stab and each of its contacts'
 * stabs (`positionOffset` whole positions along) is on the bus too, so a two-pole breaker always reaches
 * both legs. Every other linear mount is continuous. A rule only P4 entries can meet.
 */
function onStabs(mount: EnclosureMount, fit: DeviceMount, along: number): boolean {
  if (mount.bus === null) return true;
  const index = busStabAt(mount, along);
  if (index === null) return false;
  return fit.contacts.every((c) => index + c.positionOffset < (mount.bus?.stabs ?? 0));
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
  // The host's offered mounts (catalogue v3): an enclosure's, or a non-enclosure's `hostMounts` (a
  // lampholder's `e26`), so a host need not be an enclosure (world v4, ADR 0020 R5).
  const hostDevice = catalog.device(host.ref);
  const mount = hostDevice && offeredMounts(hostDevice).find((m) => m.id === mountedOn.mount);
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
