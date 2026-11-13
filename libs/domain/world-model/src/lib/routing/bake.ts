import type { Catalog } from '@controls/catalog';
import { canonicalJson } from '../hash';
import { sha256Hex } from '../sha256';
import { rotateQuarterTurns } from '../snap/quarter-turn';
import { findEntity } from '../entity-commands';
import { cableEndPoint, endMethodSpec, landedPoint } from '../wiring/checks';
import type { Cable, ConnectionEnd, Waypoint, World } from '../types';
import {
  BAKE_UNITS_PER_MM,
  COIL_MIN_PERCENT,
  FREE_SPAN_SAG_CAP_PERCENT,
  FREE_SPAN_SEGMENT,
  MAX_FREE_SPAN_SEGMENTS,
  MIN_SAG_MM,
  RACEWAY_SLACK_CAP_PERCENT,
  ROUTE_LEAD_OUT,
} from './constants';
import { assignLanes, type LaneOffset, type LaneOwner, type Lanes } from './lanes';
import { type RacewayPath, racewayPaths } from './raceways';
import { add, distance, scale, sub, UNIT, type Vec3 } from './vec';

/*
 * The baked centreline (ADR 0017, D5): the shape a routed conductor or cable is drawn with, a pure,
 * analytic function of the world and the catalogue. It replaces ADR 0010's fixed-step Verlet bake
 * (about 8 ms a wire); Verlet stays only in the renderer's live preview, never persisted or hashed.
 *
 * - **Points:** a landed end's entry point and a straight lead-out of {@link ROUTE_LEAD_OUT} along its
 *   exit axis; each waypoint, a duct or conduit waypoint moved onto its lane (`assignLanes`); the other end.
 * - **Taut along raceways:** consecutive hosted waypoints are a taut segment: along one part (an
 *   elbow's legs and arc in between), or across a joint or a duct junction between two.
 * - **Sag on free spans:** the cut length beyond the taut drawn length is shared by the free spans in
 *   proportion to their chords, at most {@link FREE_SPAN_SAG_CAP_PERCENT} of each; then raceway runs
 *   take up to {@link RACEWAY_SLACK_CAP_PERCENT} of their length out of sight; what is left is drawn as
 *   a coil at the middle of the longest free span (or the route's last point) when it is more than
 *   {@link COIL_MIN_PERCENT} of the cut length, and not drawn otherwise. A span with extra e over chord
 *   c sags h = √(3 c e / 8) (the parabola's arc length, ADR 0015: never `cosh` or `asinh`), towards
 *   −y across the chord (+z for a vertical chord), sampled every {@link FREE_SPAN_SEGMENT}.
 * - **Quantised:** every coordinate is rounded to an integer number of tenths of a millimetre.
 *
 * `+ − × ÷`, `Math.sqrt` and rounding only (D6), in a fixed order, so the same world bakes to the same
 * integers in Node and Chromium: `centrelineHash` is their golden (`routing-parity.spec.ts`). The
 * drawn length is a picture; `lengthMm` is what is wired.
 */

/** A coil drawn where a route's spare length goes when its spans can't take it. */
export interface BakedCoil {
  /** Where it hangs, tenths of mm. */
  readonly at: readonly [number, number, number];
  /** How much conductor it holds, tenths of mm. */
  readonly lengthTenths: number;
}

/** One baked route: its owner, its centreline (x, y, z flat, integer tenths of mm) and any coil. */
export interface BakedRoute {
  readonly owner: LaneOwner;
  readonly points: readonly number[];
  readonly coil: BakedCoil | null;
}

/**
 * A node of a route before the bake: a point, the raceway it is on (if any), and whether it is a
 * landed end's terminal point (the segment to its lead-out is drawn straight, never sagged).
 */
export interface BakeNode {
  readonly p: Vec3;
  readonly host: RacewayPath | null;
  readonly terminal?: boolean;
}

/** A piece of the drawn path: a segment's end points, what it is, and its length. */
interface Piece {
  readonly from: Vec3;
  readonly to: Vec3;
  /** `free` sags; `raceway` runs taut along a part; `lead` is a terminal's straight lead-out. */
  readonly kind: 'free' | 'raceway' | 'lead';
  readonly length: number;
}

const q = (v: number): number => Math.round(v * BAKE_UNITS_PER_MM) + 0;

/** The raceway segments between two nodes on the same host: straight, or an elbow's centreline. */
function racewayPieces(from: BakeNode, to: BakeNode): Vec3[] {
  const host = from.host as RacewayPath;
  if (host.straight || host.centreline.length < 3) return [from.p, to.p];
  // An elbow: its inner centreline points, in the direction of travel, shifted by the lane offset.
  const shift = sub(from.p, distance(from.p, host.a) <= distance(from.p, host.b) ? host.a : host.b);
  const inner = host.centreline.slice(1, -1).map((c) => add(c, shift));
  if (distance(from.p, host.a) > distance(from.p, host.b)) inner.reverse();
  return [from.p, ...inner, to.p];
}

/** The drawn pieces of a node chain. */
function pieces(nodes: readonly BakeNode[]): Piece[] {
  const out: Piece[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const from = nodes[i - 1];
    const to = nodes[i];
    // Inside raceways from one hosted waypoint to the next: along one part, or across a joint or a
    // junction between two (a riser, the next stick of a run); taut either way.
    const inside = from.host !== null && to.host !== null;
    const kind = inside ? 'raceway' : from.terminal || to.terminal ? 'lead' : 'free';
    const points = inside && from.host?.entity === to.host?.entity ? racewayPieces(from, to) : [from.p, to.p];
    for (let k = 1; k < points.length; k++) {
      const length = distance(points[k - 1], points[k]);
      if (length > 0) out.push({ from: points[k - 1], to: points[k], kind, length });
    }
  }
  return out;
}

/** The unit direction a span from `p` to `r` sags in: −y across the chord, or +z for a vertical chord. */
function sagDirection(p: Vec3, r: Vec3, chord: number): Vec3 {
  const ux = (r.x - p.x) / chord;
  const uy = (r.y - p.y) / chord;
  const uz = (r.z - p.z) / chord;
  const s2 = 1 - uy * uy;
  if (s2 < 1e-6) return { x: 0, y: 0, z: 1 };
  const s = Math.sqrt(s2);
  return { x: (uy * ux) / s, y: (uy * uy - 1) / s, z: (uy * uz) / s };
}

/**
 * Bakes one route: its nodes (end points, lead-outs and lane-shifted waypoints, in order) and its cut
 * length for the drawn part (mm; `null`: draw it taut). Pure.
 */
export function bakeNodes(owner: LaneOwner, nodes: readonly BakeNode[], lengthMm: number | null): BakedRoute {
  const parts = pieces(nodes);
  let taut = 0;
  let freeChords = 0;
  let raceway = 0;
  for (const piece of parts) {
    taut += piece.length;
    if (piece.kind === 'free') freeChords += piece.length;
    if (piece.kind === 'raceway') raceway += piece.length;
  }
  const extra = lengthMm === null ? 0 : Math.max(0, lengthMm - taut);
  const freeCap = (freeChords * FREE_SPAN_SAG_CAP_PERCENT) / 100;
  // Each free span's extra length is its chord times `share`.
  let share = 0;
  let left = 0;
  if (extra > 0) {
    if (extra <= freeCap && freeChords > 0) {
      share = extra / freeChords;
    } else {
      share = FREE_SPAN_SAG_CAP_PERCENT / 100;
      left = Math.max(0, extra - freeCap - (raceway * RACEWAY_SLACK_CAP_PERCENT) / 100);
    }
  }

  const points: number[] = [];
  const push = (v: Vec3) => {
    const x = q(v.x);
    const y = q(v.y);
    const z = q(v.z);
    const n = points.length;
    if (n >= 3 && points[n - 3] === x && points[n - 2] === y && points[n - 1] === z) return;
    points.push(x, y, z);
  };
  let coilAt: Vec3 | null = null;
  let longest = 0;
  if (parts.length === 0 && nodes.length > 0) push(nodes[0].p);
  for (const piece of parts) {
    push(piece.from);
    if (piece.kind !== 'free') continue;
    const c = piece.length;
    const sag = share > 0 ? Math.sqrt((3 * c * (c * share)) / 8) : 0;
    const dir = sagDirection(piece.from, piece.to, c);
    const at = (t: number): Vec3 =>
      add(add(piece.from, scale(sub(piece.to, piece.from), t)), scale(dir, 4 * sag * t * (1 - t)));
    if (c > longest) {
      longest = c;
      coilAt = at(0.5);
    }
    if (sag < MIN_SAG_MM) continue;
    const n = Math.min(MAX_FREE_SPAN_SEGMENTS, Math.max(2, Math.ceil(c / FREE_SPAN_SEGMENT.valueMm)));
    for (let k = 1; k < n; k++) push(at(k / n));
  }
  if (parts.length > 0) push(parts[parts.length - 1].to);
  // Spare length nothing shows is drawn as a coil only when the run was cut well long (a deliberate
  // length, the 30 m voltage-drop run); a little is just not drawn (the drawn length is a picture).
  let coil: BakedCoil | null = null;
  const coilTenths = q(left);
  if (coilTenths > 0 && lengthMm !== null && left * 100 > lengthMm * COIL_MIN_PERCENT) {
    const hang = coilAt ?? nodes[nodes.length - 1].p;
    coil = { at: [q(hang.x), q(hang.y), q(hang.z)], lengthTenths: coilTenths };
  }
  return { owner, points, coil };
}

/** A lane offset turned into a world shift (mm) on its raceway. */
function laneShift(path: RacewayPath, lane: LaneOffset | undefined): Vec3 {
  if (!lane) return { x: 0, y: 0, z: 0 };
  return add(scale(path.across, lane.across / BAKE_UNITS_PER_MM), scale(path.up, lane.up / BAKE_UNITS_PER_MM));
}

/** The nodes of a waypoint list, each hosted one moved onto its lane. */
function waypointNodes(
  owner: LaneOwner,
  route: readonly Waypoint[],
  paths: ReadonlyMap<number, RacewayPath>,
  lanes: Lanes,
): BakeNode[] {
  return route.map((w) => {
    const host = (w.kind === 'duct' || w.kind === 'conduit') && w.entity !== null ? paths.get(w.entity) : undefined;
    if (!host || host.kind !== w.kind) return { p: w.positionMm, host: null };
    return { p: add(w.positionMm, laneShift(host, lanes.get(host.entity)?.get(owner))), host };
  });
}

/** A landed conductor end's point and its lead-out, or `[]` if the catalogue can't place it. */
function endNodes(world: World, catalog: Catalog, end: ConnectionEnd | null, which: 'a' | 'b'): BakeNode[] {
  if (end === null) return [];
  const point = landedPoint(world, catalog, end);
  const spec = endMethodSpec(world, catalog, end);
  const entity = findEntity(world, end.entity);
  if (point === null || !spec || !entity) return [];
  const exit = rotateQuarterTurns(entity.transform.orientationMdeg, UNIT[spec.exitAxis]);
  if (exit === null) return [];
  const lead = { p: add(point, scale(exit, ROUTE_LEAD_OUT.valueMm)), host: null };
  const terminal = { p: point, host: null, terminal: true };
  return which === 'a' ? [terminal, lead] : [lead, terminal];
}

/** The nodes of a cable end (its entry point), or `[]` for a free end or one the catalogue can't place. */
function cableEndNodes(world: World, catalog: Catalog, cable: Cable, which: 'a' | 'b'): BakeNode[] {
  const end = cable[which];
  if (end === null) return [];
  const point = cableEndPoint(world, catalog, end);
  return point === null ? [] : [{ p: point.positionMm, host: null }];
}

/** A whole world's bake: every routed single conductor by id, then every cable by id. */
export interface BakedWorld {
  readonly routes: readonly BakedRoute[];
}

/**
 * Bakes every route in `world` (see the module comment): single conductors (route non-null) in
 * connection-id order, then cables in cable-id order. A cable's drawn part runs between its entries,
 * so its spare length is `lengthMm` less its tails; its tails and its conductors' tails are F3.2 part
 * 4's. A route the catalogue can't place at all (fewer than one point) is skipped.
 */
export function bakeWorldRoutes(world: World, catalog: Catalog): BakedWorld {
  const all = racewayPaths(world, catalog);
  const paths = new Map(all.map((p) => [p.entity, p]));
  const lanes = assignLanes(world, catalog, all);
  const routes: BakedRoute[] = [];
  const conductors = world.connections.filter((c) => c.route !== null).sort((p, r) => p.id - r.id);
  for (const c of conductors) {
    const owner: LaneOwner = `c${c.id}`;
    const nodes = [
      ...endNodes(world, catalog, c.a, 'a'),
      ...waypointNodes(owner, c.route as readonly Waypoint[], paths, lanes),
      ...endNodes(world, catalog, c.b, 'b'),
    ];
    if (nodes.length > 0) routes.push(bakeNodes(owner, nodes, c.lengthMm));
  }
  for (const cable of [...world.cables].sort((p, r) => p.id - r.id)) {
    const owner: LaneOwner = `k${cable.id}`;
    const nodes = [
      ...cableEndNodes(world, catalog, cable, 'a'),
      ...waypointNodes(owner, cable.route, paths, lanes),
      ...cableEndNodes(world, catalog, cable, 'b'),
    ];
    if (nodes.length > 0) {
      routes.push(bakeNodes(owner, nodes, cable.lengthMm - cable.tailsMm.a - cable.tailsMm.b));
    }
  }
  return { routes };
}

/** SHA-256 (lower-case hex) of a bake's canonical JSON: the cross-runtime centreline golden (ADR 0017). */
export function centrelineHash(baked: BakedWorld): string {
  return sha256Hex(canonicalJson(baked));
}
