import type { SourcedLength } from '../snap/constants';

/*
 * Routing and bake constants (ADR 0017). Realism charter (plan §3): each says where it comes from. None
 * of them is save format: they shape what a surface proposes (the router, the snapper) and what the
 * bake draws, never what a logged command means. Changing one moves the centreline golden (and, for the
 * router, console files that use `--route auto`), never a replay log.
 */

/**
 * How far the bake draws a conductor straight out of its terminal along the method's `exitAxis`
 * before it turns toward the next route point (a lead-out, ADR 0010's 12 mm pin). Drawn only; the
 * floor and the length rule never see it.
 */
export const ROUTE_LEAD_OUT: SourcedLength = {
  valueMm: 12,
  kind: 'game-design',
  source:
    "game-design: ADR 0010's spike pinned each rope 12 mm out of the clamp along its exit direction; it read right at the default framing",
};

/**
 * How far from the cursor a duct or conduit axis, a staple point or a bore may be and still capture a
 * waypoint (`snapWaypoint`); past it the waypoint is `free` at the cursor.
 */
export const ROUTE_SNAP_CAPTURE: SourcedLength = {
  valueMm: 40,
  kind: 'game-design',
  source: 'game-design: the DIN-rail capture band (DIN_RAIL_CAPTURE), reused so every routing snap feels alike',
};

/**
 * How far the auto-router's fallback goes straight out of each terminal (two `free` waypoints) when
 * there is no duct and the direct line between the terminals passes through a body.
 */
export const ROUTE_FALLBACK_LEAD: SourcedLength = {
  valueMm: 50,
  kind: 'game-design',
  source: 'game-design: about a hand-width out of the terminal, clear of a neighbouring 45 mm device face',
};

/**
 * The largest extra length a free span shows as sag, in percent of its chord. game-design: ADR 0010's
 * Verlet rope (which also stretches) sagged 55 mm on a 300 mm span at 3 % slack, "too much for panel
 * wiring, which is dressed fairly taut"; this parabola gives 31.8 mm at 3 % and about 18 mm at 1 %
 * (h = √(3 c e / 8)). A drawing abstraction: solid 14–12 AWG holds a bent shape rather than hanging.
 */
export const FREE_SPAN_SAG_CAP_PERCENT = 1;

/**
 * The largest extra length a run along a raceway takes up out of sight (loose in the duct or tube), in
 * percent of the run's length (game-design: a duct is where panel builders leave their spare). With
 * the default 5 % slack this takes all the spare only when raceway runs are at least about 40 % of the
 * route; any rest is simply not drawn, and a default-length wire never coils (`COIL_MIN_PERCENT`).
 */
export const RACEWAY_SLACK_CAP_PERCENT = 10;

/**
 * Spare length the bake can't show as sag or hide in a raceway is drawn as a coil only above this
 * share of the cut length, in percent (game-design: a run cut deliberately long, such as 30 m of 14/2
 * for a voltage-drop exercise on a 1 m route, gets a coil; the few percent a lane offset frees on a
 * default-length wire is simply not drawn, since the drawn length is a picture and `lengthMm` is what
 * is wired).
 */
export const COIL_MIN_PERCENT = 20;

/**
 * Spacing of the sample points on a sagging free span (ADR 0010: 15 mm reads as smooth at 2.5× zoom;
 * 25 mm shows corners), and the most points a span gets. A taut span is one segment.
 */
export const FREE_SPAN_SEGMENT: SourcedLength = {
  valueMm: 15,
  kind: 'game-design',
  source: "game-design: ADR 0010's measured particle spacing (15 mm looked the same as 10 mm at 2.5× zoom)",
};
export const MAX_FREE_SPAN_SEGMENTS = 32;

/** Below this sag depth (mm) a free span is drawn taut: it would vanish in the 0.1 mm quantum. */
export const MIN_SAG_MM = 0.05;

/** The bake's quantum: every baked coordinate is an integer number of tenths of a millimetre. */
export const BAKE_UNITS_PER_MM = 10;

/** The most (entry duct, exit duct) pairs the auto-router tries before its fallbacks. */
export const AUTO_ROUTE_MAX_PAIRS = 16;

/** The most candidate ducts per terminal the auto-router considers (nearest first). */
export const AUTO_ROUTE_MAX_DUCTS = 4;

/**
 * A lane's width when the catalogue can't say how thick an occupant is (tenths of mm). game-design: a
 * fallback only (real widths come from the conductor or cable entry); about the outside diameter of a
 * 14 AWG THHN conductor (about 2.8 mm, typical makers' spec sheets), rounded to 3 mm. Drawing only.
 */
export const DEFAULT_LANE_WIDTH_TENTHS = 30;

/**
 * cos and sin of 0°, 15°, …, 90° as literals (an elbow's arc in the bake). Literals, not `Math.cos`:
 * ECMAScript doesn't pin the trigonometric functions across engines (D6), but a number literal is
 * the same double everywhere.
 */
export const ARC_COS: readonly number[] = [
  1, 0.9659258262890683, 0.8660254037844387, 0.7071067811865476, 0.5000000000000001, 0.25881904510252074, 0,
];
export const ARC_SIN: readonly number[] = [
  0, 0.25881904510252074, 0.49999999999999994, 0.7071067811865475, 0.8660254037844386, 0.9659258262890683, 1,
];

/** √½, as a literal: the side of the square inscribed in a tube of unit diameter. */
export const HALF_SQRT2 = 0.7071067811865476;
