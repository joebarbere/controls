import type { Catalog } from '@controls/catalog';
import { findEntity } from '../entity-commands';
import { fixtureSnapTarget, fixtureSpec } from '../fixtures';
import { frameAxes } from '../snap/surface';
import { rotateQuarterTurns } from '../snap/quarter-turn';
import type { Cable, CableId, Connection, ConnectionId, PositionMm, World } from '../types';
import { cableEntryFrame, cableJacketEnd, endMethodSpec, landedPoint } from '../wiring/checks';
import { BAKE_UNITS_PER_MM, ROUTE_LEAD_OUT } from './constants';
import { laneSizeTenths } from './lanes';
import { UNIT, type Vec3 } from './vec';

/*
 * Cable ends (F3.2 part 4; ADR 0015 "Tail shapes are baked, never stored"): what a cable looks like
 * past each entry. A pure function of the world and the catalogue, like `bakeWorldRoutes`, never
 * stored or hashed, and integer tenths of a millimetre out.
 *
 * - **The jacket** runs straight in along the entry's inward axis from the entry point to where the
 *   jacket ends (`cableJacketEnd`: the tail less what is stripped). It continues the cable's run.
 * - **Each conductor's tail** starts at the jacket end, fanned across the entry (`fanAxis`: the flat
 *   jacket's wide axis there, from `cableFaceAxis` on a stud wall) one conductor diameter apart in assembly order, centred. A landed end runs straight to a
 *   12 mm lead-out ({@link ROUTE_LEAD_OUT}) and into its method's entry point; an unlanded one is a
 *   straight stub along the inward axis as long as the stripped length (none while the jacket is on).
 * - **A free cable end** (no entry, so no axis) has no jacket stub: a landed conductor's tail runs from
 *   the rest waypoint to its terminal; an unlanded one isn't drawn.
 *
 * The drawn tail is a picture: what is wired is the landing, and what bounds it is `checkTailReach`.
 * `+ − × ÷` and rounding only (D6).
 */

/** One conductor's tail at one end of its cable. */
export interface BakedTail {
  readonly connection: ConnectionId;
  /** Its index in the cable assembly. */
  readonly conductor: number;
  readonly landed: boolean;
  /** Flat x, y, z in integer tenths of mm: from the jacket end (fanned) to the terminal or the stub's tip. */
  readonly points: readonly number[];
}

/** One end of a cable past its entry. */
export interface BakedCableEnd {
  readonly cable: CableId;
  readonly end: 'a' | 'b';
  /** The jacket stub, flat x, y, z in tenths: the entry point, then the jacket end (`[]` at a free end). */
  readonly jacket: readonly number[];
  readonly tails: readonly BakedTail[];
}

const q = (v: number): number => Math.round(v * BAKE_UNITS_PER_MM) + 0;

/**
 * The axis a flat cable's wide faces face where it runs vertically (F3.2 part 4, realism review F2):
 * the `u` axis (across the wall) of the stud wall its first staple or bore is on, so a run up a stud
 * lies with its wide face against the stud's side face, as NM-B is stapled. `null` for a cable with
 * no staple or bore on a stud wall the fixtures know (the renderer then uses world +z). Integer unit
 * vector, pure.
 */
export function cableFaceAxis(world: Pick<World, 'fixtures'>, cable: Pick<Cable, 'route'>): PositionMm | null {
  for (const w of cable.route) {
    if ((w.kind !== 'staple' && w.kind !== 'bore') || w.fixture === null) continue;
    const fixture = world.fixtures.find((f) => f.id === w.fixture);
    if (!fixture || fixtureSpec(fixture.ref)?.kind !== 'stud-wall') continue;
    const target = fixtureSnapTarget(fixture);
    if (target) return frameAxes(target.frame).u;
  }
  return null;
}

/**
 * The fan axis across an entry: the wide axis of a flat cable along `inward`, with the renderer's
 * frame (`flatThinAxis`): along a vertical entry, across `face` (the cable's `cableFaceAxis`, default
 * +z), so +x by default; along a horizontal one, flat (thin along +y), so +z for an entry along x and
 * +x for one along z. Positive components (the fan's order follows it).
 */
export function fanAxis(inward: PositionMm, face: PositionMm | null = null): PositionMm {
  const thin = inward.y !== 0 ? (face ?? UNIT['+z']) : UNIT['+y'];
  const wide = {
    x: inward.y * thin.z - inward.z * thin.y,
    y: inward.z * thin.x - inward.x * thin.z,
    z: inward.x * thin.y - inward.y * thin.x,
  };
  return { x: Math.abs(wide.x) + 0, y: Math.abs(wide.y) + 0, z: Math.abs(wide.z) + 0 };
}

/** Pushes `p` (mm) as tenths, dropping a repeat of the last point. */
function push(points: number[], p: Vec3): void {
  const x = q(p.x);
  const y = q(p.y);
  const z = q(p.z);
  const n = points.length;
  if (n >= 3 && points[n - 3] === x && points[n - 2] === y && points[n - 1] === z) return;
  points.push(x, y, z);
}

/** A landed conductor end's terminal point and its lead-out point, or `null` if the catalogue can't place it. */
function terminalAndLead(world: World, catalog: Catalog, wire: Connection, end: 'a' | 'b'): [Vec3, Vec3] | null {
  const landed = wire[end];
  if (landed === null) return null;
  const point = landedPoint(world, catalog, landed);
  const spec = endMethodSpec(world, catalog, landed);
  const entity = findEntity(world, landed.entity);
  if (point === null || !spec || !entity) return null;
  const exit = rotateQuarterTurns(entity.transform.orientationMdeg, UNIT[spec.exitAxis]);
  if (exit === null) return null;
  const lead = ROUTE_LEAD_OUT.valueMm;
  return [point, { x: point.x + exit.x * lead, y: point.y + exit.y * lead, z: point.z + exit.z * lead }];
}

/** One end of `cable` (see the module comment), or `null` when the catalogue can't place a box end. */
function bakeEnd(
  world: World,
  catalog: Catalog,
  cable: Cable,
  end: 'a' | 'b',
  conductors: readonly Connection[],
  face: PositionMm | null,
): BakedCableEnd | null {
  const tails: BakedTail[] = [];
  if (cable[end] === null) {
    const rest = end === 'a' ? cable.route[0] : cable.route.at(-1);
    if (!rest) return null;
    for (const wire of conductors) {
      const at = terminalAndLead(world, catalog, wire, end);
      if (at === null) continue;
      const points: number[] = [];
      push(points, rest.positionMm);
      push(points, at[1]);
      push(points, at[0]);
      tails.push({ connection: wire.id, conductor: wire.cable?.conductor ?? 0, landed: true, points });
    }
    return { cable: cable.id, end, jacket: [], tails };
  }
  const frame = cableEntryFrame(world, catalog, cable, end);
  const jacketEnd = cableJacketEnd(world, catalog, cable, end);
  if (frame === null || jacketEnd === null) return null;
  const jacket: number[] = [];
  push(jacket, frame.point);
  push(jacket, jacketEnd);
  const across = fanAxis(frame.inward, face);
  const pitches = conductors.map((c) => laneSizeTenths(catalog, 'conductor', c.ref).width / BAKE_UNITS_PER_MM);
  const span = pitches.reduce((sum, p) => sum + p, 0);
  const strip = cable.jacketStripMm[end];
  let offset = -span / 2;
  conductors.forEach((wire, i) => {
    const centre = offset + pitches[i] / 2;
    offset += pitches[i];
    const start = {
      x: jacketEnd.x + across.x * centre,
      y: jacketEnd.y + across.y * centre,
      z: jacketEnd.z + across.z * centre,
    };
    const at = terminalAndLead(world, catalog, wire, end);
    const points: number[] = [];
    if (at !== null) {
      push(points, start);
      push(points, at[1]);
      push(points, at[0]);
    } else if (strip > 0) {
      push(points, start);
      push(points, {
        x: start.x + frame.inward.x * strip,
        y: start.y + frame.inward.y * strip,
        z: start.z + frame.inward.z * strip,
      });
    } else {
      return; // still inside the jacket
    }
    tails.push({ connection: wire.id, conductor: wire.cable?.conductor ?? i, landed: at !== null, points });
  });
  return { cable: cable.id, end, jacket, tails };
}

/**
 * Every cable's ends (cable-id order, end `a` then `b`), each with its jacket stub and its conductors'
 * tails in assembly order. An end the catalogue can't place is left out. Pure.
 */
export function bakeCableEnds(world: World, catalog: Catalog): BakedCableEnd[] {
  const byCable = new Map<CableId, Connection[]>();
  for (const c of world.connections) {
    if (c.cable === null) continue;
    const list = byCable.get(c.cable.id) ?? [];
    list.push(c);
    byCable.set(c.cable.id, list);
  }
  const out: BakedCableEnd[] = [];
  for (const cable of [...world.cables].sort((p, r) => p.id - r.id)) {
    const conductors = (byCable.get(cable.id) ?? []).sort(
      (p, r) => (p.cable?.conductor ?? 0) - (r.cable?.conductor ?? 0) || p.id - r.id,
    );
    const face = cableFaceAxis(world, cable);
    for (const end of ['a', 'b'] as const) {
      const baked = bakeEnd(world, catalog, cable, end, conductors, face);
      if (baked !== null) out.push(baked);
    }
  }
  return out;
}
