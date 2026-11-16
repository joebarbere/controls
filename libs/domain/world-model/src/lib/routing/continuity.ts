import { type Catalog, racewayPorts } from '@controls/catalog';
import { findEntity } from '../entity-commands';
import { entityPointMm, rotateQuarterTurns } from '../snap/quarter-turn';
import type { EntityId, PositionMm, Waypoint, World } from '../types';
import { nearestOnAxis, racewayPath } from './raceways';
import { same, UNIT } from './vec';

/*
 * Conduit continuity (ADR 0015 F3.4 part 2 implementation note 4, closing the bend-limit bypass the
 * `save-format-guardian` review found): a pull's conduit waypoints must trace the conduit run as it
 * is built, so `pullRun` measures every elbow it goes round. Exact integer geometry, no `Math` at all.
 *
 * - **On its part** (`off-raceway`): a `conduit` waypoint on an EMT-lite stick or connector lies on
 *   its axis (the segment between its two ends); one on an elbow is exactly one of its two ports (the
 *   snapper never puts one mid-bend).
 * - **One run** (`conduit-discontinuous`): the conduit waypoints are consecutive in the route (no
 *   free, duct, staple or bore waypoint between the first and the last), so nothing leaves the
 *   conduit and re-enters it past an elbow.
 * - **Joined parts** (`conduit-discontinuous`): two consecutive conduit waypoints are on the same part,
 *   or on two parts **joined** at a point J: a joint end of each at J, pointing opposite ways (an
 *   elbow's port on a stick's end, a connector's outer end on a stick, two sticks end to end as a
 *   coupling would join them; two parts merely touching at an angle aren't joined). The segment between
 *   the two waypoints passes through J, and a waypoint on an elbow is J itself unless the other one is
 *   (the segment is then exactly the elbow's two ports). So an elbow is always gone round port to port
 *   (where `pullRun` adds its arc to the chord) and never cut across, and every elbow the run goes
 *   round hosts a waypoint (where `pullRun` counts its bend): two parts an elbow joins aren't joined.
 *
 * A host the catalogue can't place (unknown, or not at quarter-turns) isn't judged here: the commands
 * refuse it first (`bad-waypoint`, `not-axis-aligned`) and the load check leaves an unknown one alone.
 * Once v3 freezes this rule is replay format: it decides which logged `wire.pull` entries replay.
 */

/** A continuity problem: the 0-based waypoint index, the refusal code and why. */
export interface ContinuityProblem {
  readonly index: number;
  readonly code: 'off-raceway' | 'conduit-discontinuous';
  readonly message: string;
}

interface Part {
  readonly elbow: boolean;
  readonly a: PositionMm;
  readonly b: PositionMm;
  /** Its joint ends in the world: where, and the outward direction there. */
  readonly joints: readonly { readonly point: PositionMm; readonly out: PositionMm }[];
}

function conduitPart(world: Pick<World, 'entities'>, catalog: Catalog, id: EntityId): Part | null {
  const entity = findEntity(world, id);
  const device = entity ? catalog.device(entity.ref) : undefined;
  const path = entity ? racewayPath(entity, catalog) : null;
  if (!entity || !device || path === null || path.kind !== 'conduit') return null;
  const joints: { point: PositionMm; out: PositionMm }[] = [];
  for (const port of racewayPorts(device, entity.state)) {
    if (port.kind !== 'joint') continue;
    const point = entityPointMm(entity.transform, port.positionMm);
    const out = rotateQuarterTurns(entity.transform.orientationMdeg, UNIT[port.axis]);
    if (point && out) joints.push({ point, out });
  }
  return { elbow: !path.straight, a: path.a, b: path.b, joints };
}

/** Where parts `p` and `q` are joined (a joint end of each at one point, pointing opposite ways), or `null`. */
function joinedAt(p: Part, q: Part): PositionMm | null {
  for (const s of p.joints) {
    for (const t of q.joints) {
      const opposite = s.out.x === -t.out.x && s.out.y === -t.out.y && s.out.z === -t.out.z;
      if (opposite && same(s.point, t.point)) return s.point;
    }
  }
  return null;
}

/** Whether `j` lies on the segment `p`–`q` (integer points: exact). */
function onSegment(p: PositionMm, j: PositionMm, q: PositionMm): boolean {
  const u = { x: j.x - p.x, y: j.y - p.y, z: j.z - p.z };
  const v = { x: q.x - j.x, y: q.y - j.y, z: q.z - j.z };
  const crossZero = u.y * v.z === u.z * v.y && u.z * v.x === u.x * v.z && u.x * v.y === u.y * v.x;
  return crossZero && u.x * v.x + u.y * v.y + u.z * v.z >= 0;
}

/**
 * The first continuity problem of `route`'s conduit waypoints (see the module comment), or `null`.
 * Routes without conduit waypoints have none.
 */
export function conduitContinuityProblem(
  world: Pick<World, 'entities'>,
  catalog: Catalog,
  route: readonly Waypoint[],
): ContinuityProblem | null {
  const first = route.findIndex((w) => w.kind === 'conduit');
  if (first < 0) return null;
  let last = first;
  for (const [i, w] of route.entries()) if (w.kind === 'conduit') last = i;
  const parts = new Map<EntityId, Part | null>();
  const part = (id: EntityId | null): Part | null => {
    if (id === null) return null;
    if (!parts.has(id)) parts.set(id, conduitPart(world, catalog, id));
    return parts.get(id) ?? null;
  };
  for (let i = first; i <= last; i++) {
    const w = route[i];
    const at = `Waypoint ${i + 1}`;
    if (w.kind !== 'conduit') {
      return {
        index: i,
        code: 'conduit-discontinuous',
        message: `${at} leaves the conduit between conduit waypoints: a pull goes through one run`,
      };
    }
    const host = part(w.entity);
    if (host === null) continue;
    const on = host.elbow
      ? same(w.positionMm, host.a) || same(w.positionMm, host.b)
      : nearestOnAxis(host, w.positionMm).d2 === 0;
    if (!on) {
      const where = host.elbow ? 'at a port of' : 'on the axis of';
      return { index: i, code: 'off-raceway', message: `${at} isn't ${where} conduit part ${w.entity}` };
    }
    if (i === first) continue;
    const v = route[i - 1];
    if (v.entity === w.entity) continue;
    const prior = part(v.entity);
    if (prior === null) continue;
    const j = joinedAt(prior, host);
    // Through the joint; an elbow's waypoint is the joint itself, unless the other waypoint is (then the
    // segment is exactly that elbow's port-to-port chord, which `pullRun` measures along its bend).
    const through =
      j !== null &&
      onSegment(v.positionMm, j, w.positionMm) &&
      (!prior.elbow || same(v.positionMm, j) || same(w.positionMm, j)) &&
      (!host.elbow || same(w.positionMm, j) || same(v.positionMm, j));
    if (!through) {
      const why =
        j === null
          ? `conduit parts ${v.entity} and ${w.entity} aren't joined`
          : `the run from part ${v.entity} to part ${w.entity} doesn't pass where they join (round an elbow port to port)`;
      return { index: i, code: 'conduit-discontinuous', message: `${at}: ${why}` };
    }
  }
  return null;
}
