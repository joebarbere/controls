import { BUILTIN_PROP_VERSION, builtinProp } from './props';
import { BACKPLATE_MARGIN, BENCH_TOP_MARGIN } from './snap/constants';
import type { SnapTarget } from './snap/snap';
import { DIRECTION, type FrameNormal, type SurfaceFrame, type SurfaceNormal, type Vec3Mm } from './snap/surface';
import type { CatalogRef, OrientationMdeg } from './types';

/*
 * Built-in fixtures (F1.9): the fixed level geometry a world's `fixtures` list places by catalogue
 * ref (`prop.<name>` at version 1, ADR 0007). The renderer draws each kind with a procedural recipe
 * and scripts snap against {@link worldSnapTargets}; both read this one table, so a cursor point
 * snaps to the same place in the game and headless. Positions live in the level document
 * (`content/levels/workshop.json`), never here.
 *
 * Each kind's local frame (before the fixture's transform):
 * - `backplate`, `board`: origin at the lower-left corner of the front face; the body is behind it (-z).
 * - `din-rail`: origin at the rail's left end, on its centreline, on the face it is mounted on; it
 *   stands off +z by the TS35 height.
 * - `stud-wall`: origin at the lower-left corner on the floor, on the stud faces; studs run back (-z).
 * - `bench`: origin at its min corner on the floor; it spans +x, +y and +z (front edge at z = depth).
 * - `floor`: origin at the min corner of the walking surface; it spans +x and +z.
 *
 * Sizes are integer mm. Real-world dimensions (stud spacing and size, the TS35 profile, the DIN
 * module) live in `snap/constants.ts` with their sources; the sizes here are game-design and say so.
 */

interface SpecBase {
  /** Catalogue id (`prop.backplate`); the version is {@link BUILTIN_PROP_VERSION}. */
  readonly id: string;
  readonly title: string;
  readonly source: string;
}

export interface BackplateSpec extends SpecBase {
  readonly kind: 'backplate';
  readonly widthMm: number;
  readonly heightMm: number;
  readonly thicknessMm: number;
}

export interface DinRailSpec extends SpecBase {
  readonly kind: 'din-rail';
  readonly lengthMm: number;
}

export interface StudWallSpec extends SpecBase {
  readonly kind: 'stud-wall';
  readonly widthMm: number;
  readonly heightMm: number;
  /** u of the first stud's centre from the wall's left end. */
  readonly firstStudCentreMm: number;
}

export interface BenchSpec extends SpecBase {
  readonly kind: 'bench';
  readonly widthMm: number;
  readonly heightMm: number;
  readonly depthMm: number;
  readonly topThicknessMm: number;
}

export interface BoardSpec extends SpecBase {
  readonly kind: 'board';
  readonly widthMm: number;
  readonly heightMm: number;
  readonly thicknessMm: number;
}

export interface FloorSpec extends SpecBase {
  readonly kind: 'floor';
  readonly widthMm: number;
  readonly depthMm: number;
}

export type FixtureSpec = BackplateSpec | DinRailSpec | StudWallSpec | BenchSpec | BoardSpec | FloorSpec;
export type FixtureKind = FixtureSpec['kind'];

const bench = builtinProp({ id: 'prop.bench', version: BUILTIN_PROP_VERSION });
if (!bench) throw new Error('prop.bench missing from BUILTIN_PROPS');

/** Every built-in fixture, sorted by id. */
export const FIXTURE_SPECS: readonly FixtureSpec[] = [
  {
    id: 'prop.backplate',
    kind: 'backplate',
    title: 'Backplate',
    widthMm: 600,
    heightMm: 800,
    thicknessMm: 3,
    source: 'game-design: 600 × 800 mm training sub-panel, 3 mm drawn thickness (not modelled on a product)',
  },
  {
    id: 'prop.bench',
    kind: 'bench',
    title: 'Workbench',
    // The same outline as the placeable `prop.bench` (BUILTIN_PROPS), so the two never disagree.
    widthMm: bench.sizeMm.widthMm,
    heightMm: bench.sizeMm.heightMm,
    depthMm: bench.sizeMm.depthMm,
    topThicknessMm: 40,
    source: `${bench.source}; 40 mm hardwood top (game-design)`,
  },
  {
    id: 'prop.din-rail',
    kind: 'din-rail',
    title: 'DIN rail (TS35)',
    lengthMm: 500,
    source: 'game-design: 500 mm length; the profile is TS 35 × 7.5 (DIN_RAIL_TS35, EN 60715)',
  },
  {
    id: 'prop.plywood-backboard',
    kind: 'board',
    title: 'Plywood backboard',
    widthMm: 1220,
    heightMm: 1220,
    thicknessMm: 18,
    source:
      'game-design: a 4 × 4 ft (1219.2 mm, rounded to 1220) offcut of nominal 3/4 in plywood (23/32 in, about 18.3 mm actual, drawn at 18 mm), screwed across the studs behind the backplate',
  },
  {
    id: 'prop.stud-wall',
    kind: 'stud-wall',
    title: 'Stud wall',
    // 12 bays at 16 in o.c. plus one stud: 12 × 406.4 + 38.1 = 4914.9 mm, so both end studs are flush.
    widthMm: 4915,
    heightMm: 2440,
    firstStudCentreMm: 19,
    source:
      'game-design: open 2×4 wall section, 12 bays (stud spacing and size are WALL_STUD_SPACING and WALL_STUD_THICKNESS); 2440 mm is about 8 ft, rounded; first stud centre 19 mm (half a stud) so the end stud is flush',
  },
  {
    id: 'prop.workshop-floor',
    kind: 'floor',
    title: 'Workshop floor',
    widthMm: 5000,
    depthMm: 3700,
    source: 'game-design: 5 × 3.7 m sealed-concrete workshop bay',
  },
];

/**
 * What the fixture functions read: a fixture's id, ref and transform. Any readonly view of a
 * `Fixture` fits, including a script's `game.world()` snapshot.
 */
export interface FixtureLike {
  readonly id: string;
  readonly ref: CatalogRef;
  readonly transform: { readonly positionMm: Vec3Mm; readonly orientationMdeg: OrientationMdeg };
}

/** The fixture spec a catalogue ref points at, or `undefined` (unknown id, or a version other than 1). */
export function fixtureSpec(ref: CatalogRef): FixtureSpec | undefined {
  if (ref.version !== BUILTIN_PROP_VERSION) return undefined;
  return FIXTURE_SPECS.find((s) => s.id === ref.id);
}

/** The kind's snap target in its local frame (`id` left empty), or `null` if it offers none. */
function localSnapTarget(spec: FixtureSpec): SnapTarget | null {
  const origin = { x: 0, y: 0, z: 0 };
  const front: SurfaceFrame = { origin, normal: '+z' };
  switch (spec.kind) {
    case 'backplate':
      return {
        kind: 'backplate-grid',
        id: '',
        frame: front,
        widthMm: spec.widthMm,
        heightMm: spec.heightMm,
        marginMm: BACKPLATE_MARGIN.valueMm,
      };
    case 'din-rail':
      return { kind: 'din-rail', id: '', frame: front, lengthMm: spec.lengthMm };
    case 'stud-wall':
      return {
        kind: 'wall-studs',
        id: '',
        frame: front,
        widthMm: spec.widthMm,
        heightMm: spec.heightMm,
        firstStudCentreMm: spec.firstStudCentreMm,
      };
    case 'bench':
      // The top's front-left corner: u along the front edge, v from front to back.
      return {
        kind: 'bench-top',
        id: '',
        frame: { origin: { x: 0, y: spec.heightMm, z: spec.depthMm }, normal: '+y', right: '+x' },
        widthMm: spec.widthMm,
        heightMm: spec.depthMm,
        marginMm: BENCH_TOP_MARGIN.valueMm,
      };
    case 'board':
    case 'floor':
      return null;
  }
}

/** The local working face work mode frames (`view.focus`), or `null` if the kind isn't a focus target (floors). */
function localFocusNormal(spec: FixtureSpec): SurfaceNormal | null {
  return spec.kind === 'floor' ? null : '+z';
}

/** Quarter turns (0…3) of a fixture's yaw, or `null` unless it is a plain yaw quarter-turn. */
export function quarterTurns(o: OrientationMdeg): number | null {
  if (o.pitch !== 0 || o.roll !== 0 || o.yaw % 90_000 !== 0) return null;
  return o.yaw / 90_000;
}

const z0 = (n: number): number => (n === 0 ? 0 : n);

/** Rotates an integer vector by `turns` quarter-turns of yaw about +y (ADR 0007: +z turns to +x). */
export function yawVec(v: Vec3Mm, turns: number): Vec3Mm {
  let { x, z } = v;
  for (let i = 0; i < turns; i++) [x, z] = [z, -x];
  return { x: z0(x), y: z0(v.y), z: z0(z) };
}

function yawDirection<D extends FrameNormal>(d: D, turns: number): D {
  if (d === '+y') return d;
  const v = yawVec(DIRECTION[d], turns);
  const found = (Object.keys(DIRECTION) as FrameNormal[]).find((k) => {
    const w = DIRECTION[k];
    return w.x === v.x && w.y === v.y && w.z === v.z;
  });
  return found as D;
}

function toWorldFrame(frame: SurfaceFrame, fixture: FixtureLike, turns: number): SurfaceFrame {
  const p = fixture.transform.positionMm;
  const o = yawVec(frame.origin, turns);
  const world: SurfaceFrame = {
    origin: { x: p.x + o.x, y: p.y + o.y, z: p.z + o.z },
    normal: yawDirection(frame.normal, turns),
  };
  return frame.right ? { ...world, right: yawDirection(frame.right, turns) } : world;
}

/**
 * A fixture's snap target in world space, named by the fixture's id, or `null`: unknown ref, a kind
 * without one, or a transform that isn't a plain yaw quarter-turn (P1 surfaces are axis-aligned).
 */
export function fixtureSnapTarget(fixture: FixtureLike): SnapTarget | null {
  const spec = fixtureSpec(fixture.ref);
  const turns = quarterTurns(fixture.transform.orientationMdeg);
  if (!spec || turns === null) return null;
  const local = localSnapTarget(spec);
  if (!local) return null;
  return { ...local, id: fixture.id, frame: toWorldFrame(local.frame, fixture, turns) };
}

/** The world direction of a fixture's working face (for `view.focus`), or `null` if it can't be focused (floors, unknown refs, tilted fixtures). */
export function fixtureFocusNormal(fixture: FixtureLike): SurfaceNormal | null {
  const spec = fixtureSpec(fixture.ref);
  const turns = quarterTurns(fixture.transform.orientationMdeg);
  if (!spec || turns === null) return null;
  const normal = localFocusNormal(spec);
  return normal && yawDirection(normal, turns);
}

/**
 * Every snap target in a world, in fixture id order: what placement snaps to. The renderer's ghost,
 * the workspace's commit and scripts (`placeOnTargets(ref, cursor, worldSnapTargets(game.world()))`)
 * all use this, so they agree.
 */
export function worldSnapTargets(world: { readonly fixtures: readonly FixtureLike[] }): SnapTarget[] {
  return world.fixtures.flatMap((f) => {
    const target = fixtureSnapTarget(f);
    return target ? [target] : [];
  });
}
