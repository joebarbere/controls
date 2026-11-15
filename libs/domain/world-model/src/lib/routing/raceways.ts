import { type Catalog, deviceBodySizeMm, racewayOf, racewayPorts } from '@controls/catalog';
import { bodyBox } from '../wiring/checks';
import { entityPointMm, rotateQuarterTurns } from '../snap/quarter-turn';
import type { Entity, EntityId, PositionMm, World } from '../types';
import type { BoxMm } from './collide';
import { ARC_COS, ARC_SIN, BAKE_UNITS_PER_MM, HALF_SQRT2 } from './constants';
import { type Vec3, UNIT } from './vec';

/*
 * The raceways a route can follow (ADR 0017): every axis-aligned duct and conduit part in the world,
 * with its axis in world integer mm. A duct or conduit waypoint sits on its host's axis (ADR 0015,
 * "The route shape"); the router walks duct axes, the snapper projects onto them, and the bake draws
 * runs along them with lane offsets in the part's own cross-section.
 *
 * Axes (in the part's frame; every value an integer, so the world axis is exact):
 * - a duct of cut length L, section `heightMm` × `depthMm`: (0, ⌊h/2⌋, ⌊d/2⌋) to (L, ⌊h/2⌋, ⌊d/2⌋), the
 *   middle of its trough (half-sizes rounded down, so a 25 mm duct's axis is at 12 mm);
 * - an EMT-lite stick or connector: its two ports, (0, D/2, D/2) and (L, D/2, D/2) (D even);
 * - an elbow: its two ports; the bake draws its legs and a quarter circle between them.
 */

/** A raceway part a route can follow. */
export interface RacewayPath {
  readonly entity: EntityId;
  readonly kind: 'duct' | 'conduit';
  /** Its model kind (`raceway.duct`, `raceway.conduit`, `raceway.conduitElbow`, `raceway.conduitConnector`). */
  readonly modelKind: string;
  /** The axis's two ends in world integer mm (an elbow's ports). */
  readonly a: PositionMm;
  readonly b: PositionMm;
  /** Whether the axis is the straight segment a–b (every part but an elbow). */
  readonly straight: boolean;
  /** The drawn centreline from `a` to `b` in world mm (an elbow's legs and arc; fractional on the arc). */
  readonly centreline: readonly Vec3[];
  /** The part's body box (world integer mm). */
  readonly box: BoxMm;
  /** World unit vectors of the part's own +y and +z: the plane lanes are laid out in. */
  readonly across: PositionMm;
  readonly up: PositionMm;
  /**
   * Where lanes may go, relative to the axis, in tenths of mm along `across` and `up`: a duct's trough
   * (inside its walls, from its floor up to the cover), or the square inside a tube.
   */
  readonly interior: {
    readonly acrossMin: number;
    readonly acrossMax: number;
    readonly upMin: number;
    readonly upMax: number;
  };
}

const tenths = (mm: number): number => Math.round(mm * BAKE_UNITS_PER_MM);

/** The raceway path of one entity, or `null` (not a raceway, unknown, or not at quarter-turns). */
export function racewayPath(entity: Entity, catalog: Catalog): RacewayPath | null {
  const device = catalog.device(entity.ref);
  const kind = device ? racewayOf(device) : null;
  const size = device ? deviceBodySizeMm(device, entity.state) : null;
  if (!device || kind === null || size === null) return null;
  const across = rotateQuarterTurns(entity.transform.orientationMdeg, UNIT['+y']);
  const up = rotateQuarterTurns(entity.transform.orientationMdeg, UNIT['+z']);
  if (across === null || up === null) return null;
  const world = (local: Vec3): Vec3 => entityPointMm(entity.transform, local) as Vec3;
  const box = bodyBox(entity, size);
  const p = device.model.params;
  if (kind === 'duct') {
    const hy = Math.floor(size.heightMm / 2);
    const hz = Math.floor(size.depthMm / 2);
    const a = world({ x: 0, y: hy, z: hz }) as PositionMm;
    const b = world({ x: size.widthMm, y: hy, z: hz }) as PositionMm;
    const wall = p['wallThicknessMm'];
    return {
      entity: entity.id,
      kind,
      modelKind: device.model.kind,
      a,
      b,
      straight: true,
      centreline: [a, b],
      box,
      across,
      up,
      interior: {
        acrossMin: tenths(wall - hy),
        acrossMax: tenths(size.heightMm - wall - hy),
        upMin: tenths(wall - hz),
        upMax: tenths(size.depthMm - hz),
      },
    };
  }
  const ports = racewayPorts(device, entity.state);
  if (ports.length !== 2) return null;
  const a = world(ports[0].positionMm) as PositionMm;
  const b = world(ports[1].positionMm) as PositionMm;
  const inside = p['outsideDiameterMm'] - 2 * p['wallThicknessMm'];
  const half = tenths((inside * HALF_SQRT2) / 2);
  const interior = { acrossMin: -half, acrossMax: half, upMin: -half, upMax: half };
  const elbow = device.model.kind === 'raceway.conduitElbow';
  return {
    entity: entity.id,
    kind,
    modelKind: device.model.kind,
    a,
    b,
    straight: !elbow,
    centreline: elbow ? elbowCentreline(size.depthMm / 2, p['legLengthMm'], p['bendRadiusMm']).map(world) : [a, b],
    box,
    across,
    up,
    interior,
  };
}

/**
 * An elbow's centreline in its own frame (r = D/2, leg L, bend radius R): from port a (r, 0, r) up its
 * first leg to (r, L, r), a quarter circle about (r + R, L, r) to (r + R, L + R, r), then its second
 * leg to port b (r + R + L, L + R, r). Seven arc points at 15° steps, from literal cosines.
 */
export function elbowCentreline(r: number, leg: number, bend: number): Vec3[] {
  const points: Vec3[] = [{ x: r, y: 0, z: r }];
  for (let k = 0; k < ARC_COS.length; k++) {
    points.push({ x: r + bend - bend * ARC_COS[k], y: leg + bend * ARC_SIN[k], z: r });
  }
  points.push({ x: r + bend + leg, y: leg + bend, z: r });
  // A bare quarter circle (leg 0) starts and ends on the arc: drop the repeated ends.
  return points.filter((p, i) => i === 0 || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
}

/** Every raceway path in the world, in entity id order. */
export function racewayPaths(world: Pick<World, 'entities'>, catalog: Catalog): RacewayPath[] {
  const paths: RacewayPath[] = [];
  for (const entity of world.entities) {
    const path = racewayPath(entity, catalog);
    if (path) paths.push(path);
  }
  return paths;
}

/**
 * The point of a straight raceway's axis nearest to `p` (integer `p`: the result is integer, since the
 * axis runs along one world axis), and its squared distance.
 */
export function nearestOnAxis(path: Pick<RacewayPath, 'a' | 'b'>, p: PositionMm): { point: PositionMm; d2: number } {
  const point = {
    x: Math.min(Math.max(p.x, Math.min(path.a.x, path.b.x)), Math.max(path.a.x, path.b.x)),
    y: Math.min(Math.max(p.y, Math.min(path.a.y, path.b.y)), Math.max(path.a.y, path.b.y)),
    z: Math.min(Math.max(p.z, Math.min(path.a.z, path.b.z)), Math.max(path.a.z, path.b.z)),
  };
  const dx = point.x - p.x;
  const dy = point.y - p.y;
  const dz = point.z - p.z;
  return { point, d2: dx * dx + dy * dy + dz * dz };
}
