/**
 * The placement ghost: a translucent preview of the prop being placed or moved, at the snapped
 * position. Renderer-local view state: not selectable, not pickable, never in the world. One mesh,
 * reused; its geometry is borrowed from the shared prop recipes (released when the ghost changes
 * prop or hides), so a ghost never holds GPU memory after placement ends.
 */
import { BufferGeometry, Mesh, type Material, type Scene } from 'three/webgpu';
import { mdegToRadians, mm } from '@controls/units';
import type { CatalogRef, OrientationMdeg, Vec3Mm } from '@controls/world-model';
import { buildGhostMaterial, type PropRecipes } from '../geometry/props';

export class PlacementGhost {
  readonly mesh: Mesh;
  private readonly material: Material = buildGhostMaterial();
  /** Empty stand-in while no prop is borrowed, so the mesh never points at a released geometry. */
  private readonly placeholder = new BufferGeometry();
  private ref: CatalogRef | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly recipes: PropRecipes,
  ) {
    this.mesh = new Mesh(this.placeholder, this.material);
    this.mesh.name = 'overlay:ghost';
    this.mesh.visible = false;
    this.mesh.renderOrder = 1; // after the opaque scene, so it blends over what it covers
    this.mesh.raycast = () => undefined; // never pickable, even by a whole-scene raycast
    scene.add(this.mesh);
  }

  get visible(): boolean {
    return this.mesh.visible;
  }

  /** Shows `ref` at an integer-mm position and orientation (the exact command arguments). */
  show(ref: CatalogRef, positionMm: Vec3Mm, orientationMdeg: OrientationMdeg): void {
    if (!this.ref || this.ref.id !== ref.id || this.ref.version !== ref.version) {
      this.releaseGeometry();
      this.mesh.geometry = this.recipes.acquire(ref).geometry;
      this.ref = ref;
    }
    this.mesh.position.set(mm(positionMm.x), mm(positionMm.y), mm(positionMm.z));
    this.mesh.rotation.set(
      mdegToRadians(orientationMdeg.pitch),
      mdegToRadians(orientationMdeg.yaw),
      mdegToRadians(orientationMdeg.roll),
      'YXZ',
    );
    this.mesh.visible = true;
  }

  /** Hides the ghost (keeps its prop's geometry while it is still the active tool). */
  hide(): void {
    this.mesh.visible = false;
  }

  /** Hides the ghost and returns its borrowed geometry (placement ended). */
  clear(): void {
    this.hide();
    this.releaseGeometry();
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.mesh);
    this.material.dispose();
    this.placeholder.dispose();
  }

  private releaseGeometry(): void {
    if (!this.ref) return;
    this.mesh.geometry = this.placeholder;
    this.recipes.release(this.ref);
    this.ref = null;
  }
}
