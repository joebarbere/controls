import type { Catalog } from '@controls/catalog';
import { findEntity } from '../entity-commands';
import { routeDefaultLengthMm } from '../routing/length';
import { entityPointMm } from '../snap/quarter-turn';
import type { CableEnd, PositionMm, Waypoint, World } from '../types';
import type { TerminationArg } from '../termination/resolve';
import { cableEndPoint } from './checks';

/*
 * The default cut length a surface fills in for a route (ADR 0015, "The length rule"): the console's
 * `--lengthMm auto` (`CONSOLE_EXPANDERS` in `scripting-api`), and later the mouse and
 * `game.autoRoute`. The route's points are computed exactly as the command computes them (a landed
 * end's method entry point, a cable end's entry point), then `routeDefaultLengthMm` adds the slack and
 * the tails. A point the catalogue can't place is an error: the command would refuse it anyway.
 */

export type AutoLength =
  { readonly ok: true; readonly lengthMm: number } | { readonly ok: false; readonly message: string };

/** The point of a landed end argument (`'auto'` takes the terminal's first method), or an error. */
function landedEndPoint(
  world: World,
  catalog: Catalog,
  end: { readonly entity: number; readonly terminal: string; readonly termination: TerminationArg },
): PositionMm | string {
  const entity = findEntity(world, end.entity);
  if (!entity) return `no entity with id ${end.entity}`;
  const terminal = catalog.device(entity.ref)?.terminals.find((t) => t.id === end.terminal);
  if (!terminal) return `entity ${end.entity} has no terminal "${end.terminal}"`;
  const termination = end.termination;
  const spec =
    termination === 'auto' ? terminal.methods[0] : terminal.methods.find((m) => m.method === termination.method);
  if (!spec) return `terminal "${end.terminal}" of entity ${end.entity} takes no such termination`;
  return entityPointMm(entity.transform, spec.entryMm) ?? `entity ${end.entity} isn't at quarter-turns`;
}

/** The default length of a `wire.add` (no tails) or a `wire.pull` (both ends free). */
export function defaultWireLengthMm(
  world: World,
  catalog: Catalog,
  args: {
    readonly a: Parameters<typeof landedEndPoint>[2] | null;
    readonly b: Parameters<typeof landedEndPoint>[2] | null;
    readonly route: readonly Waypoint[];
  },
): AutoLength {
  const points: PositionMm[] = args.route.map((w) => w.positionMm);
  for (const [name, end] of [
    ['a', args.a],
    ['b', args.b],
  ] as const) {
    if (end === null) continue;
    const point = landedEndPoint(world, catalog, end);
    if (typeof point === 'string') return { ok: false, message: `end ${name}: ${point}` };
    if (name === 'a') points.unshift(point);
    else points.push(point);
  }
  if (points.length < 2) return { ok: false, message: 'a route has at least two points' };
  return { ok: true, lengthMm: routeDefaultLengthMm(points) };
}

/** The default length of a `cable.add`: its entry points and waypoints, the slack, and both tails. */
export function defaultCableLengthMm(
  world: World,
  catalog: Catalog,
  args: {
    readonly a: CableEnd | null;
    readonly b: CableEnd | null;
    readonly route: readonly Waypoint[];
    readonly tailsMm: { readonly a: number; readonly b: number };
  },
): AutoLength {
  const points: PositionMm[] = args.route.map((w) => w.positionMm);
  for (const [name, end] of [
    ['a', args.a],
    ['b', args.b],
  ] as const) {
    if (end === null) continue;
    const point = cableEndPoint(world, catalog, end);
    if (point === null) return { ok: false, message: `end ${name}: the catalogue can't place entry "${end.entry}"` };
    if (name === 'a') points.unshift(point.positionMm);
    else points.push(point.positionMm);
  }
  if (points.length < 2) return { ok: false, message: 'a route has at least two points' };
  return { ok: true, lengthMm: routeDefaultLengthMm(points, undefined, args.tailsMm) };
}
