import fc from 'fast-check';
import { isIntegerMm } from '@controls/units';
import * as constants from './constants';
import {
  SNAP_STEPS,
  snap,
  snapToBackplateGrid,
  snapToDinRail,
  snapToWallStuds,
  studCentres,
  type BackplateGridTarget,
  type DinRailTarget,
  type Footprint,
  type SnapResult,
  type WallStudsTarget,
} from './snap';
import { frameNormal, surfaceToWorld, worldToSurface, type SurfaceFrame, type SurfaceNormal } from './surface';

const front: SurfaceFrame = { origin: { x: 0, y: 0, z: 0 }, normal: '+z' };
const rail: DinRailTarget = { kind: 'din-rail', id: 'rail', frame: front, lengthMm: 500 };
const plate: BackplateGridTarget = {
  kind: 'backplate-grid',
  id: 'plate',
  frame: front,
  widthMm: 600,
  heightMm: 800,
  marginMm: 20,
};
const wall: WallStudsTarget = {
  kind: 'wall-studs',
  id: 'wall',
  frame: front,
  widthMm: 2438,
  heightMm: 2438,
  firstStudCentreMm: 19,
};
const mcb: Footprint = { widthMm: 18, heightMm: 90 };

const anchor = (r: SnapResult) => {
  if (!r.ok) throw new Error(`expected a snap, got ${r.reason}`);
  return r.anchor;
};

describe('snap constants', () => {
  it('every constant carries a source, and game-design values say so', () => {
    const all = [
      ...Object.values(constants.DIN_RAIL_TS35),
      constants.DIN_MODULE_PITCH,
      constants.WALL_STUD_SPACING,
      constants.WALL_STUD_THICKNESS,
      constants.BACKPLATE_GRID_PITCH,
      constants.WALL_VERTICAL_PITCH,
      constants.DIN_RAIL_CAPTURE,
      constants.BACKPLATE_MARGIN,
      constants.SNAP_PLANE_TOLERANCE,
    ];
    for (const c of all) {
      expect(c.source.length).toBeGreaterThan(10);
      if (c.kind === 'game-design') expect(c.source).toMatch(/game-design/);
    }
  });

  it('derives integer steps', () => {
    expect(SNAP_STEPS).toEqual({
      dinModuleMm: 18,
      dinCaptureMm: 40,
      backplateGridMm: 5,
      wallVerticalMm: 10,
      planeToleranceMm: 10,
      studHalfThicknessMm: 20,
    });
  });
});

describe('surface frames', () => {
  const normals: SurfaceNormal[] = ['+x', '-x', '+z', '-z'];

  it('u is to the right of a viewer facing the surface (right = up × normal)', () => {
    for (const normal of normals) {
      const frame: SurfaceFrame = { origin: { x: 0, y: 0, z: 0 }, normal };
      const r = surfaceToWorld(frame, { u: 1, v: 0 });
      const n = frameNormal(frame);
      // up × n = (n.z, 0, -n.x)
      expect({ x: r.x, z: r.z }).toEqual({ x: n.z === 0 ? 0 : n.z, z: n.x === 0 ? 0 : -n.x });
    }
  });

  it('world ↔ surface round-trips in integer mm', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...normals),
        fc.record({
          x: fc.integer({ min: -1e6, max: 1e6 }),
          y: fc.integer({ min: -1e6, max: 1e6 }),
          z: fc.integer({ min: -1e6, max: 1e6 }),
        }),
        fc.record({
          x: fc.integer({ min: -1e6, max: 1e6 }),
          y: fc.integer({ min: -1e6, max: 1e6 }),
          z: fc.integer({ min: -1e6, max: 1e6 }),
        }),
        (normal, origin, p) => {
          const frame: SurfaceFrame = { origin, normal };
          const local = worldToSurface(frame, p);
          const back = surfaceToWorld(frame, local, local.w);
          expect(back).toEqual({ x: p.x || 0, y: p.y || 0, z: p.z || 0 });
          [local.u, local.v, local.w].forEach((n) => expect(isIntegerMm(n)).toBe(true));
        },
      ),
    );
  });
});

describe('snapToDinRail', () => {
  it('puts the left edge on a whole module and centres the device on the rail', () => {
    expect(anchor(snapToDinRail(rail, mcb, { u: 100, v: 12 }))).toEqual({ u: 90, v: -45 });
    expect(anchor(snapToDinRail(rail, mcb, { u: 9, v: 0 }))).toEqual({ u: 0, v: -45 });
  });

  it('keeps the device on the rail at both ends', () => {
    expect(anchor(snapToDinRail(rail, mcb, { u: -400, v: 0 }))).toEqual({ u: 0, v: -45 });
    // 500 mm rail, 18 mm device: last whole module that fits starts at 26 × 18 = 468 (486 + 18 > 500).
    expect(anchor(snapToDinRail(rail, mcb, { u: 9000, v: 0 }))).toEqual({ u: 468, v: -45 });
  });

  it('refuses a cursor outside the capture band and a device longer than the rail', () => {
    expect(snapToDinRail(rail, mcb, { u: 100, v: 41 })).toMatchObject({ ok: false, reason: 'out-of-capture' });
    expect(snapToDinRail(rail, { widthMm: 501, heightMm: 90 }, { u: 0, v: 0 })).toMatchObject({
      ok: false,
      reason: 'too-large',
    });
  });

  it('always lands on the module grid and inside the rail', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: -2000, max: 2000 }),
        fc.integer({ min: -40, max: 40 }),
        (modules, u, v) => {
          const r = snapToDinRail(rail, { widthMm: modules * 18, heightMm: 90 }, { u, v });
          if (!r.ok) return;
          expect(r.anchor.u % 18).toBe(0);
          expect(r.anchor.u).toBeGreaterThanOrEqual(0);
          expect(r.anchor.u + modules * 18).toBeLessThanOrEqual(rail.lengthMm);
        },
      ),
    );
  });

  it('rejects non-integer footprints', () => {
    expect(() => snapToDinRail(rail, { widthMm: 17.5, heightMm: 90 }, { u: 0, v: 0 })).toThrow(RangeError);
    expect(() => snapToDinRail(rail, { widthMm: 0, heightMm: 90 }, { u: 0, v: 0 })).toThrow(RangeError);
  });
});

describe('snapToBackplateGrid', () => {
  const box: Footprint = { widthMm: 101, heightMm: 63 };

  it('snaps the corner to the 5 mm grid, offset by the margin', () => {
    expect(anchor(snapToBackplateGrid(plate, box, { u: 300, v: 400 }))).toEqual({ u: 250, v: 370 });
  });

  it('clamps inside the plate minus margin', () => {
    expect(anchor(snapToBackplateGrid(plate, box, { u: -999, v: 9999 }))).toEqual({ u: 20, v: 715 });
    expect(anchor(snapToBackplateGrid({ ...plate, marginMm: undefined }, box, { u: -999, v: -999 }))).toEqual({
      u: 0,
      v: 0,
    });
  });

  it('refuses a footprint larger than the usable plate', () => {
    expect(snapToBackplateGrid(plate, { widthMm: 561, heightMm: 10 }, { u: 0, v: 0 })).toMatchObject({
      ok: false,
      reason: 'too-large',
    });
  });

  it('is on-grid and inside for any cursor', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 560 }),
        fc.integer({ min: 1, max: 760 }),
        fc.integer({ min: -5000, max: 5000 }),
        fc.integer({ min: -5000, max: 5000 }),
        (w, h, u, v) => {
          const a = anchor(snapToBackplateGrid(plate, { widthMm: w, heightMm: h }, { u, v }));
          expect((a.u - 20) % 5).toBe(0);
          expect((a.v - 20) % 5).toBe(0);
          expect(a.u).toBeGreaterThanOrEqual(20);
          expect(a.u + w).toBeLessThanOrEqual(580);
          expect(a.v + h).toBeLessThanOrEqual(780);
        },
      ),
    );
  });
});

describe('studCentres', () => {
  it('uses exact 16 in spacing without accumulating rounding error', () => {
    const c = studCentres({ ...wall, widthMm: 4900, firstStudCentreMm: 0 });
    expect(c.slice(0, 4)).toEqual([0, 406, 813, 1219]);
    // 12 × 406.4 = 4876.8 → 4877 (adding a rounded 406 step would give 4872).
    expect(c[12]).toBe(4877);
  });

  it('skips nothing and stops at the wall edge', () => {
    expect(studCentres(wall)).toEqual([19, 425, 832, 1238, 1645, 2051]);
    expect(studCentres({ ...wall, firstStudCentreMm: 3000 })).toEqual([]);
  });
});

describe('snapToWallStuds', () => {
  const box: Footprint = { widthMm: 60, heightMm: 100 };

  it('mounts against the side of the nearest stud that the cursor is on', () => {
    // Stud at 425; right face at 445. Cursor right of the stud.
    expect(anchor(snapToWallStuds(wall, box, { u: 460, v: 1200 }))).toEqual({ u: 445, v: 1150 });
    // Cursor left of the stud: box right edge at 405.
    expect(anchor(snapToWallStuds(wall, box, { u: 410, v: 1200 }))).toEqual({ u: 345, v: 1150 });
  });

  it('falls back to the other side at the wall edge', () => {
    // First stud at 19: no room to its left (box would start at -61).
    expect(anchor(snapToWallStuds(wall, box, { u: 0, v: 0 }))).toEqual({ u: 39, v: 0 });
  });

  it('refuses a box wider than a stud bay and an empty wall', () => {
    expect(snapToWallStuds(wall, { widthMm: 400, heightMm: 10 }, { u: 600, v: 0 })).toMatchObject({
      ok: false,
      reason: 'too-large',
    });
    expect(snapToWallStuds({ ...wall, firstStudCentreMm: 9000 }, box, { u: 0, v: 0 })).toMatchObject({
      ok: false,
      reason: 'out-of-bounds',
    });
    expect(snapToWallStuds({ ...wall, heightMm: 50 }, box, { u: 460, v: 0 })).toMatchObject({
      ok: false,
      reason: 'too-large',
    });
  });

  it('reports out-of-bounds when the only bay that fits runs off the wall', () => {
    // One stud at 19 on a 70 mm wall: right bay is 39…70 (31 mm), too small; left bay is off the wall.
    const narrow: WallStudsTarget = { ...wall, widthMm: 120, firstStudCentreMm: 19 };
    expect(snapToWallStuds(narrow, { widthMm: 90, heightMm: 10 }, { u: 10, v: 0 })).toMatchObject({
      ok: false,
      reason: 'too-large',
    });
    expect(
      snapToWallStuds({ ...wall, widthMm: 100, firstStudCentreMm: 90 }, { widthMm: 60, heightMm: 10 }, { u: 95, v: 0 }),
    ).toMatchObject({
      ok: true,
      anchor: { u: 10, v: 0 },
    });
  });

  it('never overlaps a stud and stays inside the wall', () => {
    const studs = studCentres(wall);
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 360 }),
        fc.integer({ min: -500, max: 3000 }),
        fc.integer({ min: -500, max: 3000 }),
        (w, u, v) => {
          const r = snapToWallStuds(wall, { widthMm: w, heightMm: 100 }, { u, v });
          if (!r.ok) return;
          const { u: a } = r.anchor;
          expect(a).toBeGreaterThanOrEqual(0);
          expect(a + w).toBeLessThanOrEqual(wall.widthMm);
          for (const s of studs) expect(a + w <= s - 19 || a >= s + 19).toBe(true);
          expect(r.anchor.v % 10).toBe(0);
        },
      ),
    );
  });
});

describe('snap (world-space dispatch)', () => {
  it('converts the cursor into the target frame and the anchor back to world', () => {
    const sideRail: DinRailTarget = { ...rail, frame: { origin: { x: 100, y: 1000, z: 50 }, normal: '+x' } };
    // u runs along -z for a +x normal: world z = 50 - 100 is u = 100.
    const r = snap(sideRail, mcb, { x: 100, y: 1005, z: -50 });
    expect(r).toEqual({
      ok: true,
      targetId: 'rail',
      kind: 'din-rail',
      anchor: { u: 90, v: -45 },
      world: { x: 100, y: 955, z: -40 },
      normal: '+x',
    });
    expect(snap(plate, { widthMm: 10, heightMm: 10 }, { x: 0, y: 0, z: 0 })).toMatchObject({ ok: true });
    expect(snap(wall, { widthMm: 10, heightMm: 10 }, { x: 0, y: 0, z: 0 })).toMatchObject({ ok: true });
  });

  it('rejects non-integer cursors (convert with metresToMm first)', () => {
    expect(() => snap(rail, mcb, { x: 0.5, y: 0, z: 0 })).toThrow(RangeError);
  });

  it('is deterministic: the same inputs give identical results', () => {
    fc.assert(
      fc.property(fc.integer({ min: -3000, max: 3000 }), fc.integer({ min: -3000, max: 3000 }), (x, y) => {
        for (const t of [rail, plate, wall]) {
          expect(snap(t, mcb, { x, y, z: 0 })).toEqual(snap(t, mcb, { x, y, z: 0 }));
        }
      }),
    );
  });
});
