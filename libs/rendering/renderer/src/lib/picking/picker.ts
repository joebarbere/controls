/**
 * BVH picking. Two levels, so a 500-device plant never brute-forces the whole scene:
 * - an `ObjectBVH` over the selectable roots narrows a ray to the few objects whose bounds it crosses;
 * - each of those meshes raycasts through its geometry's `MeshBVH` (`acceleratedRaycast`).
 *
 * BVHs are built in `indirect` mode, so the geometry's index buffer (already on the GPU) is never
 * rewritten. Mesh prototypes are not patched globally; only meshes registered here get the
 * accelerated `raycast`, and `dispose()` takes it back off.
 */
import { MeshBVH, ObjectBVH, acceleratedRaycast } from 'three-mesh-bvh';
import {
  Mesh,
  Raycaster,
  Vector2,
  type BufferGeometry,
  type Camera,
  type Intersection,
  type Object3D,
} from 'three/webgpu';
import type { SelectableInfo } from './selection';

const SELECTABLE_KEY = 'selectable';

/** Marks `object` (and so every mesh under it) as selectable. Stored in `userData`, so it is JSON-plain. */
export function markSelectable(object: Object3D, info: SelectableInfo): void {
  object.userData[SELECTABLE_KEY] = info;
}

/** The nearest selectable at or above `object`, or `null`. */
export function selectableOf(object: Object3D | null): { root: Object3D; info: SelectableInfo } | null {
  for (let o = object; o; o = o.parent) {
    const info = o.userData[SELECTABLE_KEY] as SelectableInfo | undefined;
    if (info) return { root: o, info };
  }
  return null;
}

/** Selectable roots directly or indirectly under `root`, outermost first, in traversal order. */
export function findSelectables(root: Object3D): Array<{ root: Object3D; info: SelectableInfo }> {
  const found: Array<{ root: Object3D; info: SelectableInfo }> = [];
  const visit = (o: Object3D): void => {
    const info = o.userData[SELECTABLE_KEY] as SelectableInfo | undefined;
    if (info) {
      found.push({ root: o, info });
      return; // nested selectables belong to their outer one in P1
    }
    o.children.forEach(visit);
  };
  visit(root);
  return found;
}

type BvhGeometry = BufferGeometry & { boundsTree?: MeshBVH };

export class Picker {
  private objectBvh: ObjectBVH | null = null;
  private readonly roots: Object3D[] = [];
  private readonly ownedGeometries = new Set<BvhGeometry>();
  private readonly patchedMeshes = new Set<Mesh>();
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly hits: Intersection[] = [];

  constructor() {
    (this.raycaster as Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
  }

  /** Number of mesh BVHs this picker owns (for disposal tests and the dev HUD). */
  get bvhCount(): number {
    return this.ownedGeometries.size;
  }

  /**
   * (Re)builds the object-level BVH over `roots` and a geometry BVH for every mesh under them that
   * lacks one. Call after the scene's world matrices are current.
   * TODO(F1.2): call on world-snapshot add/remove; call `refit()` on moves.
   */
  setRoots(roots: readonly Object3D[]): void {
    this.roots.length = 0;
    this.roots.push(...roots);
    for (const root of roots) {
      root.updateWorldMatrix(true, true);
      root.traverse((o) => {
        if (!(o instanceof Mesh)) return;
        const geometry = o.geometry as BvhGeometry;
        if (!geometry.boundsTree) {
          geometry.boundsTree = new MeshBVH(geometry, { indirect: true });
          this.ownedGeometries.add(geometry);
        }
        if (!this.patchedMeshes.has(o)) {
          o.raycast = acceleratedRaycast;
          this.patchedMeshes.add(o);
        }
      });
    }
    // ObjectBVH needs at least one primitive (its id-bit maths takes log2 of the object count).
    this.objectBvh = this.roots.length > 0 ? new ObjectBVH(this.roots) : null;
  }

  /** Re-fits the object BVH after selectable objects move. */
  refit(): void {
    if (!this.objectBvh) return;
    this.roots.forEach((r) => r.updateWorldMatrix(true, true));
    this.objectBvh.refit();
  }

  /** Nearest selectable under normalised device coordinates (−1…1), or `null`. */
  pick(ndcX: number, ndcY: number, camera: Camera): { info: SelectableInfo; distance: number } | null {
    if (!this.objectBvh) return null;
    this.ndc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.ndc, camera);
    this.hits.length = 0;
    this.objectBvh.raycast(this.raycaster, this.hits);
    let best: { info: SelectableInfo; distance: number } | null = null;
    for (const hit of this.hits) {
      const owner = selectableOf(hit.object);
      if (owner && (!best || hit.distance < best.distance)) best = { info: owner.info, distance: hit.distance };
    }
    this.hits.length = 0;
    return best;
  }

  /** Drops every BVH this picker built and restores the meshes' own `raycast`. */
  dispose(): void {
    this.ownedGeometries.forEach((g) => delete g.boundsTree);
    this.ownedGeometries.clear();
    // `raycast` was set as an own property; deleting it re-exposes Mesh.prototype.raycast.
    this.patchedMeshes.forEach((m) => delete (m as { raycast?: unknown }).raycast);
    this.patchedMeshes.clear();
    this.roots.length = 0;
    this.objectBvh = null;
  }
}
