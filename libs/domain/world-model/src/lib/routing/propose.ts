import type { Catalog } from '@controls/catalog';
import type { Waypoint, World } from '../types';
import { checkGeometry, checkRoute } from '../wiring/checks';
import { autoRoute, type AutoRouteOptions } from './auto-route';
import { type RouteTerminal, terminalPlace } from './ends';
import { routeFloorMm } from './floor';
import { routeDefaultLengthMm } from './length';

/*
 * The routing gesture's proposal (F3.2 part 3, ADR 0017 §9): what a two-click route, or a route with
 * the player's own waypoints, would put into `wire.add`. The viewport previews it while the cursor is
 * on the second terminal and hands it to the UI when that terminal is picked; the console and scripts
 * can call the same function, so every surface proposes the same arguments for the same world.
 *
 * - No waypoints and `auto` (the default): exactly `autoRoute` (ducts first, the direct line, the
 *   lead-out fallback).
 * - Otherwise the given waypoints, checked the way `wire.add` checks them for two landed ends
 *   (`checkRoute`: shapes and hosts; `checkGeometry`: distinct points and `route-collides`), with the
 *   default cut length of their points. The command stays the authority: this only says in advance
 *   what it would refuse.
 *
 * Pure, and only the routing maths it calls (integer geometry plus `Math.sqrt`).
 */

export interface ProposeRouteOptions extends AutoRouteOptions {
  /** Auto-route when no waypoints are given (default `true`); `false` proposes the direct line. */
  readonly auto?: boolean;
}

export type RouteProposal =
  | {
      readonly ok: true;
      /** Explicit waypoints for `wire.add`'s `route` (terminal points excluded). */
      readonly route: readonly Waypoint[];
      /** `routeDefaultLengthMm` of the route's points. */
      readonly lengthMm: number;
      /** `routeFloorMm` of the route's points: the least `lengthMm` the command accepts. */
      readonly floorMm: number;
      /** Terminal a's entry point, the waypoints, terminal b's (world integer mm). */
      readonly points: readonly { readonly x: number; readonly y: number; readonly z: number }[];
      /** Whether the auto-router chose the waypoints. */
      readonly auto: boolean;
    }
  | {
      readonly ok: false;
      /** The refusal code `autoRoute` or `wire.add` would give (`route-collides`, `bad-waypoint`, …). */
      readonly code: string;
      readonly message: string;
    };

/** The route from `a` to `b` through `waypoints` (none: auto-routed), as `wire.add` would take it. */
export function proposeRoute(
  world: World,
  catalog: Catalog,
  a: RouteTerminal,
  b: RouteTerminal,
  waypoints: readonly Waypoint[],
  options: ProposeRouteOptions = {},
): RouteProposal {
  if (waypoints.length === 0 && options.auto !== false) {
    const routed = autoRoute(world, catalog, a, b, options);
    return routed.ok ? { ...routed, auto: true } : routed;
  }
  const from = terminalPlace(world, catalog, a);
  if (!from.ok) return { ok: false, code: from.code, message: `End a: ${from.message}` };
  const to = terminalPlace(world, catalog, b);
  if (!to.ok) return { ok: false, code: to.code, message: `End b: ${to.message}` };
  if (a.entity === b.entity && a.terminal === b.terminal) {
    return { ok: false, code: 'same-terminal', message: 'Both ends are the same terminal' };
  }
  const shape = checkRoute(world, catalog, waypoints, { a: true, b: true }, 'refuse');
  if (shape) return shape;
  const points = [from.point, ...waypoints.map((w) => w.positionMm), to.point];
  const lengthMm = routeDefaultLengthMm(points, options.slackPercent);
  const geometry = checkGeometry(
    world,
    catalog,
    [
      { positionMm: from.point, entity: from.entity },
      ...waypoints.map((w) => ({ positionMm: w.positionMm, entity: w.entity })),
      { positionMm: to.point, entity: to.entity },
    ],
    lengthMm,
  );
  if (geometry) return geometry;
  return { ok: true, route: [...waypoints], lengthMm, floorMm: routeFloorMm(points), points, auto: false };
}
