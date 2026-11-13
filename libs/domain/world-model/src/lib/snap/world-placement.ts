/**
 * Placement in a world (F3.5 part 1): from a cursor point to the exact arguments of `entity.place`
 * (with `mountedOn`) or `entity.move`, for built-in props **and catalogue devices**, onto the level's
 * fixtures or onto the mounts of enclosures already placed. The renderer's ghost, the keyboard
 * reticle and scripts all call {@link placeInWorld}, so they produce identical commands and hashes.
 *
 * Order of preference, all pure integer maths (no trigonometry, no clock):
 * 0. **A conduit end or an open entry** (F3.5 part 2), for an EMT-lite part being placed: within
 *    `RACEWAY_CAPTURE_DISTANCE` of an open enclosure entry of its trade size (a connector) or of a free
 *    end of a placed conduit part of its size, the part's end goes there, facing it (`snapConduit`;
 *    `options.turn` picks among the four turns about that end). Otherwise it is placed like any part.
 * 1. **An enclosure mount the device fits** (a breaker onto a panel's DIN rail, a device into a box's
 *    yoke), when the cursor is on it: within {@link MOUNT_CAPTURE_DEPTH} of the mount's plane and over
 *    the place the device would take. Rails win over yokes, yokes over backplates (most specific
 *    first, as `SNAP_PRIORITY` does for fixtures), then the nearer plane, then the target id. The
 *    position snaps to DIN module slots along a rail (`dinSlotStartMm`, as on the workshop's rails; a
 *    device narrower than `NARROW_RAIL_DEVICE`, a terminal block, to multiples of its own width, at
 *    its declared `crossMm`) and
 *    to the 5 mm backplate grid on an area mount; a yoke takes the device exactly. The orientation is
 *    the mount's frame composed with the host's (`orientationForAxes`), so `checkMount` accepts it.
 * 2. **A fixture** (the workshop's backplate, rails, stud wall and bench top), as `placeOnTargets`
 *    does for props. A catalogue device takes its body's width and height as its footprint, and snaps
 *    to a fixture DIN rail only if it fits `din35`. A fixture is never a host, so `mountedOn` is `null`.
 *
 * Then the same checks the commands make, so a valid ghost always commits: the mount rules
 * (`checkMount`: `mount-full`, `off-mount`, …), whether the entity being moved can move at all
 * (`occupied`, `wired`), and overlap with **every** other body (`overlappingEntity` in the `all`
 * scope, stricter than the commands' `mounting` scope: the mouse never stacks two props).
 *
 * Moving keeps the orientation and the mount (`entity.move` changes the position only): a mounted
 * device slides along its own mount, a free one moves between fixtures that mount it the same way.
 */
import {
  type BodyState,
  BUILTIN_CATALOG,
  type Catalog,
  deviceBodySizeMm,
  deviceMountWidthMm,
  type EnclosureMount,
  mountType,
} from '@controls/catalog';
import { entityHold, findEntity } from '../entity-commands';
import { builtinProp, propFootprint } from '../props';
import type { CatalogRef, EntityId, MountedOn, OrientationMdeg, World } from '../types';
import { checkMount, mountFrame } from '../wiring/mounting';
import { overlappingEntity } from '../wiring/overlap';
import { MOUNT_CAPTURE_DEPTH, NARROW_RAIL_DEVICE } from './constants';
import { snapConduit } from './raceway-placement';
import { isMountedOrientation, orientationForFrame, type PlacementFailure } from './placement';
import { entityPointMm, orientationForAxes } from './quarter-turn';
import { snapToBest } from './resolve';
import { dinSlotStartMm, SNAP_STEPS, type Footprint, type SnapTarget } from './snap';
import { assertIntegerMm, type Vec3Mm } from './surface';

/** A deeply readonly view of `T` (what a script's `game.world()` gives). */
type Frozen<T> = T extends (infer E)[]
  ? readonly Frozen<E>[]
  : T extends object
    ? { readonly [K in keyof T]: Frozen<T[K]> }
    : T;

/** The parts of a world placement reads, as the commands see them. */
type CheckedWorld = Pick<World, 'entities' | 'connections' | 'cables'>;

/**
 * What placement reads of a world: its entities, and what holds them (`occupied`, `wired`). Deeply
 * readonly, so a session's world and a script's `game.world()` view both fit; nothing is written.
 */
export type PlacementWorld = Frozen<CheckedWorld>;

/** An enclosure's mount in world space, as a placement target. */
export interface MountTarget {
  readonly kind: 'mount';
  /** `entity-<id>:<mount>`: the host's selectable id and the mount's catalogue id. */
  readonly id: string;
  readonly entity: EntityId;
  readonly mount: EnclosureMount;
  readonly occupancy: 'single' | 'linear' | 'area';
  /** Where a mounted device's origin goes at `along = cross = 0` (world integer mm). */
  readonly origin: Vec3Mm;
  /** The mounted device's +x (`axis`), +y and +z (`facing`) in world directions (integer unit vectors). */
  readonly axes: { readonly x: Vec3Mm; readonly y: Vec3Mm; readonly z: Vec3Mm };
}

/** The target id of mount `mount` of entity `entity`. */
export const mountTargetId = (entity: EntityId, mount: string): string => `entity-${entity}:${mount}`;

/**
 * Every enclosure mount in a world, in entity id order then catalogue order: what devices snap to
 * besides the fixtures. Hosts that aren't at quarter-turns offer none (their mounts can't be placed
 * exactly; the commands refuse them as `not-axis-aligned`).
 */
export function worldMountTargets(
  world: Frozen<Pick<World, 'entities'>>,
  catalog: Catalog = BUILTIN_CATALOG,
): MountTarget[] {
  const targets: MountTarget[] = [];
  for (const host of (world as Pick<World, 'entities'>).entities) {
    for (const mount of catalog.device(host.ref)?.enclosure?.mounts ?? []) {
      const origin = entityPointMm(host.transform, mount.positionMm);
      const axes = mountFrame(host, mount);
      if (origin === null || axes === null) continue;
      targets.push({
        kind: 'mount',
        id: mountTargetId(host.id, mount.id),
        entity: host.id,
        mount,
        occupancy: mountType(mount.type)?.occupancy ?? 'single',
        origin,
        axes,
      });
    }
  }
  return targets;
}

/** Why a placement in a world can't be committed: a snap failure, or the refusal the command would give. */
export type WorldPlacementFailure =
  | PlacementFailure
  | 'occupied'
  | 'wired'
  | 'overlaps'
  | 'mount-full'
  | 'off-mount'
  | 'mount-mismatch'
  | 'not-axis-aligned'
  | 'unknown-mount'
  | 'not-found';

export type WorldPlacement =
  | {
      readonly ok: true;
      readonly targetId: string;
      readonly kind: SnapTarget['kind'] | 'mount' | 'raceway';
      /** Exactly the `entity.place` / `entity.move` position. */
      readonly positionMm: Vec3Mm;
      /** Exactly the `entity.place` orientation (a move keeps the entity's). */
      readonly orientationMdeg: OrientationMdeg;
      /** Exactly the `entity.place` `mountedOn` (a move keeps the entity's). */
      readonly mountedOn: MountedOn | null;
    }
  | { readonly ok: false; readonly reason: WorldPlacementFailure; readonly targetId: string | null };

export interface WorldPlacementOptions {
  /** The catalogue refs resolve against (default: the built-in one). */
  readonly catalog?: Catalog;
  /** Move this entity instead of placing `ref`: it keeps its orientation and mount. */
  readonly moving?: EntityId | null;
  /** Which of the four turns a conduit part snapped to an end takes (any integer, modulo 4; default 0). */
  readonly turn?: number;
}

/** A body's outline: width along its +x (a cut part's length), height along its +y (integer mm). */
function bodyFootprint(catalog: Catalog, ref: CatalogRef, state: BodyState): Footprint | undefined {
  const prop = propFootprint(ref);
  if (prop) return prop;
  const device = catalog.device(ref);
  const size = device && deviceBodySizeMm(device, state);
  return size ? { widthMm: size.widthMm, heightMm: size.heightMm } : undefined;
}

const dot = (p: Vec3Mm, q: Vec3Mm): number => p.x * q.x + p.y * q.y + p.z * q.z;
const sameOrientation = (a: OrientationMdeg, b: OrientationMdeg): boolean =>
  a.yaw === b.yaw && a.pitch === b.pitch && a.roll === b.roll;
const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/** Most specific first: a rail, then a yoke, then a backplate. */
const OCCUPANCY_PRIORITY: Readonly<Record<MountTarget['occupancy'], number>> = { linear: 0, single: 1, area: 2 };

/** Where on a mount the device goes for a cursor at (`along`, `cross`), or `null` if the cursor isn't on it. */
function snapOnMount(
  target: MountTarget,
  width: number,
  height: number,
  along: number,
  cross: number,
  crossMm: number,
): { along: number; cross: number } | null {
  const extent = target.mount.extentMm;
  switch (target.occupancy) {
    case 'single':
      return along >= 0 && along <= width && cross >= 0 && cross <= height ? { along: 0, cross: 0 } : null;
    case 'linear': {
      if (along < 0 || along > extent || cross < crossMm || cross > crossMm + height) return null;
      const free = extent - width;
      if (free < 0) return null;
      // A terminal block packs at its own width; a modular device takes DIN module slots.
      const narrow = width < NARROW_RAIL_DEVICE.valueMm;
      const pitch = narrow ? width : SNAP_STEPS.dinModulePitchMm;
      const k = clamp(Math.round((along - width / 2) / pitch), 0, Math.floor(free / pitch));
      return { along: narrow ? k * width : dinSlotStartMm(k), cross: crossMm };
    }
    case 'area': {
      if (along < 0 || along > extent || cross < 0 || cross > extent) return null;
      const freeU = extent - width;
      const freeV = extent - height;
      if (freeU < 0 || freeV < 0) return null;
      const pitch = SNAP_STEPS.backplateGridMm;
      const ku = clamp(Math.round((along - width / 2) / pitch), 0, Math.floor(freeU / pitch));
      const kv = clamp(Math.round((cross - height / 2) / pitch), 0, Math.floor(freeV / pitch));
      return { along: ku * pitch, cross: kv * pitch };
    }
  }
}

interface MountCandidate {
  readonly target: MountTarget;
  readonly depth: number;
  readonly along: number;
  readonly cross: number;
}

/**
 * The best mount for `ref` under the cursor (see the module comment), with the device's snapped
 * offset on it, or `null` when the cursor is on no mount the device fits. `only` restricts the
 * search to one mount (sliding a mounted device); `state` is the device's commanded state (a cut
 * part's length), `null` for one not placed yet.
 */
function bestMount(
  catalog: Catalog,
  ref: CatalogRef,
  cursor: Vec3Mm,
  targets: readonly MountTarget[],
  only: MountedOn | null,
  state: BodyState,
): MountCandidate | null {
  const device = catalog.device(ref);
  const height = device ? deviceBodySizeMm(device, state)?.heightMm : undefined;
  if (!device || height === undefined) return null;
  const candidates: MountCandidate[] = [];
  for (const target of targets) {
    if (only !== null && (target.entity !== only.entity || target.mount.id !== only.mount)) continue;
    const fit = device.mounts.find((m) => m.type === target.mount.type);
    const width = deviceMountWidthMm(device, target.mount.type, state);
    if (fit === undefined || width === undefined) continue;
    const d = { x: cursor.x - target.origin.x, y: cursor.y - target.origin.y, z: cursor.z - target.origin.z };
    const depth = Math.abs(dot(d, target.axes.z));
    if (depth > MOUNT_CAPTURE_DEPTH.valueMm) continue;
    const at = snapOnMount(target, width, height, dot(d, target.axes.x), dot(d, target.axes.y), fit.crossMm);
    if (at !== null) candidates.push({ target, depth, ...at });
  }
  candidates.sort(
    (a, b) =>
      OCCUPANCY_PRIORITY[a.target.occupancy] - OCCUPANCY_PRIORITY[b.target.occupancy] ||
      a.depth - b.depth ||
      (a.target.id < b.target.id ? -1 : a.target.id > b.target.id ? 1 : 0),
  );
  return candidates[0] ?? null;
}

/** Whether a catalogue device may snap to a fixture target (a fixture DIN rail needs a `din35` fit; props go anywhere). */
function fitsFixture(catalog: Catalog, ref: CatalogRef, target: SnapTarget): boolean {
  if (target.kind !== 'din-rail' || builtinProp(ref)) return true;
  return catalog.device(ref)?.mounts.some((m) => m.type === 'din35') ?? false;
}

/**
 * Where `ref` (or, with `options.moving`, that entity) goes when the cursor is at `cursorWorld`
 * (integer mm) in `world`, among the world's enclosure mounts and the fixture `targets`
 * (`worldSnapTargets(world)`). On success the fields are exactly the command arguments; on failure,
 * the snap failure or the refusal the command would give.
 */
export function placeInWorld(
  view: PlacementWorld,
  ref: CatalogRef,
  cursorWorld: Vec3Mm,
  targets: readonly SnapTarget[],
  options: WorldPlacementOptions = {},
): WorldPlacement {
  assertIntegerMm('cursor.x', cursorWorld.x);
  assertIntegerMm('cursor.y', cursorWorld.y);
  assertIntegerMm('cursor.z', cursorWorld.z);
  // Read only: the checks take the commands' (mutable) types but never write.
  const world = view as CheckedWorld;
  const catalog = options.catalog ?? BUILTIN_CATALOG;
  const moving = options.moving ?? null;
  const entity = moving === null ? undefined : findEntity(world, moving);
  if (moving !== null && !entity) return { ok: false, reason: 'not-found', targetId: null };
  const placed = entity?.ref ?? ref;
  if (catalog.kindOf(placed)?.placement === 'connection') return { ok: false, reason: 'unknown-prop', targetId: null };
  const state = entity?.state ?? null;
  const footprint = bodyFootprint(catalog, placed, state);
  if (!footprint) return { ok: false, reason: 'unknown-prop', targetId: null };
  if (entity) {
    const hold = entityHold(world, entity.id);
    if (hold !== null) return { ok: false, reason: hold, targetId: null };
  }
  const keepMount = entity?.mountedOn ?? null;

  // 0. A conduit part being placed, near an open entry or a free conduit end (never on a move).
  if (!entity) {
    const conduit = snapConduit(world, catalog, placed, cursorWorld, options.turn ?? 0);
    if (conduit) {
      const { targetId, positionMm, orientationMdeg } = conduit;
      return checked(world, catalog, placed, targetId, 'raceway', positionMm, orientationMdeg, null, null, null);
    }
  }

  // 1. An enclosure mount (only the entity's own when it is mounted; none for a free entity's move).
  if (!entity || keepMount !== null) {
    const found = bestMount(catalog, placed, cursorWorld, worldMountTargets(world, catalog), keepMount, state);
    if (found) {
      const { target } = found;
      const { x, y, z } = target.axes;
      const positionMm = {
        x: target.origin.x + found.along * x.x + found.cross * y.x + 0,
        y: target.origin.y + found.along * x.y + found.cross * y.y + 0,
        z: target.origin.z + found.along * x.z + found.cross * y.z + 0,
      };
      const orientationMdeg = entity?.transform.orientationMdeg ?? orientationForAxes(x, z);
      const mountedOn = { entity: target.entity, mount: target.mount.id };
      return checked(world, catalog, placed, target.id, 'mount', positionMm, orientationMdeg, mountedOn, moving, state);
    }
    if (keepMount !== null) return { ok: false, reason: 'off-mount', targetId: null };
  }

  // 2. A fixture, as `placeOnTargets` does for props (a move only among same-facing targets).
  let candidates = targets.filter((t) => fitsFixture(catalog, placed, t));
  const keep = entity?.transform.orientationMdeg;
  if (keep) {
    if (!isMountedOrientation(keep)) return { ok: false, reason: 'orientation-mismatch', targetId: null };
    candidates = candidates.filter((t) => sameOrientation(orientationForFrame(t.frame), keep));
  }
  const result = snapToBest(candidates, footprint, cursorWorld);
  if (!result) return { ok: false, reason: 'no-target', targetId: null };
  if (!result.ok) return { ok: false, reason: result.reason, targetId: result.targetId };
  const target = candidates.find((t) => t.id === result.targetId && t.kind === result.kind) as SnapTarget;
  const orientationMdeg = keep ?? orientationForFrame(target.frame);
  return checked(world, catalog, placed, target.id, target.kind, result.world, orientationMdeg, null, moving, state);
}

/** The snapped placement, unless the command would refuse it (mount rules) or it overlaps a body. */
function checked(
  world: CheckedWorld,
  catalog: Catalog,
  ref: CatalogRef,
  targetId: string,
  kind: SnapTarget['kind'] | 'mount' | 'raceway',
  positionMm: Vec3Mm,
  orientationMdeg: OrientationMdeg | null,
  mountedOn: MountedOn | null,
  self: EntityId | null,
  state: BodyState,
): WorldPlacement {
  if (orientationMdeg === null) return { ok: false, reason: 'not-axis-aligned', targetId };
  if (mountedOn !== null) {
    const refused = checkMount(world, catalog, ref, positionMm, orientationMdeg, mountedOn, self, state);
    if (refused) return { ok: false, reason: refused.code as WorldPlacementFailure, targetId };
  }
  const transform = { positionMm, orientationMdeg };
  if (overlappingEntity(world, catalog, ref, transform, mountedOn, self, 'all', state) !== null) {
    return { ok: false, reason: 'overlaps', targetId };
  }
  return { ok: true, targetId, kind, positionMm, orientationMdeg, mountedOn };
}
