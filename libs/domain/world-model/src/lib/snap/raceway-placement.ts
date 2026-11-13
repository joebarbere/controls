/**
 * Conduit snapping (F3.5 part 2): where an EMT-lite part goes when the cursor is near an open
 * enclosure entry of its trade size (a connector's entry end goes into it) or near a free end of a
 * conduit part already placed (the new part's first end meets it, facing it). Pure integer
 * quarter-turn maths, shared by the renderer's ghost, scripts and `sim-cli` through `placeInWorld`.
 *
 * The orientation is solved, not chosen by the target: a part's end must point a given world way, which
 * leaves four turns about that axis. They are ranked by where the part's +z then +y end up (world
 * +y, +z, +x, −x, −z, −y in that order: an elbow on a horizontal run turns up first) and `turn`
 * picks among them (the ghost's turn key cycles it), so every choice is reproducible.
 */
import {
  type Axis,
  type Catalog,
  conduitTradeSize,
  racewayOf,
  racewayPorts,
  type RacewayPort,
} from '@controls/catalog';
import type { CatalogRef, EntityId, OrientationMdeg, PositionMm, World } from '../types';
import { entryOpen } from '../wiring/checks';
import { RACEWAY_CAPTURE_DISTANCE } from './constants';
import { entityPointMm, orientationForAxes, rotateQuarterTurns } from './quarter-turn';

const UNIT: Readonly<Record<Axis, PositionMm>> = {
  '+x': { x: 1, y: 0, z: 0 },
  '-x': { x: -1, y: 0, z: 0 },
  '+y': { x: 0, y: 1, z: 0 },
  '-y': { x: 0, y: -1, z: 0 },
  '+z': { x: 0, y: 0, z: 1 },
  '-z': { x: 0, y: 0, z: -1 },
};

/** World directions in preference order for a part's +z (then +y). */
const PREFERRED: readonly PositionMm[] = [UNIT['+y'], UNIT['+z'], UNIT['+x'], UNIT['-x'], UNIT['-z'], UNIT['-y']];

const same = (p: PositionMm, q: PositionMm): boolean => p.x === q.x && p.y === q.y && p.z === q.z;
const neg = (p: PositionMm): PositionMm => ({ x: -p.x + 0, y: -p.y + 0, z: -p.z + 0 });
const dot = (p: PositionMm, q: PositionMm): number => p.x * q.x + p.y * q.y + p.z * q.z;
const cross = (p: PositionMm, q: PositionMm): PositionMm => ({
  x: p.y * q.z - p.z * q.y + 0,
  y: p.z * q.x - p.x * q.z + 0,
  z: p.x * q.y - p.y * q.x + 0,
});
const rank = (v: PositionMm): number => PREFERRED.findIndex((p) => same(p, v));

/**
 * The four quarter-turn orientations that turn local direction `local` onto world direction `world`
 * (unit axis vectors), ranked (see the module comment), each as its canonical yaw-pitch-roll triple.
 */
export function orientationsTurning(local: PositionMm, world: PositionMm): OrientationMdeg[] {
  const found: { o: OrientationMdeg; z: PositionMm; y: PositionMm }[] = [];
  for (const zWorld of PREFERRED) {
    for (const xWorld of PREFERRED) {
      if (dot(xWorld, zWorld) !== 0) continue;
      const o = orientationForAxes(xWorld, zWorld) as OrientationMdeg; // perpendicular unit axes: always found
      const image = rotateQuarterTurns(o, local);
      if (image !== null && same(image, world)) found.push({ o, z: zWorld, y: cross(zWorld, xWorld) });
    }
  }
  found.sort((a, b) => rank(a.z) - rank(b.z) || rank(a.y) - rank(b.y));
  return found.map((f) => f.o);
}

/** A place a conduit part's end can go: an open entry or a free conduit end, in world space. */
export interface RacewayTarget {
  /** `entity-<id>:<entry>` for an entry, `entity-<id>:end-<a|b>` for a conduit end. */
  readonly id: string;
  readonly kind: 'entry' | 'joint';
  readonly entity: EntityId;
  readonly pointMm: PositionMm;
  /** The direction the arriving end must point: into the enclosure, or into the part it meets. */
  readonly arriveAlong: PositionMm;
}

type TargetWorld = Pick<World, 'entities'>;

/** The world ends of every conduit part (axis-aligned ones only), with their entity. */
function placedEnds(world: TargetWorld, catalog: Catalog) {
  const ends: { entity: EntityId; port: RacewayPort; point: PositionMm; axis: PositionMm; size: string | null }[] = [];
  for (const e of world.entities) {
    const device = catalog.device(e.ref);
    if (!device || racewayOf(device) !== 'conduit') continue;
    for (const port of racewayPorts(device, e.state)) {
      const point = entityPointMm(e.transform, port.positionMm);
      const axis = rotateQuarterTurns(e.transform.orientationMdeg, UNIT[port.axis]);
      if (point && axis) ends.push({ entity: e.id, port, point, axis, size: conduitTradeSize(device) });
    }
  }
  return ends;
}

/**
 * Where a conduit part of trade size `size` may go: each open enclosure entry of that size (for a
 * connector), and each free joint end of a placed conduit part of that size (one no other part's end
 * meets), in entity id order then catalogue order.
 */
export function racewayTargets(
  world: TargetWorld,
  catalog: Catalog,
  size: string,
  forConnector: boolean,
): RacewayTarget[] {
  const targets: RacewayTarget[] = [];
  const ends = placedEnds(world, catalog);
  for (const host of world.entities) {
    const enclosure = forConnector ? catalog.device(host.ref)?.enclosure : null;
    enclosure?.entries.forEach((entry, index) => {
      if (entry.tradeSize !== size || !entryOpen(host, index)) return;
      const point = entityPointMm(host.transform, entry.positionMm);
      const inward = rotateQuarterTurns(host.transform.orientationMdeg, UNIT[entry.axis]);
      if (point && inward) {
        targets.push({
          id: `entity-${host.id}:${entry.id}`,
          kind: 'entry',
          entity: host.id,
          pointMm: point,
          arriveAlong: inward,
        });
      }
    });
  }
  for (const end of ends) {
    if (end.size !== size || end.port.kind !== 'joint') continue;
    if (ends.some((o) => o.entity !== end.entity && same(o.point, end.point))) continue;
    targets.push({
      id: `entity-${end.entity}:end-${end.port.id}`,
      kind: 'joint',
      entity: end.entity,
      pointMm: end.point,
      arriveAlong: neg(end.axis),
    });
  }
  return targets;
}

/** A conduit part's snapped placement: exactly the `entity.place` position and orientation. */
export interface RacewaySnap {
  readonly targetId: string;
  readonly positionMm: PositionMm;
  readonly orientationMdeg: OrientationMdeg;
}

/**
 * The placement of conduit part `ref` for a cursor at `cursor` (integer mm): the nearest target
 * within {@link RACEWAY_CAPTURE_DISTANCE} (ties by target id), the part's end that fits it (a
 * connector's entry end into an entry, else its first joint end) on the target's point, turned by
 * `turn` (modulo the four turns). `null` when `ref` isn't a conduit part or no target is in reach.
 */
export function snapConduit(
  world: TargetWorld,
  catalog: Catalog,
  ref: CatalogRef,
  cursor: PositionMm,
  turn = 0,
): RacewaySnap | null {
  const device = catalog.device(ref);
  const size = device && conduitTradeSize(device);
  if (!device || !size) return null;
  const ports = racewayPorts(device, null);
  const entryPort = ports.find((p) => p.kind === 'entry');
  const jointPort = ports.find((p) => p.kind === 'joint');
  const reach = RACEWAY_CAPTURE_DISTANCE.valueMm;
  let best: { target: RacewayTarget; d2: number } | null = null;
  for (const target of racewayTargets(world, catalog, size, entryPort !== undefined)) {
    const dx = target.pointMm.x - cursor.x;
    const dy = target.pointMm.y - cursor.y;
    const dz = target.pointMm.z - cursor.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > reach * reach) continue;
    if (best === null || d2 < best.d2 || (d2 === best.d2 && target.id < best.target.id)) best = { target, d2 };
  }
  if (best === null) return null;
  const { target } = best;
  const port = target.kind === 'entry' ? entryPort : jointPort;
  if (!port) return null;
  const turns = orientationsTurning(UNIT[port.axis], target.arriveAlong);
  if (turns.length === 0) return null;
  const orientationMdeg = turns[((turn % turns.length) + turns.length) % turns.length];
  const offset = rotateQuarterTurns(orientationMdeg, port.positionMm) as PositionMm;
  const p = target.pointMm;
  return {
    targetId: target.id,
    positionMm: { x: p.x - offset.x + 0, y: p.y - offset.y + 0, z: p.z - offset.z + 0 },
    orientationMdeg,
  };
}
