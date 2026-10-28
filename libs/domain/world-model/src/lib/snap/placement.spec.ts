import { migrateWorld } from '@controls/save-format';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { worldSnapTargets } from '../fixtures';
import { BUILTIN_PROPS, builtinProp, propFootprint } from '../props';
import { BACKPLATE_MARGIN, SNAP_PLANE_TOLERANCE } from './constants';
import {
  isMountedOrientation,
  normalForOrientation,
  orientationForFrame,
  orientationForNormal,
  placeOnTargets,
} from './placement';
import { isOnTarget, snapToBest } from './resolve';
import type { DinRailTarget, SnapTarget, WallStudsTarget } from './snap';

/** The workshop level (`content/levels/workshop.json`), loaded the way the game loads it. */
function workshop() {
  const json: unknown = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../../../../../content/levels/workshop.json'), 'utf8'),
  );
  const loaded = migrateWorld(json);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
}

const targets = worldSnapTargets(workshop());
const byId = (id: string): SnapTarget => {
  const t = targets.find((x) => x.id === id);
  if (!t) throw new Error(`no target ${id}`);
  return t;
};
const panel = [byId('backplate'), byId('din-rail-1'), byId('din-rail-2')];
const box = { id: 'prop.box', version: 1 };
const crate = { id: 'prop.crate', version: 1 };
const footprint = { widthMm: 120, heightMm: 80 };

describe('built-in props', () => {
  it('resolves prop.* refs at version 1 only', () => {
    expect(builtinProp(box)?.title).toBe('Box');
    expect(builtinProp({ id: 'prop.box', version: 2 })).toBeUndefined();
    expect(builtinProp({ id: 'prop.nope', version: 1 })).toBeUndefined();
    expect(propFootprint(crate)).toEqual({ widthMm: 300, heightMm: 200 });
    expect(propFootprint({ id: 'prop.nope', version: 1 })).toBeUndefined();
  });

  it('is sorted by id, integer-sized and sourced as game-design', () => {
    const ids = BUILTIN_PROPS.map((p) => p.id);
    expect(ids).toEqual([...ids].sort());
    for (const p of BUILTIN_PROPS) {
      expect(p.source).toMatch(/^game-design: /);
      for (const n of Object.values(p.sizeMm)) expect(Number.isInteger(n) && n > 0).toBe(true);
    }
  });
});

describe('workshop snap targets', () => {
  it('come from the level fixtures, named by fixture id, with the backplate margin from the constants', () => {
    expect(BACKPLATE_MARGIN.source).toMatch(/game-design/);
    expect(SNAP_PLANE_TOLERANCE.source).toMatch(/game-design/);
    expect(byId('backplate')).toMatchObject({ marginMm: 20, frame: { origin: { x: -300, y: -400, z: 0 } } });
    expect(targets.map((t) => `${t.kind}:${t.id}`)).toEqual([
      'backplate-grid:backplate',
      'bench-top:bench',
      'din-rail:din-rail-1',
      'din-rail:din-rail-2',
      'wall-studs:stud-wall',
    ]);
  });
});

describe('isOnTarget', () => {
  const [plate, rail1] = [byId('backplate'), byId('din-rail-1')];

  it('needs the point near the plane and inside the extent', () => {
    expect(isOnTarget(plate, { x: 0, y: 0, z: 0 })).toBe(true);
    expect(isOnTarget(plate, { x: 0, y: 0, z: 11 })).toBe(false); // off the plane
    expect(isOnTarget(plate, { x: 301, y: 0, z: 0 })).toBe(false);
    expect(isOnTarget(plate, { x: 0, y: -401, z: 0 })).toBe(false);
    expect(isOnTarget(rail1, { x: 0, y: 150, z: 8 })).toBe(true); // top of the rail
    expect(isOnTarget(rail1, { x: 0, y: 191, z: 0 })).toBe(false); // outside the capture band
    expect(isOnTarget(rail1, { x: 251, y: 150, z: 0 })).toBe(false); // past the rail's end
  });

  it('covers wall-stud targets', () => {
    const wall: WallStudsTarget = {
      kind: 'wall-studs',
      id: 'wall',
      frame: { origin: { x: 0, y: 0, z: 0 }, normal: '+x' },
      widthMm: 2438,
      heightMm: 2438,
      firstStudCentreMm: 19,
    };
    expect(isOnTarget(wall, { x: 0, y: 100, z: -100 })).toBe(true);
    expect(isOnTarget(wall, { x: 0, y: 100, z: 100 })).toBe(false); // u < 0
  });
});

describe('snapToBest', () => {
  it('prefers a DIN rail over the backplate behind it', () => {
    expect(snapToBest(targets, footprint, { x: -10, y: 150, z: 0 })).toMatchObject({
      ok: true,
      targetId: 'din-rail-1',
      world: { x: -75, y: 110, z: 0 },
    });
  });

  it('falls back to the backplate grid away from the rails', () => {
    expect(snapToBest(targets, footprint, { x: -150, y: 300, z: 0 })).toMatchObject({
      ok: true,
      targetId: 'backplate',
      world: { x: -210, y: 260, z: 0 },
    });
  });

  it('falls back to the plate when the rail refuses the footprint, and reports the first failure', () => {
    expect(snapToBest(targets, { widthMm: 520, heightMm: 40 }, { x: 0, y: 150, z: 0 })).toMatchObject({
      ok: true,
      targetId: 'backplate',
    });
    expect(snapToBest(targets, { widthMm: 900, heightMm: 40 }, { x: 0, y: 150, z: 0 })).toMatchObject({
      ok: false,
      targetId: 'din-rail-1',
      reason: 'too-large',
    });
  });

  it('returns null off every target, and rejects non-integer cursors', () => {
    expect(snapToBest(targets, footprint, { x: 2000, y: 0, z: 0 })).toBeNull();
    expect(() => snapToBest(targets, footprint, { x: 0.5, y: 0, z: 0 })).toThrow(RangeError);
  });

  it('ignores the order of the targets (priority, then id)', () => {
    const extra: DinRailTarget = { kind: 'din-rail', id: 'din-rail-0', frame: panel[1].frame, lengthMm: 500 };
    fc.assert(
      fc.property(
        fc.shuffledSubarray([...targets, extra], { minLength: 6, maxLength: 6 }),
        fc.integer({ min: -300, max: 300 }),
        fc.integer({ min: -400, max: 400 }),
        (shuffled: SnapTarget[], x, y) => {
          const cursor = { x, y, z: 0 };
          expect(snapToBest(shuffled, footprint, cursor)).toEqual(snapToBest([extra, ...targets], footprint, cursor));
        },
      ),
    );
    expect(snapToBest([...panel, extra], footprint, { x: 0, y: 150, z: 0 })).toMatchObject({
      targetId: 'din-rail-0',
    });
  });
});

describe('orientation of mounted props', () => {
  it('maps the four surface normals to yaw quarter-turns and back', () => {
    for (const normal of ['+z', '+x', '-z', '-x'] as const) {
      expect(normalForOrientation(orientationForNormal(normal))).toBe(normal);
      expect(orientationForFrame({ origin: { x: 0, y: 0, z: 0 }, normal })).toEqual(orientationForNormal(normal));
    }
    expect(orientationForNormal('+x')).toEqual({ yaw: 90_000, pitch: 0, roll: 0 });
    expect(normalForOrientation({ yaw: 45_000, pitch: 0, roll: 0 })).toBeNull();
    expect(normalForOrientation({ yaw: 0, pitch: 1, roll: 0 })).toBeNull();
    expect(normalForOrientation({ yaw: 0, pitch: 0, roll: 1 })).toBeNull();
  });

  it('stands a prop up on a bench top: pitch -90°, yaw turning +x onto the frame right', () => {
    const up = (right?: '+x' | '-x' | '+z' | '-z') =>
      orientationForFrame({ origin: { x: 0, y: 0, z: 0 }, normal: '+y', right });
    expect(up()).toEqual({ yaw: 0, pitch: 270_000, roll: 0 });
    expect(up('-z')).toEqual({ yaw: 90_000, pitch: 270_000, roll: 0 });
    expect(up('-x')).toEqual({ yaw: 180_000, pitch: 270_000, roll: 0 });
    expect(up('+z')).toEqual({ yaw: 270_000, pitch: 270_000, roll: 0 });
    for (const r of ['+x', '-x', '+z', '-z'] as const) expect(isMountedOrientation(up(r))).toBe(true);
    expect(isMountedOrientation({ yaw: 45_000, pitch: 270_000, roll: 0 })).toBe(false);
    expect(isMountedOrientation({ yaw: 0, pitch: 270_000, roll: 1 })).toBe(false);
    expect(isMountedOrientation({ yaw: 0, pitch: 90_000, roll: 0 })).toBe(false);
  });
});

describe('placeOnTargets', () => {
  it('gives exactly the entity.place arguments', () => {
    expect(placeOnTargets(box, { x: -150, y: 300, z: 0 }, targets)).toEqual({
      ok: true,
      targetId: 'backplate',
      kind: 'backplate-grid',
      positionMm: { x: -210, y: 260, z: 0 },
      orientationMdeg: { yaw: 0, pitch: 0, roll: 0 },
    });
    expect(placeOnTargets(crate, { x: 100, y: -200, z: 0 }, targets)).toMatchObject({
      ok: true,
      positionMm: { x: -50, y: -300, z: 0 },
    });
  });

  it('refuses unknown props, empty space and oversized props', () => {
    expect(placeOnTargets({ id: 'prop.nope', version: 1 }, { x: 0, y: 0, z: 0 }, targets)).toEqual({
      ok: false,
      reason: 'unknown-prop',
      targetId: null,
    });
    expect(placeOnTargets(box, { x: 5000, y: 0, z: 0 }, targets)).toEqual({
      ok: false,
      reason: 'no-target',
      targetId: null,
    });
    expect(placeOnTargets({ id: 'prop.bench', version: 1 }, { x: 0, y: 0, z: 0 }, targets)).toEqual({
      ok: false,
      reason: 'too-large',
      targetId: 'backplate',
    });
  });

  it('keeps a moved entity on surfaces facing the same way', () => {
    const facingX = orientationForNormal('+x');
    expect(placeOnTargets(box, { x: 0, y: 0, z: 0 }, targets, { orientationMdeg: facingX })).toMatchObject({
      ok: false,
      reason: 'no-target',
    });
    expect(
      placeOnTargets(box, { x: 0, y: 0, z: 0 }, targets, { orientationMdeg: { yaw: 1, pitch: 0, roll: 0 } }),
    ).toMatchObject({ ok: false, reason: 'orientation-mismatch' });
    expect(
      placeOnTargets(box, { x: -10, y: 150, z: 0 }, targets, { orientationMdeg: orientationForNormal('+z') }),
    ).toMatchObject({ ok: true, targetId: 'din-rail-1', positionMm: { x: -75, y: 110, z: 0 } });
  });

  it('sets props down on the bench top and the wall studs of the workshop', () => {
    // Bench top: front-left corner at (700, -300, 830); u = +x, v = -z, 10 mm grid inside a 10 mm margin.
    expect(placeOnTargets(crate, { x: 1600, y: -300, z: 455 }, targets)).toEqual({
      ok: true,
      targetId: 'bench',
      kind: 'bench-top',
      positionMm: { x: 1450, y: -300, z: 550 },
      orientationMdeg: { yaw: 0, pitch: 270_000, roll: 0 },
    });
    // Stud wall: stud faces at z = -21, first stud centre 19 mm from x = -2500; studs at x = -2481, -2075, …
    expect(placeOnTargets(box, { x: -2000, y: 0, z: -21 }, targets)).toEqual({
      ok: true,
      targetId: 'stud-wall',
      kind: 'wall-studs',
      positionMm: { x: -2055, y: -40, z: -21 },
      orientationMdeg: { yaw: 0, pitch: 0, roll: 0 },
    });
    // A wall-mounted box can't be moved onto the bench (one move never turns it).
    expect(
      placeOnTargets(box, { x: 1600, y: -300, z: 455 }, targets, { orientationMdeg: orientationForNormal('+z') }),
    ).toMatchObject({ ok: false, reason: 'no-target' });
    expect(
      placeOnTargets(box, { x: 1600, y: -300, z: 455 }, targets, {
        orientationMdeg: { yaw: 0, pitch: 270_000, roll: 0 },
      }),
    ).toMatchObject({ ok: true, targetId: 'bench' });
  });

  it('is deterministic and always integer', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...BUILTIN_PROPS.map((p) => ({ id: p.id, version: 1 }))),
        fc.integer({ min: -400, max: 400 }),
        fc.integer({ min: -500, max: 500 }),
        fc.integer({ min: -12, max: 12 }),
        (ref, x, y, z) => {
          const a = placeOnTargets(ref, { x, y, z }, targets);
          expect(placeOnTargets(ref, { x, y, z }, [...targets].reverse())).toEqual(a);
          if (a.ok) for (const n of Object.values(a.positionMm)) expect(Number.isInteger(n)).toBe(true);
        },
      ),
    );
  });
});
