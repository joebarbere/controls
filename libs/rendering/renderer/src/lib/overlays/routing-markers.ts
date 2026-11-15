/**
 * The routing gesture's markers (F3.2 part 3): the terminal a click would pick, a terminal that is
 * near but too crowded to pick at this zoom, the keyboard-focused terminal, the route's first
 * terminal, its waypoints and where the next waypoint would go. View state only: never selectable,
 * never in the world.
 *
 * One instanced mesh of small spheres, coloured per instance, drawn over everything (`depthTest` off)
 * so a marker on a terminal recessed in its clamp still shows; sized in screen pixels at its depth,
 * so it reads the same at any zoom. The `routing` group is in the scene only while a marker is shown,
 * so every scene-graph snapshot without a routing gesture is unchanged; the mesh owns its geometry
 * (`InstancedPool`) and goes with the last marker.
 */
import {
  Color,
  Group,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Scene,
} from 'three/webgpu';
import type { PerspectiveCamera } from 'three/webgpu';
import { mm } from '@controls/units';
import type { PositionMm } from '@controls/world-model';
import { InstancedPool } from '../instancing/instanced-pool';

/** What a marker shows. */
export type RoutingMarkerKind = 'pick' | 'near' | 'focus' | 'from' | 'waypoint' | 'next';

export interface RoutingMarker {
  readonly kind: RoutingMarkerKind;
  readonly atMm: PositionMm;
}

/** Colour and on-screen radius (CSS px) per kind (game-design). */
export const ROUTING_MARKER_STYLE: Readonly<Record<RoutingMarkerKind, { colour: number; radiusPx: number }>> = {
  pick: { colour: 0xffd400, radiusPx: 6 }, // amber: a click picks this terminal
  near: { colour: 0xff7a1a, radiusPx: 4 }, // orange: near, but crowded at this zoom (offer the zoom)
  focus: { colour: 0x33d6ff, radiusPx: 7 }, // cyan: the keyboard's terminal (Enter picks it)
  from: { colour: 0x2ecc71, radiusPx: 6 }, // green: the route's first terminal
  waypoint: { colour: 0xf4f4f4, radiusPx: 4 },
  next: { colour: 0x9aa4ad, radiusPx: 3 }, // where a click puts the next waypoint
};

/** The smallest drawn marker radius (mm), so a marker never vanishes into a terminal at close range. */
const MIN_RADIUS_MM = 0.6;

const sameMarkers = (a: readonly RoutingMarker[], b: readonly RoutingMarker[]): boolean =>
  a.length === b.length &&
  a.every(
    (m, i) => m.kind === b[i].kind && m.atMm.x === b[i].atMm.x && m.atMm.y === b[i].atMm.y && m.atMm.z === b[i].atMm.z,
  );

export class RoutingMarkers {
  readonly group = new Group();
  private pool: InstancedPool | null = null;
  private readonly material = new MeshBasicMaterial({
    color: 0xffffff,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.9,
  });
  private markers: readonly RoutingMarker[] = [];
  private inScene = false;
  private disposed = false;
  // Scratch.
  private readonly m = new Matrix4();
  private readonly p = new Vector3();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();
  private readonly c = new Color();

  constructor(private readonly scene: Scene) {
    this.group.name = 'routing';
    this.material.name = 'routing:markers';
  }

  /** Markers drawn now (in the order given). */
  get shown(): readonly RoutingMarker[] {
    return this.markers;
  }

  /** GPU resources alive (mesh, its geometry, and the material while shown): 0 with no marker. */
  get resourceCount(): number {
    return this.pool ? 3 : 0;
  }

  /**
   * Shows `markers` (none: hides them all and frees the mesh), sized for `camera` on a canvas
   * `heightPx` CSS px tall. Returns whether anything drawn changed.
   */
  set(markers: readonly RoutingMarker[], camera: PerspectiveCamera, heightPx: number): boolean {
    if (this.disposed) return false;
    if (markers.length === 0) {
      if (!this.pool) return false;
      this.markers = [];
      this.pool.dispose();
      this.pool = null;
      this.applyScene();
      return true;
    }
    if (!this.pool) {
      this.pool = new InstancedPool('routing:markers', markerGeometry, this.material, this.group, { minCapacity: 8 });
      this.pool.mesh.renderOrder = 10;
    }
    const changed = !sameMarkers(markers, this.markers);
    this.markers = markers;
    if (this.pool.ensure(markers.length)) this.pool.mesh.renderOrder = 10;
    // One CSS px at depth d is d × pxAngle in world units (a perspective camera).
    const pxAngle = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, heightPx);
    camera.updateMatrixWorld();
    const eye = camera.position;
    const mesh = this.pool.mesh;
    for (let i = 0; i < markers.length; i++) {
      const { kind, atMm } = markers[i];
      const style = ROUTING_MARKER_STYLE[kind];
      this.p.set(mm(atMm.x), mm(atMm.y), mm(atMm.z));
      const radius = Math.max(mm(MIN_RADIUS_MM), style.radiusPx * pxAngle * this.p.distanceTo(eye));
      this.m.compose(this.p, this.q, this.s.set(radius, radius, radius));
      mesh.setMatrixAt(i, this.m);
      mesh.setColorAt(i, this.c.setHex(style.colour));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.userData['routing'] = markers.map((m) => `${m.kind} ${m.atMm.x},${m.atMm.y},${m.atMm.z}`);
    this.applyScene();
    return changed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.pool?.dispose();
    this.pool = null;
    this.material.dispose();
    if (this.inScene) this.scene.remove(this.group);
    this.inScene = false;
    this.markers = [];
    this.disposed = true;
  }

  private applyScene(): void {
    const wanted = this.pool !== null;
    if (wanted && !this.inScene) this.scene.add(this.group);
    else if (!wanted && this.inScene) this.scene.remove(this.group);
    this.inScene = wanted;
  }
}

/** A unit sphere (radius 1), one per pool mesh and disposed with it. */
function markerGeometry(): SphereGeometry {
  const geometry = new SphereGeometry(1, 12, 8);
  geometry.name = 'routing:marker';
  return geometry;
}
