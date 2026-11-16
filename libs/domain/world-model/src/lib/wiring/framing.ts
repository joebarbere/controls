import { type Catalog, deviceBodySizeMm } from '@controls/catalog';
import { type CommandFailure, fail } from '@controls/commands';
import { fixtureSnapTarget, fixtureSpec } from '../fixtures';
import { type SourcedLength, WALL_STUD_DEPTH } from '../snap/constants';
import { entityPointMm } from '../snap/quarter-turn';
import type { WallStudsTarget } from '../snap/snap';
import { worldToSurface } from '../snap/surface';
import type { CableEnd, EntityId, PositionMm, Waypoint, World } from '../types';

/*
 * Cable in wood framing (F3.2 part 4): how an NM cable is supported, how large a hole a stud takes,
 * how close a bored hole comes to the stud's nailing edge, and how much sheath stays inside a box.
 * Realism charter (plan §3): each constant cites its source **by number** and paraphrases it; no code
 * text or table is reproduced. Pure, and `+ − × ÷`, rounding and `Math.sqrt` only (D6).
 *
 * - **Support spacing** (`staple-spacing`). A cable run in framing is one whose route has a `staple` or
 *   `bore` waypoint, or whose two ends are both in enclosures on a stud wall (`enclosureOnStudWall`).
 *   Measured along the stored polyline (the floor's point set: entry points and waypoints):
 *   - from a box entry to the first **staple**, and from the last staple to a box entry, at most
 *     {@link NM_SUPPORT_SPACING}'s `fromBoxMm`. Only a staple secures the cable near a box: a run
 *     through bored holes counts as supported only away from boxes, so a bore or a duct never satisfies
 *     the near-box rule (with no staple at all, however short the run, a box end is a gap);
 *   - between consecutive supports (`staple`, `bore` and `duct` waypoints) at most `betweenMm`.
 *   A free end isn't a box: the run from it to the first support isn't checked. P3 bores go through
 *   studs, so a run through them is horizontal, the case in which bored holes count as support.
 * - **Bored-hole limit** (`beyond-tool-capacity` from `checkTool(…, 'bore')`): a bit or hole saw wider
 *   than {@link BORED_HOLE_MAX} can't bore a P3 stud.
 * - **Edge distance** (a warning, never a refusal): a bore is centred at the stud's mid-depth, half of
 *   88.9 mm = 44.45 mm (the stored waypoint is at the rounded 44 mm; the hole is the drilled one), so a
 *   bit of diameter D leaves `44.45 − D / 2` to the face, compared in integer micrometres. Under
 *   {@link BORE_EDGE_MIN} the cable needs a steel nail plate (a 1 in bit leaves exactly 31.75 mm: fine).
 *   P3 doesn't model nail plates, so a command can't refuse without forbidding a compliant
 *   installation (plate fitted), and can't accept silently as compliant either:
 *   {@link boreNeedsNailPlate} is exported for the UI to warn with and for P4's inspector to flag.
 * - **Sheath inside a box** (`strip-too-long` from `cable.strip`): at a box end at least
 *   {@link MIN_SHEATH_IN_BOX} of jacket stays past the entry (`jacketStripMm ≤ tailsMm − 6.35`).
 */

/** The maximum spacing of an NM cable's supports, from a box and between supports (mm). */
export interface SupportSpacing {
  /** From a box entry to the first staple, or from the last staple to a box entry. */
  readonly fromBoxMm: number;
  /** Between consecutive supports. */
  readonly betweenMm: number;
  readonly kind: 'real-world';
  readonly source: string;
}

/**
 * NM cable support spacing, one paraphrased value: stapled within 12 in (304.8 mm) of each box and
 * supported at most every 4-1/2 ft (1371.6 mm) along the run. Exact inch conversions (NIST SP 811);
 * measured along the route as stored.
 */
export const NM_SUPPORT_SPACING: SupportSpacing = {
  fromBoxMm: 304.8,
  betweenMm: 1371.6,
  kind: 'real-world',
  source:
    'NFPA 70-2023 Art. 334.30 and 334.30(A) (cited by number, paraphrased): NM cable is secured by staples or similar fittings within 12 in of every box and at intervals of no more than 4-1/2 ft. A run through holes bored in framing at those intervals counts as supported only where the run is not vertical, and the cable is still secured within 12 in of each box. P3 bores go through studs, so such runs are horizontal. 12 in = 304.8 mm and 4-1/2 ft = 1371.6 mm exactly (NIST SP 811)',
};

/**
 * The largest hole a P3 stud may be bored with: 40 % of its 88.9 mm depth = 35.56 mm. Every P3 stud
 * wall is taken as an exterior or bearing wall with single studs (game-design: P3 has no wall roles;
 * that limit is the stricter one; a non-bearing stud takes 60 %, and so may a doubled bearing stud).
 */
export const BORED_HOLE_MAX: SourcedLength = {
  valueMm: 35.56, // 40 % of WALL_STUD_DEPTH (88.9 mm), as a literal: pinned in framing.spec.ts
  kind: 'real-world',
  source:
    'IRC 2021 Sec. R602.6 (cited by number, paraphrased): a bored hole in a stud of an exterior or bearing wall is at most 40 % of the stud depth (up to 60 % where the stud is doubled), at most 60 % in a non-bearing wall, and keeps 5/8 in from the stud edge; 40 % of 88.9 mm = 35.56 mm. Treating every P3 stud wall as exterior or bearing with single studs is game-design',
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

/** The least jacket left inside a box past the entry: 1/4 in = 6.35 mm. */
export const MIN_SHEATH_IN_BOX: SourcedLength = {
  valueMm: 6.35,
  kind: 'real-world',
  source:
    'NFPA 70-2023 Art. 314.17 (cited by number, paraphrased): where nonmetallic-sheathed cable enters a box, its sheath extends at least 1/4 in inside the box, past the cable clamp or knockout. Applied at every P3 box entry (game-design: P3 entries do not distinguish box material). 1/4 in = 6.35 mm exactly (NIST SP 811)',
};

/** Micrometres of a length in mm (exact for the catalogue's 0.001 mm precision). */
const um = (mm: number): number => Math.round(mm * 1000);

/**
 * The distance (mm) from the edge of a hole of `diameterMm`, drilled at the stud's mid-depth (44.45 mm
 * behind the face), to the nearer nailing edge. A 1 in bit leaves exactly 31.75 mm.
 */
export function boreEdgeDistanceMm(diameterMm: number): number {
  return (um(WALL_STUD_DEPTH.valueMm) - um(diameterMm)) / 2000;
}

/**
 * Whether a hole of `diameterMm` leaves less than {@link BORE_EDGE_MIN} to the stud edge (a nail plate
 * is needed), compared in integer micrometres: `(88 900 − D) / 2 < 31 750`.
 */
export function boreNeedsNailPlate(diameterMm: number): boolean {
  return um(WALL_STUD_DEPTH.valueMm) - um(diameterMm) < 2 * um(BORE_EDGE_MIN.valueMm);
}

/** Whether a hole of `diameterMm` is over the bored-hole limit ({@link BORED_HOLE_MAX}), in integer micrometres. */
export function boredHoleTooLarge(diameterMm: number): boolean {
  return um(diameterMm) > um(BORED_HOLE_MAX.valueMm);
}

/** The most jacket `cable.strip` may remove at a box end with tail `tailMm`: at least 6.35 mm stays inside. */
export function maxStripAtBoxMm(tailMm: number): number {
  return Math.floor((um(tailMm) - um(MIN_SHEATH_IN_BOX.valueMm)) / 1000);
}

/** The waypoint kinds that support a cable between supports (a staple, a bored hole, a duct it lies in). */
const SUPPORTS: ReadonlySet<Waypoint['kind']> = new Set(['staple', 'bore', 'duct']);

/** Whether a route has a staple or a bored hole (a run in framing by its waypoints). */
export function inFraming(route: readonly Pick<Waypoint, 'kind'>[]): boolean {
  return route.some((w) => w.kind === 'staple' || w.kind === 'bore');
}

/**
 * Whether entity `id` is an enclosure on a stud wall: its body box, in a `prop.stud-wall` fixture's
 * frame, overlaps or touches the wall's studs (u across the wall, v up it, and depth from the stud faces
 * back 88.9 mm), as a box nailed to a stud or a panel hung on the studs is. Integer geometry; `false`
 * for a non-enclosure, an unknown ref, or an entity not at quarter-turns.
 */
export function enclosureOnStudWall(
  world: Pick<World, 'entities' | 'fixtures'>,
  catalog: Catalog,
  id: EntityId,
): boolean {
  const entity = world.entities.find((e) => e.id === id);
  const device = entity && catalog.device(entity.ref);
  if (!entity || !device?.enclosure) return false;
  const size = deviceBodySizeMm(device, entity.state);
  const far = size && entityPointMm(entity.transform, { x: size.widthMm, y: size.heightMm, z: size.depthMm });
  if (!far) return false;
  const near = entity.transform.positionMm;
  const corners: PositionMm[] = [];
  for (const x of [near.x, far.x])
    for (const y of [near.y, far.y]) for (const z of [near.z, far.z]) corners.push({ x, y, z });
  const depth = um(WALL_STUD_DEPTH.valueMm);
  for (const fixture of world.fixtures) {
    if (fixtureSpec(fixture.ref)?.kind !== 'stud-wall') continue;
    const target = fixtureSnapTarget(fixture) as WallStudsTarget | null;
    if (target === null || target.kind !== 'wall-studs') continue;
    const local = corners.map((c) => worldToSurface(target.frame, c));
    const lo = (k: 'u' | 'v' | 'w') => Math.min(...local.map((p) => p[k]));
    const hi = (k: 'u' | 'v' | 'w') => Math.max(...local.map((p) => p[k]));
    if (hi('u') < 0 || lo('u') > target.widthMm || hi('v') < 0 || lo('v') > target.heightMm) continue;
    if (hi('w') * 1000 < -depth || lo('w') > 0) continue;
    return true;
  }
  return false;
}

/** Whether a cable is a run in framing: a staple or bore waypoint, or both ends in enclosures on a stud wall. */
export function cableInFraming(
  world: Pick<World, 'entities' | 'fixtures'>,
  catalog: Catalog,
  a: CableEnd | null,
  route: readonly Pick<Waypoint, 'kind'>[],
  b: CableEnd | null,
): boolean {
  if (inFraming(route)) return true;
  return (
    a !== null &&
    b !== null &&
    enclosureOnStudWall(world, catalog, a.entity) &&
    enclosureOnStudWall(world, catalog, b.entity)
  );
}

/** A support-spacing problem along a route: where, how far, and the limit. */
export interface SupportGap {
  /** `from-box-a`: entry a to the first staple; `between`: two supports; `from-box-b`: the last staple to entry b. */
  readonly where: 'from-box-a' | 'between' | 'from-box-b';
  /** The route waypoint index (0-based) the gap ends at (`from-box-b`: the last staple's; −1: no staple at all). */
  readonly waypoint: number;
  readonly distanceMm: number;
  readonly limitMm: number;
}

const dist = (p: PositionMm, q: PositionMm): number => {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const dz = q.z - p.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

/**
 * The first support gap over `spacing` along a cable's route, or `null` (see the module comment).
 * `a` and `b` are the entry points of the cable's box ends (`null`: a free end). `framing` says the
 * run is in framing (default: by its waypoints, {@link inFraming}); a run that isn't has no gap.
 * Pure; the distances are sums of `Math.sqrt` of integers in route order.
 */
export function supportGap(
  a: PositionMm | null,
  route: readonly Pick<Waypoint, 'kind' | 'positionMm'>[],
  b: PositionMm | null,
  options: { readonly framing?: boolean; readonly spacing?: Pick<SupportSpacing, 'fromBoxMm' | 'betweenMm'> } = {},
): SupportGap | null {
  const spacing = options.spacing ?? NM_SUPPORT_SPACING;
  if (!(options.framing ?? inFraming(route))) return null;
  // Cumulative distance along the polyline at each point: entry a (if any), the waypoints, entry b.
  const at: number[] = [];
  let total = 0;
  let previous: PositionMm | null = a;
  for (const w of route) {
    if (previous !== null) total += dist(previous, w.positionMm);
    at.push(total);
    previous = w.positionMm;
  }
  const end = b !== null && previous !== null ? total + dist(previous, b) : total;
  const staples = route.flatMap((w, i) => (w.kind === 'staple' ? [i] : []));
  if (a !== null) {
    const first = staples[0];
    const d = first === undefined ? end : at[first];
    if (first === undefined || d > spacing.fromBoxMm)
      return { where: 'from-box-a', waypoint: first ?? -1, distanceMm: d, limitMm: spacing.fromBoxMm };
  }
  let last: number | null = null;
  for (const [index, w] of route.entries()) {
    if (!SUPPORTS.has(w.kind)) continue;
    if (last !== null && at[index] - at[last] > spacing.betweenMm) {
      return { where: 'between', waypoint: index, distanceMm: at[index] - at[last], limitMm: spacing.betweenMm };
    }
    last = index;
  }
  if (b !== null) {
    const final = staples.at(-1);
    const d = final === undefined ? end : end - at[final];
    if (final === undefined || d > spacing.fromBoxMm)
      return { where: 'from-box-b', waypoint: final ?? -1, distanceMm: d, limitMm: spacing.fromBoxMm };
  }
  return null;
}

/** `staple-spacing` for a cable route whose supports are too far apart, or `null` ({@link supportGap}). */
export function checkCableSupport(
  a: PositionMm | null,
  route: readonly Pick<Waypoint, 'kind' | 'positionMm'>[],
  b: PositionMm | null,
  framing: boolean = inFraming(route),
): CommandFailure | null {
  const gap = supportGap(a, route, b, { framing });
  if (gap === null) return null;
  const mm = (v: number) => Math.round(v);
  if (gap.where === 'between') {
    return fail(
      'staple-spacing',
      `Waypoint ${gap.waypoint + 1} is ${mm(gap.distanceMm)} mm from the previous support; NM cable is supported at least every ${gap.limitMm} mm`,
    );
  }
  const end = gap.where === 'from-box-a' ? 'a' : 'b';
  const which = gap.where === 'from-box-a' ? 'first' : 'last';
  const what =
    gap.waypoint < 0
      ? `No staple secures the cable near the box at end ${end}`
      : `The ${which} staple (waypoint ${gap.waypoint + 1}) is ${mm(gap.distanceMm)} mm from the box at end ${end}`;
  return fail('staple-spacing', `${what}; NM cable is stapled within ${gap.limitMm} mm of each box`);
}
