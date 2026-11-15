import type { Catalog } from '@controls/catalog';
import { fixtureSnapTarget, fixtureSpec } from '../fixtures';
import { WALL_STUD_DEPTH } from '../snap/constants';
import { SNAP_STEPS, studCentres, type WallStudsTarget } from '../snap/snap';
import { surfaceToWorld, worldToSurface } from '../snap/surface';
import type { CatalogRef, PositionMm, Waypoint, World } from '../types';
import { ROUTE_SNAP_CAPTURE } from './constants';
import { nearestOnAxis, racewayPaths } from './raceways';
import { distance2 } from './vec';

/*
 * Waypoint snapping (ADR 0017): the domain snapper every surface uses to turn a cursor point into a
 * route waypoint, so a click, a console line and a script put a waypoint at the same place. A hosted
 * waypoint's `positionMm` is the snapper's point on its host's axis (ADR 0015, "The route shape"):
 *
 * - `duct`: the nearest point of a duct's axis (the middle of its trough, `racewayPath`);
 * - `conduit`: the nearest point of an EMT-lite stick's or connector's axis, or the nearer port of an
 *   elbow (a waypoint mid-bend would cut the corner);
 * - `staple`: on the side face of a stud (a `prop.stud-wall` fixture) that faces the cursor (half a
 *   stud's thickness, rounded up as `snapToWallStuds` does, either side of its centre line; the side
 *   inside the wall at an end stud), set back to the stud's mid-depth like a bore, at the cursor's
 *   height. A cable run along a stud is set back from its nailing edge, never on it (NFPA 70 Art.
 *   300.4(D), cited by number: at least 1-1/4 in (31.75 mm) from the edge, or a steel plate); the
 *   mid-depth gives 44 mm;
 * - `bore`: on a stud's axis at its mid-depth ({@link BORE_DEPTH_MM} behind the face), at the cursor's
 *   height; only when the caller names the bit or hole saw (`boreTool`), which a bore stores.
 *
 * The nearest candidate within {@link ROUTE_SNAP_CAPTURE} wins (ties: duct, conduit, staple, bore, then
 * the lower entity id or fixture id and stud); otherwise a `free` waypoint at the cursor. Integer in,
 * integer out: the cursor is rounded to whole mm first.
 */

export type HostedWaypointKind = 'duct' | 'conduit' | 'staple' | 'bore';

export interface SnapWaypointOptions {
  /** Which hosted kinds may capture (default duct, conduit and staple; bore needs `boreTool`). */
  readonly kinds?: readonly HostedWaypointKind[];
  /** The drill bit or hole saw a bore is made with; bores are candidates only when it is given. */
  readonly boreTool?: CatalogRef | null;
  /** Capture distance in mm (default {@link ROUTE_SNAP_CAPTURE}). */
  readonly captureMm?: number;
}

const KIND_ORDER: readonly HostedWaypointKind[] = ['duct', 'conduit', 'staple', 'bore'];

/**
 * A bore's (and a staple's) depth behind the stud face: the stud's mid-depth, round(88.9 / 2) = 44 mm.
 * Source: common practice; centring maximises both edge distances, which NFPA 70 Art. 300.4(A)(1)
 * (cited by number) requires to be at least 1-1/4 in (31.75 mm), or a 1/16 in steel plate. A bit wider
 * than about 24.9 mm leaves less than that on the face side (F3.2 part 4's edge-distance check).
 */
export const BORE_DEPTH_MM = Math.round(WALL_STUD_DEPTH.valueMm / 2);

interface Candidate {
  readonly waypoint: Waypoint;
  readonly d2: number;
  readonly rank: number;
  readonly host: string;
}

const round = (p: PositionMm): PositionMm => ({
  x: Math.round(p.x) + 0,
  y: Math.round(p.y) + 0,
  z: Math.round(p.z) + 0,
});

/** The waypoint a cursor at `cursor` (world mm) snaps to in `world` (see the module comment). */
export function snapWaypoint(
  world: Pick<World, 'entities' | 'fixtures'>,
  catalog: Catalog,
  cursor: PositionMm,
  options: SnapWaypointOptions = {},
): Waypoint {
  const at = round(cursor);
  const kinds = options.kinds ?? ['duct', 'conduit', 'staple'];
  const boreTool = options.boreTool ?? null;
  const capture = options.captureMm ?? ROUTE_SNAP_CAPTURE.valueMm;
  const candidates: Candidate[] = [];
  const offer = (kind: HostedWaypointKind, waypoint: Omit<Waypoint, 'kind'>, host: string) => {
    const d2 = distance2(waypoint.positionMm, at);
    if (d2 <= capture * capture)
      candidates.push({ waypoint: { kind, ...waypoint }, d2, rank: KIND_ORDER.indexOf(kind), host });
  };
  const hostKey = (id: number) => String(id).padStart(16, '0');

  for (const path of racewayPaths(world, catalog)) {
    if (!kinds.includes(path.kind)) continue;
    const base = { entity: path.entity, fixture: null, tool: null };
    if (path.straight) {
      offer(path.kind, { ...base, positionMm: nearestOnAxis(path, at).point }, hostKey(path.entity));
    } else {
      const port = distance2(path.a, at) <= distance2(path.b, at) ? path.a : path.b;
      offer(path.kind, { ...base, positionMm: port }, hostKey(path.entity));
    }
  }

  const staples = kinds.includes('staple');
  const bores = kinds.includes('bore') && boreTool !== null;
  if (staples || bores) {
    for (const fixture of world.fixtures) {
      if (fixtureSpec(fixture.ref)?.kind !== 'stud-wall') continue;
      const target = fixtureSnapTarget(fixture) as WallStudsTarget | null;
      if (target === null || target.kind !== 'wall-studs') continue;
      const local = worldToSurface(target.frame, at);
      const v = Math.min(Math.max(local.v, 0), target.heightMm);
      const half = SNAP_STEPS.studHalfThicknessMm;
      for (const [index, u] of studCentres(target).entries()) {
        const host = `${fixture.id}\u0000${String(index).padStart(4, '0')}`;
        const base = { entity: null, fixture: fixture.id, tool: null };
        if (staples) {
          // The side face towards the cursor, unless that side is outside the wall (an end stud).
          let side = local.u >= u ? u + half : u - half;
          if (side < 0) side = u + half;
          if (side > target.widthMm) side = u - half;
          const positionMm = surfaceToWorld(target.frame, { u: side, v }, -BORE_DEPTH_MM);
          offer('staple', { ...base, positionMm }, host);
        }
        if (bores) {
          offer(
            'bore',
            { ...base, tool: boreTool, positionMm: surfaceToWorld(target.frame, { u, v }, -BORE_DEPTH_MM) },
            host,
          );
        }
      }
    }
  }

  let best: Candidate | null = null;
  for (const c of candidates) {
    if (
      best === null ||
      c.d2 < best.d2 ||
      (c.d2 === best.d2 && (c.rank < best.rank || (c.rank === best.rank && c.host < best.host)))
    ) {
      best = c;
    }
  }
  return best?.waypoint ?? { kind: 'free', positionMm: at, entity: null, fixture: null, tool: null };
}
