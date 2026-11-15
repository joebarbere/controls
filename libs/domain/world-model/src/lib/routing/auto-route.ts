import type { Catalog } from '@controls/catalog';
import { obstacleBoxes } from '../wiring/checks';
import type { EntityId, PositionMm, Waypoint, World } from '../types';
import { type CollisionPoint, type Obstacle, routeCollision } from './collide';
import { AUTO_ROUTE_MAX_DUCTS, AUTO_ROUTE_MAX_PAIRS, ROUTE_FALLBACK_LEAD } from './constants';
import { type RouteTerminal, type TerminalPlace, terminalPlace } from './ends';
import { routeFloorMm } from './floor';
import { routeDefaultLengthMm } from './length';
import { nearestOnAxis, type RacewayPath, racewayPaths } from './raceways';
import { distance2, same } from './vec';

/*
 * The auto-router (ADR 0017, plan F3.2 part 1): the one function behind the mouse's two-click route,
 * the console's `--route auto` and `game.autoRoute`, so every surface proposes the same waypoints for
 * the same world. It only **proposes**: the surface puts its explicit waypoints (and its default
 * `lengthMm`) into the logged `wire.add`, so a later change here never changes what an old log replays
 * to (D5).
 *
 * The route: out of terminal a along its exit direction into the nearest duct (ducts ahead of the
 * terminal first, then nearest, then lowest id), along the duct network through any risers (ducts
 * whose bodies touch or overlap join where their axes come closest), out of the duct nearest terminal
 * b, to terminal b. Each terminal's duct point is the point of the duct's axis nearest the terminal,
 * so a terminal row under a duct drops straight into it. The first candidate pair whose stored
 * polyline is clear of every body (`routeCollision`, exactly the command's check) wins. With no duct,
 * or no clear duct route, the direct line, then a lead-out of {@link ROUTE_FALLBACK_LEAD} from each
 * terminal; otherwise `route-collides`.
 *
 * Pure integer geometry plus `Math.sqrt` for path costs (D6), and every tie broken by entity id or
 * index, so Node and Chromium propose the same waypoints.
 */

export interface AutoRouteOptions {
  /** Route through ducts (default `true`); `false` tries only the direct line and the lead-out fallback. */
  readonly ducts?: boolean;
  /** The slack percent for `lengthMm` (default `ROUTE_SLACK_PERCENT`). */
  readonly slackPercent?: number;
}

export type AutoRouteResult =
  | {
      readonly ok: true;
      /** Explicit waypoints for `wire.add`'s `route` (terminal points excluded). */
      readonly route: Waypoint[];
      /** `routeDefaultLengthMm` of the route's points: what a surface fills `lengthMm` with. */
      readonly lengthMm: number;
      /** `routeFloorMm` of the route's points: the least `lengthMm` the command accepts. */
      readonly floorMm: number;
      /** The route's points: terminal a's entry point, the waypoints, terminal b's. */
      readonly points: PositionMm[];
    }
  | {
      readonly ok: false;
      readonly code:
        'not-found' | 'unknown-terminal' | 'wrong-method' | 'not-axis-aligned' | 'same-terminal' | 'route-collides';
      readonly message: string;
    };

const ductWaypoint = (entity: EntityId, positionMm: PositionMm): Waypoint => ({
  kind: 'duct',
  positionMm,
  entity,
  fixture: null,
  tool: null,
});

const freeWaypoint = (positionMm: PositionMm): Waypoint => ({
  kind: 'free',
  positionMm,
  entity: null,
  fixture: null,
  tool: null,
});

/** A terminal's candidate entry into one duct. */
interface DuctEntry {
  readonly duct: number; // index into the duct list
  readonly point: PositionMm;
}

/** The ducts a terminal may enter, best first: ahead of its exit direction, then nearest, then lowest id. */
function ductEntries(ducts: readonly RacewayPath[], place: TerminalPlace): DuctEntry[] {
  const ranked = ducts.map((duct, index) => {
    const { point, d2 } = nearestOnAxis(duct, place.point);
    const ahead =
      (point.x - place.point.x) * place.exit.x +
        (point.y - place.point.y) * place.exit.y +
        (point.z - place.point.z) * place.exit.z >
      0;
    return { duct: index, point, d2, ahead };
  });
  ranked.sort((p, q) => Number(q.ahead) - Number(p.ahead) || p.d2 - q.d2 || p.duct - q.duct);
  return ranked.slice(0, AUTO_ROUTE_MAX_DUCTS).map(({ duct, point }) => ({ duct, point }));
}

/** Two closed boxes touch or overlap. */
function boxesMeet(p: RacewayPath, q: RacewayPath): boolean {
  return (
    p.box.min.x <= q.box.max.x &&
    q.box.min.x <= p.box.max.x &&
    p.box.min.y <= q.box.max.y &&
    q.box.min.y <= p.box.max.y &&
    p.box.min.z <= q.box.max.z &&
    q.box.min.z <= p.box.max.z
  );
}

const lo = (p: RacewayPath, c: 'x' | 'y' | 'z') => Math.min(p.a[c], p.b[c]);
const hi = (p: RacewayPath, c: 'x' | 'y' | 'z') => Math.max(p.a[c], p.b[c]);
const runsAlong = (p: RacewayPath): 'x' | 'y' | 'z' => (p.a.x !== p.b.x ? 'x' : p.a.y !== p.b.y ? 'y' : 'z');

/**
 * Where two ducts' axes come closest (both straight, axis-aligned): a point on each, integer. Crossing
 * axes: each clamped to the other's fixed coordinate. Parallel axes: the middle of their overlap
 * (rounded down), or their nearest ends when they don't overlap.
 */
export function ductJunction(p: RacewayPath, q: RacewayPath): readonly [PositionMm, PositionMm] {
  const kp = runsAlong(p);
  const kq = runsAlong(q);
  if (kp !== kq) {
    const onP = { ...p.a, [kp]: Math.min(Math.max(q.a[kp], lo(p, kp)), hi(p, kp)) };
    const onQ = { ...q.a, [kq]: Math.min(Math.max(p.a[kq], lo(q, kq)), hi(q, kq)) };
    return [onP, onQ];
  }
  const from = Math.max(lo(p, kp), lo(q, kp));
  const to = Math.min(hi(p, kp), hi(q, kp));
  if (from <= to) {
    const mid = Math.floor((from + to) / 2);
    return [
      { ...p.a, [kp]: mid },
      { ...q.a, [kp]: mid },
    ];
  }
  // No overlap: p's end nearest q, q's end nearest p.
  return lo(p, kp) > hi(q, kp)
    ? [
        { ...p.a, [kp]: lo(p, kp) },
        { ...q.a, [kp]: hi(q, kp) },
      ]
    : [
        { ...p.a, [kp]: hi(p, kp) },
        { ...q.a, [kp]: lo(q, kp) },
      ];
}

/** The duct network: each junction a pair of points, one on each of two ducts whose bodies meet. */
interface Junction {
  readonly p: number;
  readonly q: number;
  readonly onP: PositionMm;
  readonly onQ: PositionMm;
}

function ductJunctions(ducts: readonly RacewayPath[]): Junction[] {
  const junctions: Junction[] = [];
  for (let p = 0; p < ducts.length; p++) {
    for (let q = p + 1; q < ducts.length; q++) {
      if (!boxesMeet(ducts[p], ducts[q])) continue;
      const [onP, onQ] = ductJunction(ducts[p], ducts[q]);
      junctions.push({ p, q, onP, onQ });
    }
  }
  return junctions;
}

/**
 * The shortest path along duct axes from `start` to `end` (Dijkstra; ties by vertex index, so it is
 * deterministic), as duct waypoints with consecutive repeats dropped, or `null` if the ducts don't
 * connect.
 */
function ductPath(
  ducts: readonly RacewayPath[],
  junctions: readonly Junction[],
  start: DuctEntry,
  end: DuctEntry,
): Waypoint[] | null {
  // Vertices: 0 the start, 1 the end, then each junction's point on p and its point on q.
  const vertices: { duct: number; point: PositionMm }[] = [
    { duct: start.duct, point: start.point },
    { duct: end.duct, point: end.point },
  ];
  for (const j of junctions) vertices.push({ duct: j.p, point: j.onP }, { duct: j.q, point: j.onQ });
  const n = vertices.length;
  const dist = new Array<number>(n).fill(Infinity);
  const prev = new Array<number>(n).fill(-1);
  const done = new Array<boolean>(n).fill(false);
  dist[0] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u === -1 || dist[i] < dist[u])) u = i;
    if (u === -1 || u === 1) break;
    done[u] = true;
    const relax = (v: number, cost: number) => {
      if (!done[v] && dist[u] + cost < dist[v]) {
        dist[v] = dist[u] + cost;
        prev[v] = u;
      }
    };
    // Along the same duct: its axis is straight, so the cost is the distance along it.
    for (let v = 0; v < n; v++) {
      if (v !== u && vertices[v].duct === vertices[u].duct) {
        relax(v, Math.sqrt(distance2(vertices[u].point, vertices[v].point)));
      }
    }
    // Across a junction to its partner on the other duct.
    if (u >= 2) {
      const partner = u % 2 === 0 ? u + 1 : u - 1;
      relax(partner, Math.sqrt(distance2(vertices[u].point, vertices[partner].point)));
    }
  }
  if (dist[1] === Infinity) return null;
  const chain: number[] = [];
  for (let v = 1; v !== -1; v = prev[v]) chain.unshift(v);
  const waypoints: Waypoint[] = [];
  for (const v of chain) {
    const { duct, point } = vertices[v];
    const last = waypoints.at(-1);
    if (last && same(last.positionMm, point)) continue;
    waypoints.push(ductWaypoint(ducts[duct].entity, point));
  }
  return waypoints;
}

/** The route's points with each point's entity (a terminal's device, a waypoint's host), for `routeCollision`. */
function collisionPoints(a: TerminalPlace, route: readonly Waypoint[], b: TerminalPlace): CollisionPoint[] {
  return [
    { positionMm: a.point, entity: a.entity },
    ...route.map((w) => ({ positionMm: w.positionMm, entity: w.entity })),
    { positionMm: b.point, entity: b.entity },
  ];
}

/** Whether consecutive route points are distinct (the command's `bad-waypoint` rule). */
function distinct(points: readonly CollisionPoint[]): boolean {
  for (let i = 1; i < points.length; i++) if (same(points[i - 1].positionMm, points[i].positionMm)) return false;
  return true;
}

/**
 * Proposes a route from terminal `a` to terminal `b` in `world` (see the module comment): explicit
 * waypoints the command accepts, the default cut length and the floor, or why there is none.
 */
export function autoRoute(
  world: World,
  catalog: Catalog,
  a: RouteTerminal,
  b: RouteTerminal,
  options: AutoRouteOptions = {},
): AutoRouteResult {
  const from = terminalPlace(world, catalog, a);
  if (!from.ok) return { ok: false, code: from.code, message: `End a: ${from.message}` };
  const to = terminalPlace(world, catalog, b);
  if (!to.ok) return { ok: false, code: to.code, message: `End b: ${to.message}` };
  if (a.entity === b.entity && a.terminal === b.terminal) {
    return { ok: false, code: 'same-terminal', message: 'Both ends are the same terminal' };
  }
  const obstacles: readonly Obstacle[] = obstacleBoxes(world, catalog);
  const clear = (route: Waypoint[]): boolean => {
    const points = collisionPoints(from, route, to);
    return distinct(points) && routeCollision(points, obstacles) === null;
  };
  const done = (route: Waypoint[]): AutoRouteResult => {
    const points = [from.point, ...route.map((w) => w.positionMm), to.point];
    return {
      ok: true,
      route,
      lengthMm: routeDefaultLengthMm(points, options.slackPercent),
      floorMm: routeFloorMm(points),
      points,
    };
  };

  if (options.ducts !== false) {
    const ducts = racewayPaths(world, catalog).filter((p) => p.kind === 'duct');
    if (ducts.length > 0) {
      const junctions = ductJunctions(ducts);
      const starts = ductEntries(ducts, from);
      const ends = ductEntries(ducts, to);
      const pairs: [number, number][] = [];
      for (let i = 0; i < starts.length; i++) for (let j = 0; j < ends.length; j++) pairs.push([i, j]);
      pairs.sort((p, q) => p[0] + p[1] - (q[0] + q[1]) || p[0] - q[0]);
      for (const [i, j] of pairs.slice(0, AUTO_ROUTE_MAX_PAIRS)) {
        const route = ductPath(ducts, junctions, starts[i], ends[j]);
        if (route !== null && clear(route)) return done(route);
      }
    }
  }
  if (clear([])) return done([]);
  const lead = ROUTE_FALLBACK_LEAD.valueMm;
  const out = (p: TerminalPlace): PositionMm => ({
    x: p.point.x + p.exit.x * lead + 0,
    y: p.point.y + p.exit.y * lead + 0,
    z: p.point.z + p.exit.z * lead + 0,
  });
  const fallback = [freeWaypoint(out(from)), freeWaypoint(out(to))];
  if (clear(fallback)) return done(fallback);
  return {
    ok: false,
    code: 'route-collides',
    message: 'No clear route: every duct route and the direct line pass through a device body; add waypoints',
  };
}
