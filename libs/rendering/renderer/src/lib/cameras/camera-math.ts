/**
 * Pure camera maths for walk and work modes (scene units: metres; angles: radians). No Three.js,
 * DOM or clock, so it is unit-tested without a GPU. Functions that run every frame write into
 * caller-owned objects instead of allocating.
 *
 * Camera pose is view state, not world state: it never enters the replay log.
 */
import { mm } from '@controls/units';
import type { SurfaceNormal } from '@controls/world-model';

export type ViewMode = 'walk' | 'work';

/** Walkable floor area of a room, integer mm in world space. */
export interface RoomBoundsMm {
  readonly minXMm: number;
  readonly maxXMm: number;
  readonly minZMm: number;
  readonly maxZMm: number;
  /** World y of the floor. */
  readonly floorYMm: number;
}

/** All game-design values (no real-world source applies): tuned for comfort, not measured. */
export interface WalkConfig {
  /** Eye height above the floor. */
  readonly eyeHeightMm: number;
  /** Keeps the eye this far from the walls. */
  readonly bodyRadiusMm: number;
  readonly walkSpeedMps: number;
  readonly sprintMultiplier: number;
  /** Radians of yaw/pitch per pixel of pointer movement. */
  readonly lookRadiansPerPixel: number;
  readonly invertY: boolean;
}

export const DEFAULT_WALK_CONFIG: WalkConfig = {
  eyeHeightMm: 1600, // game-design: a typical adult standing eye height, rounded
  bodyRadiusMm: 250, // game-design
  walkSpeedMps: 1.4, // game-design: brisk indoor walk
  sprintMultiplier: 2, // game-design
  lookRadiansPerPixel: 0.0022, // game-design; F1.1 settings expose look sensitivity
  invertY: false,
};

/** Upper bound on one movement step, so a stalled tab doesn't teleport the player through a wall. */
export const MAX_STEP_SECONDS = 0.1;
/** Pitch limit just short of straight up/down (avoids gimbal flip). */
export const MAX_PITCH = (89 * Math.PI) / 180;

/** Mutable walk pose. `yaw` 0 looks along −z (Three.js camera default); positive yaw turns left. */
export interface WalkPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/** Applies a pointer delta (pixels) to yaw and pitch, clamping pitch. */
export function applyLook(pose: WalkPose, dxPx: number, dyPx: number, config: WalkConfig): void {
  const k = config.lookRadiansPerPixel;
  pose.yaw -= dxPx * k;
  pose.pitch = clamp(pose.pitch - dyPx * k * (config.invertY ? -1 : 1), -MAX_PITCH, MAX_PITCH);
  // Keep yaw in (−π, π] so it can't grow without bound over a long session.
  if (pose.yaw > Math.PI) pose.yaw -= 2 * Math.PI;
  else if (pose.yaw <= -Math.PI) pose.yaw += 2 * Math.PI;
}

/** Keeps the eye inside the room (minus body radius) and at eye height. */
export function clampToRoom(pose: WalkPose, room: RoomBoundsMm, config: WalkConfig): void {
  const r = config.bodyRadiusMm;
  const loX = mm(room.minXMm + r);
  const hiX = mm(room.maxXMm - r);
  const loZ = mm(room.minZMm + r);
  const hiZ = mm(room.maxZMm - r);
  // A room narrower than the body pins the eye to its centre line.
  pose.x = loX <= hiX ? clamp(pose.x, loX, hiX) : (loX + hiX) / 2;
  pose.z = loZ <= hiZ ? clamp(pose.z, loZ, hiZ) : (loZ + hiZ) / 2;
  pose.y = mm(room.floorYMm + config.eyeHeightMm);
}

/**
 * Advances the walk pose by one frame. Movement is horizontal (yaw only), diagonal input is
 * normalised, and `dtSeconds` is capped at {@link MAX_STEP_SECONDS}.
 */
export function stepWalk(
  pose: WalkPose,
  intent: { readonly forward: number; readonly strafe: number; readonly sprint: boolean },
  dtSeconds: number,
  room: RoomBoundsMm,
  config: WalkConfig,
): void {
  const dt = clamp(Number.isFinite(dtSeconds) ? dtSeconds : 0, 0, MAX_STEP_SECONDS);
  const len = Math.hypot(intent.forward, intent.strafe);
  if (len > 0 && dt > 0) {
    const speed = config.walkSpeedMps * (intent.sprint ? config.sprintMultiplier : 1) * dt;
    const f = (intent.forward / len) * speed;
    const s = (intent.strafe / len) * speed;
    const sin = Math.sin(pose.yaw);
    const cos = Math.cos(pose.yaw);
    // forward = (−sin, 0, −cos), right = (cos, 0, −sin)
    pose.x += -sin * f + cos * s;
    pose.z += -cos * f - sin * s;
  }
  clampToRoom(pose, room, config);
}

/** Unit view direction for a yaw/pitch, written into `out`. */
export function lookDirection(yaw: number, pitch: number, out: Vec3): Vec3 {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

/** Inverse of {@link lookDirection}: yaw and pitch for a (not necessarily unit) direction. */
export function yawPitchFromDirection(d: Vec3): { yaw: number; pitch: number } {
  const len = Math.hypot(d.x, d.y, d.z);
  if (len === 0) return { yaw: 0, pitch: 0 };
  return { yaw: Math.atan2(-d.x, -d.z), pitch: clamp(Math.asin(clamp(d.y / len, -1, 1)), -MAX_PITCH, MAX_PITCH) };
}

/** What work mode orbits around: a world-space bounding sphere and the way its face points. */
export interface FocusTarget {
  readonly id: string;
  readonly center: Vec3;
  readonly radius: number;
  readonly normal: SurfaceNormal;
}

/** Orbit set-up for work mode, in the shape OrbitControls wants. */
export interface WorkOrbit {
  readonly target: Vec3;
  readonly position: Vec3;
  readonly minDistance: number;
  readonly maxDistance: number;
  readonly minPolarAngle: number;
  readonly maxPolarAngle: number;
  readonly minAzimuthAngle: number;
  readonly maxAzimuthAngle: number;
  /** Pan limit: the orbit target may move at most this far from the focus centre. */
  readonly maxTargetRadius: number;
}

/** Work-mode limits (game-design). */
export const WORK_LIMITS = {
  minDistanceM: 0.15, // close enough to read a terminal marker
  maxDistanceFactor: 3, // × the framing distance
  azimuthHalfRangeRad: (75 * Math.PI) / 180, // can't swing round behind the surface
  polarHalfRangeRad: (60 * Math.PI) / 180, // ±60° from level
  framingMargin: 1.15, // breathing room around the target
} as const;

/** OrbitControls azimuth (θ = atan2(x, z)) of a camera sitting on each normal. */
const NORMAL_AZIMUTH: Readonly<Record<SurfaceNormal, number>> = {
  '+z': 0,
  '+x': Math.PI / 2,
  '-z': Math.PI,
  '-x': -Math.PI / 2,
};

const NORMAL_VEC: Readonly<Record<SurfaceNormal, Vec3>> = {
  '+z': { x: 0, y: 0, z: 1 },
  '-z': { x: 0, y: 0, z: -1 },
  '+x': { x: 1, y: 0, z: 0 },
  '-x': { x: -1, y: 0, z: 0 },
};

/** Distance at which a sphere of `radius` fits the narrower of the vertical and horizontal FOV. */
export function fitDistance(radius: number, verticalFovDeg: number, aspect: number): number {
  const v = (verticalFovDeg * Math.PI) / 180;
  const h = 2 * Math.atan(Math.tan(v / 2) * Math.max(aspect, 1e-6));
  return radius / Math.sin(Math.min(v, h) / 2);
}

/** Camera pose and orbit/pan limits for focusing `focus` in work mode. */
export function workOrbitFor(focus: FocusTarget, verticalFovDeg: number, aspect: number): WorkOrbit {
  const d = fitDistance(focus.radius, verticalFovDeg, aspect) * WORK_LIMITS.framingMargin;
  const n = NORMAL_VEC[focus.normal];
  const az = NORMAL_AZIMUTH[focus.normal];
  return {
    target: { ...focus.center },
    position: { x: focus.center.x + n.x * d, y: focus.center.y, z: focus.center.z + n.z * d },
    minDistance: Math.min(WORK_LIMITS.minDistanceM, d),
    maxDistance: d * WORK_LIMITS.maxDistanceFactor,
    minPolarAngle: Math.PI / 2 - WORK_LIMITS.polarHalfRangeRad,
    maxPolarAngle: Math.PI / 2 + WORK_LIMITS.polarHalfRangeRad,
    minAzimuthAngle: az - WORK_LIMITS.azimuthHalfRangeRad,
    maxAzimuthAngle: az + WORK_LIMITS.azimuthHalfRangeRad,
    maxTargetRadius: focus.radius,
  };
}
