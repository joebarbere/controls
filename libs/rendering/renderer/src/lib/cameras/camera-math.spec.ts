import fc from 'fast-check';
import {
  applyLook,
  clampToRoom,
  DEFAULT_WALK_CONFIG,
  fitDistance,
  lookDirection,
  MAX_PITCH,
  stepWalk,
  workOrbitFor,
  WORK_LIMITS,
  yawPitchFromDirection,
  type RoomBoundsMm,
  type Vec3,
  type WalkPose,
} from './camera-math';

const room: RoomBoundsMm = { minXMm: -2000, maxXMm: 2000, minZMm: 0, maxZMm: 3000, floorYMm: -1200 };
const pose = (over: Partial<WalkPose> = {}): WalkPose => ({ x: 0, y: 0, z: 1.5, yaw: 0, pitch: 0, ...over });
const still = { forward: 0, strafe: 0, sprint: false };

describe('walk mode', () => {
  it('walks forward along −z at walk speed, at eye height', () => {
    const p = pose();
    stepWalk(p, { forward: 1, strafe: 0, sprint: false }, 0.1, room, DEFAULT_WALK_CONFIG);
    expect(p.z).toBeCloseTo(1.5 - 0.14, 9);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(0.4, 9); // floor −1.2 m + 1.6 m eye height
  });

  it('strafes right along +x when yaw is 0 and sprint doubles speed', () => {
    const p = pose();
    stepWalk(p, { forward: 0, strafe: 1, sprint: true }, 0.05, room, DEFAULT_WALK_CONFIG);
    expect(p.x).toBeCloseTo(0.14, 9);
  });

  it('normalises diagonal movement', () => {
    const p = pose();
    stepWalk(p, { forward: 1, strafe: 1, sprint: false }, 0.1, room, DEFAULT_WALK_CONFIG);
    expect(Math.hypot(p.x, p.z - 1.5)).toBeCloseTo(0.14, 9);
  });

  it('caps the step so a stalled frame cannot tunnel through a wall', () => {
    const p = pose();
    stepWalk(p, { forward: 1, strafe: 0, sprint: false }, 30, room, DEFAULT_WALK_CONFIG);
    expect(p.z).toBeCloseTo(1.5 - 0.14, 9);
    const q = pose();
    stepWalk(q, { forward: 1, strafe: 0, sprint: false }, Number.NaN, room, DEFAULT_WALK_CONFIG);
    expect(q.z).toBe(1.5);
  });

  it('never leaves the room, whatever the input', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            forward: fc.integer({ min: -1, max: 1 }),
            strafe: fc.integer({ min: -1, max: 1 }),
            sprint: fc.boolean(),
            yaw: fc.double({ min: -10, max: 10, noNaN: true }),
            dt: fc.double({ min: 0, max: 1, noNaN: true }),
          }),
          { maxLength: 200 },
        ),
        (steps) => {
          const p = pose();
          for (const s of steps) {
            p.yaw = s.yaw;
            stepWalk(p, s, s.dt, room, DEFAULT_WALK_CONFIG);
            expect(p.x).toBeGreaterThanOrEqual(-1.75 - 1e-12);
            expect(p.x).toBeLessThanOrEqual(1.75 + 1e-12);
            expect(p.z).toBeGreaterThanOrEqual(0.25 - 1e-12);
            expect(p.z).toBeLessThanOrEqual(2.75 + 1e-12);
          }
        },
      ),
    );
  });

  it('pins the eye to the centre line of a room narrower than the body', () => {
    const p = pose({ x: 5 });
    clampToRoom(p, { ...room, minXMm: 0, maxXMm: 100 }, DEFAULT_WALK_CONFIG);
    expect(p.x).toBeCloseTo(0.05, 9);
    stepWalk(p, still, 0.016, { ...room, minZMm: 0, maxZMm: 100 }, DEFAULT_WALK_CONFIG);
    expect(p.z).toBeCloseTo(0.05, 9);
  });

  it('mouse look clamps pitch, wraps yaw and honours invert-Y', () => {
    const p = pose();
    applyLook(p, 0, -1e6, DEFAULT_WALK_CONFIG);
    expect(p.pitch).toBe(MAX_PITCH);
    applyLook(p, 0, 1e6, { ...DEFAULT_WALK_CONFIG, invertY: true });
    expect(p.pitch).toBe(MAX_PITCH);
    applyLook(p, 0, 1e6, DEFAULT_WALK_CONFIG);
    expect(p.pitch).toBe(-MAX_PITCH);
    const k = DEFAULT_WALK_CONFIG.lookRadiansPerPixel;
    const q = pose({ yaw: Math.PI - 0.001 });
    applyLook(q, -1 / k, 0, DEFAULT_WALK_CONFIG); // turn left by 1 rad
    expect(q.yaw).toBeCloseTo(Math.PI - 0.001 + 1 - 2 * Math.PI, 9);
    applyLook(q, 3 / k, 0, DEFAULT_WALK_CONFIG); // turn right by 3 rad
    expect(q.yaw).toBeGreaterThan(-Math.PI);
    expect(q.yaw).toBeLessThanOrEqual(Math.PI);
  });

  it('lookDirection and yawPitchFromDirection are inverses', () => {
    const out: Vec3 = { x: 0, y: 0, z: 0 };
    expect(lookDirection(0, 0, out)).toEqual({ x: -0, y: 0, z: -1 });
    fc.assert(
      fc.property(
        fc.double({ min: -Math.PI + 1e-6, max: Math.PI, noNaN: true }),
        fc.double({ min: -1.5, max: 1.5, noNaN: true }),
        (yaw, pitch) => {
          const back = yawPitchFromDirection(lookDirection(yaw, pitch, out));
          expect(back.yaw).toBeCloseTo(yaw, 6);
          expect(back.pitch).toBeCloseTo(pitch, 6);
        },
      ),
    );
    expect(yawPitchFromDirection({ x: 0, y: 0, z: 0 })).toEqual({ yaw: 0, pitch: 0 });
  });
});

describe('work mode', () => {
  it('fits a sphere in the narrower field of view', () => {
    expect(fitDistance(1, 90, 1)).toBeCloseTo(Math.SQRT2, 9);
    // Portrait viewport: horizontal FOV is narrower, so the camera backs off.
    expect(fitDistance(1, 90, 0.5)).toBeGreaterThan(fitDistance(1, 90, 1));
  });

  it('places the camera on the target normal with orbit and pan limits', () => {
    const orbit = workOrbitFor({ id: 'plate', center: { x: 0, y: 0, z: 0 }, radius: 0.5, normal: '+z' }, 45, 16 / 9);
    expect(orbit.target).toEqual({ x: 0, y: 0, z: 0 });
    expect(orbit.position.x).toBe(0);
    expect(orbit.position.z).toBeGreaterThan(0.5);
    expect(orbit.minAzimuthAngle).toBeCloseTo(-WORK_LIMITS.azimuthHalfRangeRad, 9);
    expect(orbit.maxPolarAngle).toBeLessThan(Math.PI);
    expect(orbit.minPolarAngle).toBeGreaterThan(0);
    expect(orbit.maxTargetRadius).toBe(0.5);
    expect(orbit.maxDistance).toBeCloseTo(orbit.position.z * WORK_LIMITS.maxDistanceFactor, 9);
  });

  it('centres azimuth limits on each normal', () => {
    const at = (normal: '+x' | '-x' | '-z') =>
      workOrbitFor({ id: 'w', center: { x: 1, y: 1, z: 1 }, radius: 0.01, normal }, 45, 1);
    expect(at('+x').position.x).toBeGreaterThan(1);
    expect(at('-x').position.x).toBeLessThan(1);
    expect(at('-z').position.z).toBeLessThan(1);
    const neg = at('-z');
    expect((neg.minAzimuthAngle + neg.maxAzimuthAngle) / 2).toBeCloseTo(Math.PI, 9);
    // A tiny target still allows the minimum distance to equal the framing distance.
    expect(neg.minDistance).toBeLessThanOrEqual(WORK_LIMITS.minDistanceM);
  });
});
