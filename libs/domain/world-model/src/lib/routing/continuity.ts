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
 *   coupling would join them; two parts merely touching at an angle aren't joined), or on two parts joined through straight parts end to end (a stick passed by without a waypoint; never through an elbow, whose bend that would skip). The segment between
 *   the two waypoints passes through J, and a waypoint on an elbow is J itself unless the other one is
 *   (the segment is then exactly the elbow's two ports). So an elbow is always gone round port to port
 *   (where `pullRun` adds its arc to the chord) and never cut across, and every elbow the run goes
 *   round hosts a waypoint (where `pullRun` counts its bend): two parts an elbow joins aren't joined.
 * - **Forward only** (`conduit-discontinuous`): the run never comes back to a part it has left, and
 *   along one part it never doubles back (three waypoints on a part keep one direction), so an elbow
 *   gone round port 1 → 2 → 1 can't count one bend and its arc twice.
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
  // The parts the run has left (a host waypoint, then a waypoint on another part).
  const left = new Set<EntityId | null>();
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
    if (v.entity === w.entity) {
      // Along one part the run keeps its direction: no doubling back (an elbow port 1 → 2 → 1 would
      // count one bend and its arc twice).
      const u = i - 2 >= first ? route[i - 2] : null;
      if (u !== null && u.entity === w.entity) {
        const p = v.positionMm;
        const ahead =
          (p.x - u.positionMm.x) * (w.positionMm.x - p.x) +
          (p.y - u.positionMm.y) * (w.positionMm.y - p.y) +
          (p.z - u.positionMm.z) * (w.positionMm.z - p.z);
        if (ahead <= 0) {
          return {
            index: i,
            code: 'conduit-discontinuous',
            message: `${at} doubles back along conduit part ${w.entity}`,
          };
        }
      }
      continue;
    }
    left.add(v.entity);
    if (left.has(w.entity)) {
      return {
        index: i,
        code: 'conduit-discontinuous',
        message: `${at} comes back to conduit part ${w.entity}, already left`,
      };
    }
    const prior = part(v.entity);
    if (prior === null || v.entity === null || w.entity === null) continue;
    const chain = joinedChain(world, part, v.entity, w.entity);
    if (chain === null) {
      return {
        index: i,
        code: 'conduit-discontinuous',
        message: `${at}: conduit parts ${v.entity} and ${w.entity} aren't joined (an elbow between them is skipped)`,
      };
    }
    for (const between of chain.through) {
      if (left.has(between)) {
        return {
          index: i,
          code: 'conduit-discontinuous',
          message: `${at} comes back to conduit part ${between}, already left`,
        };
      }
      left.add(between);
    }
    // Through every joint; an elbow's waypoint is its joint, unless the parts are joined directly and
    // the other waypoint is (the segment is then that elbow's port-to-port chord, which `pullRun`
    // measures along its bend).
    const firstJoint = chain.joints[0];
    const lastJoint = chain.joints[chain.joints.length - 1];
    const direct = chain.joints.length === 1;
    const through =
      chain.joints.every((j) => onSegment(v.positionMm, j, w.positionMm)) &&
      (!prior.elbow || same(v.positionMm, firstJoint) || (direct && same(w.positionMm, firstJoint))) &&
      (!host.elbow || same(w.positionMm, lastJoint) || (direct && same(v.positionMm, lastJoint)));
    if (!through) {
      const why = `the run from part ${v.entity} to part ${w.entity} doesn't pass where they join (round an elbow port to port)`;
      return { index: i, code: 'conduit-discontinuous', message: `${at}: ${why}` };
    }
  }
  return null;
}

/**
 * How part `from` reaches part `to` along the run: joined directly, or through straight parts (sticks,
 * connectors) joined end to end, never through an elbow (that would skip its bend). The joints in
 * order and the parts passed through, or `null`.
 */
function joinedChain(
  world: Pick<World, 'entities'>,
  part: (id: EntityId | null) => Part | null,
  from: EntityId,
  to: EntityId,
): { joints: PositionMm[]; through: EntityId[] } | null {
  const conduitIds = world.entities.map((e) => e.id).filter((id) => part(id) !== null);
  const search = (
    at: EntityId,
    came: EntityId | null,
    seen: Set<EntityId>,
  ): { joints: PositionMm[]; through: EntityId[] } | null => {
    const here = part(at);
    if (here === null) return null;
    for (const next of conduitIds) {
      if (next === at || next === came || seen.has(next)) continue;
      const other = part(next);
      const j = other && joinedAt(here, other);
      if (!other || j === null) continue;
      if (next === to) return { joints: [j], through: [] };
      if (other.elbow) continue;
      seen.add(next);
      const rest = search(next, at, seen);
      if (rest) return { joints: [j, ...rest.joints], through: [next, ...rest.through] };
    }
    return null;
  };
  return search(from, null, new Set([from]));
}
