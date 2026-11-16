import { type CommandFailure, fail } from '@controls/commands';
import { type SourcedLength, WALL_STUD_DEPTH } from '../snap/constants';
import type { PositionMm, Waypoint } from '../types';

/*
 * Cable in wood framing (F3.2 part 4): how far apart an NM cable's supports may be, how large a hole
 * a stud takes, and how close a bored hole comes to the stud's nailing edge. Realism charter (plan
 * §3): each constant cites its source **by number** and paraphrases it; no code text or table is
 * reproduced. Pure, integer-in, and `+ − × ÷` and `Math.sqrt` only (D6).
 *
 * - **Support spacing** (`staple-spacing`): a cable run in framing (its route has a `staple` or `bore`
 *   waypoint) is supported at each `staple`, `bore` and `duct` waypoint. Measured along the stored
 *   polyline (the floor's point set: entry points and waypoints), the first support from a box entry
 *   and the last support to one are each at most {@link NM_SUPPORT_SPACING}'s `fromBoxMm`, and
 *   consecutive supports at most its `betweenMm`. A free end isn't a box: the run from it to the first
 *   support isn't checked. A cable with no staple or bore (on a bench, in a panel's duct) isn't a
 *   framing run and isn't checked.
 * - **Bored-hole limit** (`beyond-tool-capacity` from `checkTool(…, 'bore')`): a bit or hole saw wider
 *   than {@link BORED_HOLE_MAX} can't bore a P3 stud.
 * - **Edge distance** (a warning, never a refusal): a bore is centred `BORE_DEPTH_MM` (44 mm) behind the
 *   stud face, so a bit of diameter D leaves `BORE_DEPTH_MM − D / 2` to the face. Under
 *   {@link BORE_EDGE_MIN} the cable needs a steel nail plate over the stud edge. P3 doesn't model nail
 *   plates, so a command can't refuse here without forbidding a compliant installation (plate fitted),
 *   and can't accept silently as compliant either: {@link boreNeedsNailPlate} is exported for the UI to
 *   warn with and for P4's inspector to flag. Recorded in the commands caveats.
 */

/** The maximum spacing of an NM cable's supports, from a box and between supports (mm). */
export interface SupportSpacing {
  /** From a box entry to the first support, or from the last support to a box entry. */
  readonly fromBoxMm: number;
  /** Between consecutive supports. */
  readonly betweenMm: number;
  readonly kind: 'real-world';
  readonly source: string;
}

/**
 * NM cable support spacing, one paraphrased value: secured within 12 in (304.8 mm) of each box and at
 * most every 4-1/2 ft (1371.6 mm) along the run. Exact inch conversions (NIST SP 811); measured along
 * the route as stored.
 */
export const NM_SUPPORT_SPACING: SupportSpacing = {
  fromBoxMm: 304.8,
  betweenMm: 1371.6,
  kind: 'real-world',
  source:
    'NFPA 70-2023 Art. 334.30 (cited by number, paraphrased): NM cable is secured by staples or similar fittings within 12 in of every box and at intervals of no more than 4-1/2 ft; a cable run through holes bored in framing at those intervals counts as supported. 12 in = 304.8 mm and 4-1/2 ft = 1371.6 mm exactly (NIST SP 811)',
};

/**
 * The largest hole a P3 stud may be bored with: 40 % of its 88.9 mm depth = 35.56 mm. Every P3 stud
 * wall is taken as a bearing wall (game-design: P3 has no wall roles; the bearing limit is the stricter
 * one, a non-bearing stud takes 60 %).
 */
export const BORED_HOLE_MAX: SourcedLength = {
  valueMm: 35.56, // 40 % of WALL_STUD_DEPTH (88.9 mm), as a literal: pinned in framing.spec.ts
  kind: 'real-world',
  source:
    'IRC 2021 Sec. R602.6 (cited by number, paraphrased): a bored hole in a stud of a bearing wall is at most 40 % of the stud depth (60 % in a non-bearing wall) and keeps 5/8 in from the stud edge; 40 % of 88.9 mm = 35.56 mm. Treating every P3 stud wall as bearing is game-design',
};

/**
 * The least distance from a bored hole's edge to the stud's nailing edge without a steel plate:
 * 1-1/4 in = 31.75 mm.
 */
export const BORE_EDGE_MIN: SourcedLength = {
  valueMm: 31.75,
  kind: 'real-world',
  source:
    'NFPA 70-2023 Art. 300.4(A)(1) (cited by number, paraphrased): a cable through a bored hole in a wood member is set back at least 1-1/4 in from the nearest edge, or protected by a steel plate at least 1/16 in thick; 1-1/4 in = 31.75 mm exactly (NIST SP 811)',
};

/**
 * The distance (mm) from the edge of a hole of `diameterMm`, bored at `BORE_DEPTH_MM` (44 mm) behind the
 * stud face, to the nearer nailing edge (the face side: 44 < 88.9 − 44). A 1 in bit leaves 31.3 mm.
 */
export function boreEdgeDistanceMm(diameterMm: number): number {
  return BORE_CENTRE_MM - diameterMm / 2;
}

/** Whether a hole of `diameterMm` leaves less than {@link BORE_EDGE_MIN} to the stud edge (a nail plate is needed). */
export function boreNeedsNailPlate(diameterMm: number): boolean {
  return boreEdgeDistanceMm(diameterMm) < BORE_EDGE_MIN.valueMm;
}

/** Whether a hole of `diameterMm` is over the bored-hole limit ({@link BORED_HOLE_MAX}). */
export function boredHoleTooLarge(diameterMm: number): boolean {
  return diameterMm > BORED_HOLE_MAX.valueMm;
}

/** The waypoint kinds that support a cable (a staple, a bored hole, a duct it lies in). */
const SUPPORTS: ReadonlySet<Waypoint['kind']> = new Set(['staple', 'bore', 'duct']);

/** Whether a route is a run in framing: it has a staple or a bored hole. */
export function inFraming(route: readonly Pick<Waypoint, 'kind'>[]): boolean {
  return route.some((w) => w.kind === 'staple' || w.kind === 'bore');
}

/** A support-spacing problem along a route: where, how far, and the limit. */
export interface SupportGap {
  /** `from-box-a`: entry a to the first support; `between`: two supports; `from-box-b`: the last support to entry b. */
  readonly where: 'from-box-a' | 'between' | 'from-box-b';
  /** The route waypoint index (0-based) the gap ends at (`from-box-b`: the last support's). */
  readonly waypoint: number;
  readonly distanceMm: number;
  readonly limitMm: number;
}

/**
 * A bore's centre behind the stud face: the stud's mid-depth, round(88.9 / 2) = 44 mm. The same value
 * as `routing/snap`'s `BORE_DEPTH_MM` (pinned equal in `framing.spec.ts`), computed here so the
 * commands' checks don't import the snapper.
 */
const BORE_CENTRE_MM = Math.round(WALL_STUD_DEPTH.valueMm / 2);

const dist = (p: PositionMm, q: PositionMm): number => {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const dz = q.z - p.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

/**
 * The first support gap over {@link NM_SUPPORT_SPACING} along a cable's route, or `null` (see the
 * module comment). `a` and `b` are the entry points of the cable's box ends (`null`: a free end).
 * Pure; the distances are sums of `Math.sqrt` of integers in route order.
 */
export function supportGap(
  a: PositionMm | null,
  route: readonly Pick<Waypoint, 'kind' | 'positionMm'>[],
  b: PositionMm | null,
  spacing: Pick<SupportSpacing, 'fromBoxMm' | 'betweenMm'> = NM_SUPPORT_SPACING,
): SupportGap | null {
  if (!inFraming(route)) return null;
  let along = 0; // distance since the last support (or since entry a)
  let last: number | null = null; // the last support's index
  let previous: PositionMm | null = a;
  for (const [index, w] of route.entries()) {
    if (previous !== null) along += dist(previous, w.positionMm);
    previous = w.positionMm;
    if (!SUPPORTS.has(w.kind)) continue;
    if (last === null && a !== null && along > spacing.fromBoxMm) {
      return { where: 'from-box-a', waypoint: index, distanceMm: along, limitMm: spacing.fromBoxMm };
    }
    if (last !== null && along > spacing.betweenMm) {
      return { where: 'between', waypoint: index, distanceMm: along, limitMm: spacing.betweenMm };
    }
    last = index;
    along = 0;
  }
  if (b !== null && previous !== null) {
    along += dist(previous, b);
    if (last !== null && along > spacing.fromBoxMm) {
      return { where: 'from-box-b', waypoint: last, distanceMm: along, limitMm: spacing.fromBoxMm };
    }
  }
  return null;
}

/** `staple-spacing` for a cable route whose supports are too far apart, or `null` ({@link supportGap}). */
export function checkCableSupport(
  a: PositionMm | null,
  route: readonly Pick<Waypoint, 'kind' | 'positionMm'>[],
  b: PositionMm | null,
): CommandFailure | null {
  const gap = supportGap(a, route, b);
  if (gap === null) return null;
  const mm = (v: number) => Math.round(v);
  const where =
    gap.where === 'from-box-a'
      ? `The first support (waypoint ${gap.waypoint + 1}) is ${mm(gap.distanceMm)} mm from the box at end a`
      : gap.where === 'from-box-b'
        ? `The last support (waypoint ${gap.waypoint + 1}) is ${mm(gap.distanceMm)} mm from the box at end b`
        : `Waypoint ${gap.waypoint + 1} is ${mm(gap.distanceMm)} mm from the previous support`;
  return fail('staple-spacing', `${where}; NM cable is supported at most every ${gap.limitMm} mm there`);
}
