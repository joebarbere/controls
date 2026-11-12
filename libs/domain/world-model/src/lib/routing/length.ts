import type { PositionMm } from '../types';
import { routeFloorMm } from './floor';

/*
 * The default cut length a surface fills in (ADR 0015, "The length rule"; D5): the mouse, the
 * console's `--lengthMm auto` and (F3.2 part 1) `game.autoRoute` all call `routeDefaultLengthMm`, and
 * the command only checks the result against the floor. Because the length is a logged argument, a
 * later change to the slack here never changes what an old log replays to; it only changes what a
 * console file using the shorthand logs (its hashes are re-pinned then).
 *
 * Integer arithmetic on top of `routeFloorMm` (D6), so `routeDefaultLengthMm ≥ routeFloorMm` exactly.
 * ADR 0017 (F3.2 part 1) may refine the slack with routing data; these defaults are game-design.
 */

/**
 * Slack on top of the route's polyline, in percent (game-design: a run is cut a little long so it
 * can follow the route's bends and be dressed; ADR 0017 may replace it with a sourced allowance).
 */
export const ROUTE_SLACK_PERCENT = 5;

/**
 * Cable left past each enclosure entry by default, in mm (game-design, chosen so the conductors keep
 * the 150 mm (6 in) of free length NFPA 70-2023 Art. 300.14 asks for at a box, cited by number, with
 * room for the jacket inside the clamp; ADR 0017 may tighten the reach rule).
 */
export const DEFAULT_CABLE_TAIL_MM = 200;

/** The slack added to a route of floor `floorMm`: `ceil(floorMm × slackPercent / 100)`, an integer. */
export function routeSlackMm(floorMm: number, slackPercent: number = ROUTE_SLACK_PERCENT): number {
  return Math.ceil((floorMm * slackPercent) / 100);
}

/**
 * The default cut length of a route through `points` (terminal entry points or entry points, and
 * waypoints): its floor plus the slack plus both tails (0 for a single conductor), in integer mm.
 */
export function routeDefaultLengthMm(
  points: readonly PositionMm[],
  slackPercent: number = ROUTE_SLACK_PERCENT,
  tails: { readonly a: number; readonly b: number } = { a: 0, b: 0 },
): number {
  const floor = routeFloorMm(points);
  return floor + routeSlackMm(floor, slackPercent) + tails.a + tails.b;
}

/**
 * The default tails of a cable (ADR 0015, "Tails are stored, not derived"): {@link DEFAULT_CABLE_TAIL_MM}
 * at an end in an enclosure entry, 0 at a free end.
 */
export function defaultTailsMm(ends: { readonly a: unknown; readonly b: unknown }): { a: number; b: number } {
  return { a: ends.a === null ? 0 : DEFAULT_CABLE_TAIL_MM, b: ends.b === null ? 0 : DEFAULT_CABLE_TAIL_MM };
}
