import { Box3, Mesh, Vector3, type BufferGeometry } from 'three/webgpu';
import { DIN_RAIL_TS35, FIXTURE_SPECS, studCentres, WALL_STUD_DEPTH } from '@controls/world-model';
import { buildDinRailGeometry } from './din-rail';
import { FixtureRecipes } from './fixtures';

const box = (g: BufferGeometry): Box3 => {
  g.computeBoundingBox();
  if (!g.boundingBox) throw new Error('no bounding box');
  return g.boundingBox;
};
const size = (g: BufferGeometry) => box(g).getSize(new Vector3());

describe('buildDinRailGeometry', () => {
  it('is a TS35×7.5 profile running along X', () => {
    const s = size(buildDinRailGeometry(500));
    expect(s.x).toBeCloseTo(0.5, 6);
    expect(s.y).toBeCloseTo(DIN_RAIL_TS35.widthMm.valueMm / 1000, 6);
    expect(s.z).toBeCloseTo(DIN_RAIL_TS35.heightMm.valueMm / 1000, 6);
  });

  it('sits on the backplate (back face at z = 0)', () => {
    expect(box(buildDinRailGeometry(100)).min.z).toBeCloseTo(0, 9);
  });
});

// Geometry is Float32: compare to a micrometre (6 decimal places in metres).
describe('fixture recipes', () => {
  const recipes = new FixtureRecipes();
  const parts = (id: string) => recipes.acquire({ id, version: 1 }).parts;
  const bounds = (id: string) => {
    const b = new Box3();
    parts(id).forEach((p) => b.union(box(p.geometry)));
    return b;
  };
  afterAll(() => recipes.dispose());

  it('has a recipe with geometry for every built-in fixture', () => {
    for (const spec of FIXTURE_SPECS) expect(parts(spec.id).length, spec.id).toBeGreaterThan(0);
    expect(parts('prop.nope')).toEqual([]);
  });

  it('builds each kind in its local frame (world-model fixtures.ts)', () => {
    // Backplate and board: front face at z = 0, body behind, origin at the lower-left corner.
    const plate = bounds('prop.backplate');
    expect([plate.min.x, plate.min.y, plate.max.z]).toEqual([0, 0, 0].map((n) => expect.closeTo(n, 6)));
    expect(plate.max.x).toBeCloseTo(0.6, 6);
    expect(plate.min.z).toBeCloseTo(-0.003, 6);
    expect(bounds('prop.plywood-backboard').min.z).toBeCloseTo(-0.018, 6);
    // DIN rail: from its left end, back on the face, standing off by the TS35 height.
    const rail = bounds('prop.din-rail');
    expect(rail.min.x).toBeCloseTo(0, 6);
    expect(rail.max.x).toBeCloseTo(0.5, 6);
    expect(rail.max.z).toBeCloseTo(DIN_RAIL_TS35.heightMm.valueMm / 1000, 6);
    // Bench: min corner on the floor, top at its height.
    const bench = bounds('prop.bench');
    expect([bench.min.x, bench.min.y, bench.min.z]).toEqual([0, 0, 0].map((n) => expect.closeTo(n, 6)));
    expect([bench.max.x, bench.max.y, bench.max.z]).toEqual([1.8, 0.9, 0.75].map((n) => expect.closeTo(n, 6)));
    // Floor: the walking surface at y = 0.
    const floor = bounds('prop.workshop-floor');
    expect(floor.max.y).toBeCloseTo(0, 6);
    expect(floor.max.x).toBeCloseTo(5, 6);
  });

  it('draws the stud wall on the same 16 in layout that wall-stud snapping uses', () => {
    const [framing, proxy] = parts('prop.stud-wall');
    expect(framing.name).toBe('framing');
    expect(box(framing.geometry).min.z).toBeCloseTo(-WALL_STUD_DEPTH.valueMm / 1000, 6);
    // The snap proxy spans the whole wall face so the ray finds the wall between studs, but is never drawn.
    expect(proxy.name).toBe('snap-plane');
    expect(proxy.material.visible).toBe(false);
    expect(size(proxy.geometry).x).toBeCloseTo(4.915, 6);
    const wall = FIXTURE_SPECS.find((s) => s.kind === 'stud-wall');
    if (wall?.kind !== 'stud-wall') throw new Error('no stud wall spec');
    const { widthMm, heightMm, firstStudCentreMm } = wall;
    const frame = { origin: { x: 0, y: 0, z: 0 }, normal: '+z' as const };
    const centres = studCentres({ kind: 'wall-studs', id: 'wall', frame, widthMm, heightMm, firstStudCentreMm });
    expect(centres).toHaveLength(13);
    expect(centres.at(-1)).toBe(4896);
    // One merged mesh: 13 studs and 2 plates of 24 vertices each (BoxGeometry).
    expect(framing.geometry.getAttribute('position').count).toBe(15 * 24);
    expect(new Mesh(framing.geometry, framing.material).geometry).toBe(framing.geometry);
  });

  it('shares recipes by ref and disposes on the last release', () => {
    const local = new FixtureRecipes();
    const a = local.acquire({ id: 'prop.din-rail', version: 1 });
    const b = local.acquire({ id: 'prop.din-rail', version: 1 });
    expect(a).toBe(b);
    const spy = vi.spyOn(a.parts[0].geometry, 'dispose');
    local.release({ id: 'prop.din-rail', version: 1 });
    expect(spy).not.toHaveBeenCalled();
    local.release({ id: 'prop.din-rail', version: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(local.size).toBe(0);
    local.release({ id: 'prop.din-rail', version: 1 }); // releasing an unknown ref is a no-op
  });
});
