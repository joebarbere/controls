import fc from 'fast-check';
import { BUILTIN_PROPS, builtinProp, propFootprint } from '../props';
import { BACKPLATE_MARGIN, SNAP_PLANE_TOLERANCE } from './constants';
import { DEMO_PANEL, demoBackplateTarget, demoPanelSnapTargets } from './demo-panel';
import { normalForOrientation, orientationForNormal, placeOnTargets } from './placement';
import { isOnTarget, snapToBest } from './resolve';
import type { DinRailTarget, SnapTarget, WallStudsTarget } from './snap';

const targets = demoPanelSnapTargets();
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

describe('demo panel', () => {
  it('has a sourced layout and the backplate margin from the constants', () => {
    expect(DEMO_PANEL.source).toMatch(/game-design/);
    expect(BACKPLATE_MARGIN.source).toMatch(/game-design/);
    expect(SNAP_PLANE_TOLERANCE.source).toMatch(/game-design/);
    expect(demoBackplateTarget()).toMatchObject({ marginMm: 20, frame: { origin: { x: -300, y: -400, z: 0 } } });
    expect(targets.map((t) => `${t.kind}:${t.id}`)).toEqual([
      'backplate-grid:backplate',
      'din-rail:din-rail-1',
      'din-rail:din-rail-2',
    ]);
  });
});

describe('isOnTarget', () => {
  const [plate, rail1] = targets;

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
      world: { x: -70, y: 110, z: 0 },
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
    const extra: DinRailTarget = { kind: 'din-rail', id: 'din-rail-0', frame: targets[1].frame, lengthMm: 500 };
    fc.assert(
      fc.property(
        fc.shuffledSubarray([...targets, extra], { minLength: 4, maxLength: 4 }),
        fc.integer({ min: -300, max: 300 }),
        fc.integer({ min: -400, max: 400 }),
        (shuffled: SnapTarget[], x, y) => {
          const cursor = { x, y, z: 0 };
          expect(snapToBest(shuffled, footprint, cursor)).toEqual(snapToBest([extra, ...targets], footprint, cursor));
        },
      ),
    );
    expect(snapToBest([...targets, extra], footprint, { x: 0, y: 150, z: 0 })).toMatchObject({
      targetId: 'din-rail-0',
    });
  });
});

describe('orientation of mounted props', () => {
  it('maps the four surface normals to yaw quarter-turns and back', () => {
    for (const normal of ['+z', '+x', '-z', '-x'] as const) {
      expect(normalForOrientation(orientationForNormal(normal))).toBe(normal);
    }
    expect(orientationForNormal('+x')).toEqual({ yaw: 90_000, pitch: 0, roll: 0 });
    expect(normalForOrientation({ yaw: 45_000, pitch: 0, roll: 0 })).toBeNull();
    expect(normalForOrientation({ yaw: 0, pitch: 1, roll: 0 })).toBeNull();
    expect(normalForOrientation({ yaw: 0, pitch: 0, roll: 1 })).toBeNull();
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
    ).toMatchObject({ ok: true, targetId: 'din-rail-1', positionMm: { x: -70, y: 110, z: 0 } });
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
