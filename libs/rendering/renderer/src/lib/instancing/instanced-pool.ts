import { Color, InstancedMesh, type BufferGeometry, type Material, type Object3D } from 'three/webgpu';

/** How an {@link InstancedPool} behaves. */
export interface InstancedPoolOptions {
  /** Instances allocated at first (and the floor when shrinking). Default 1. */
  readonly minCapacity?: number;
  /**
   * Give the mesh its own no-op `raycast`, so nothing ever picks it (the debug overlays). Default
   * `true`. Wires leave it off: they are never among the picker's roots, and F3.2 part 3 picks them
   * through a BVH of their own.
   */
  readonly unpickable?: boolean;
  /**
   * Rebuild at a quarter of the capacity when at most a quarter is used (wires). Default `false`.
   * The floor is `minCapacity`, but shrinking moves in quarters from a power-of-two multiple of it,
   * so a pool at 2 × `minCapacity` stays there even when empty (a quarter would be below the floor).
   */
  readonly shrink?: boolean;
}

/**
 * One `InstancedMesh` whose capacity doubles when full (ADR 0010: pooled capacity), shared by the
 * debug overlays and the wire renderer. Growing (or shrinking) builds a new mesh and disposes the
 * old one; nothing is resized in place. Writers always re-upload the whole instance buffer
 * (`needsUpdate`): never `addUpdateRange` on a large instanced attribute (three r186, rendering
 * caveats).
 *
 * **Each mesh owns its geometry**, built by `makeGeometry` and disposed with the mesh. In three r186
 * `InstancedMesh.dispose()` frees only the render object's bindings (the uniform-buffer path of a
 * small instance count); the instanced vertex attributes of a large one (the interleaved
 * `instanceMatrix` above the uniform-buffer limit, and `instanceColor`) are released only when the
 * render object's **geometry** is disposed (`Geometries.initGeometry`'s dispose handler, which only
 * knows the first render object it was drawn with). A geometry shared by successive meshes would
 * leak every replaced mesh's instance buffers. The material is shared and never disposed here.
 *
 * Every instance's colour is set (white) when a mesh is built, so the colour attribute exists before
 * the first draw. Instances span the room, so frustum culling is off (the base geometry's bounds say
 * nothing about where its instances are).
 */
export class InstancedPool {
  mesh: InstancedMesh;
  private readonly minCapacity: number;
  private readonly unpickable: boolean;
  private readonly shrink: boolean;

  constructor(
    private readonly name: string,
    private readonly makeGeometry: () => BufferGeometry,
    private readonly material: Material,
    private readonly parent: Object3D,
    options: InstancedPoolOptions = {},
  ) {
    this.minCapacity = Math.max(1, options.minCapacity ?? 1);
    this.unpickable = options.unpickable ?? true;
    this.shrink = options.shrink ?? false;
    this.mesh = this.create(this.minCapacity);
    this.mesh.count = 0;
  }

  /** Instances the current mesh can hold. */
  get capacity(): number {
    return this.mesh.instanceMatrix.count;
  }

  /**
   * Makes room for `count` instances and draws that many: a full mesh is rebuilt at double the
   * capacity (repeatedly, until it fits); with `shrink`, a mesh at most a quarter used is rebuilt at a
   * quarter of its capacity (never below `minCapacity`). Returns whether the mesh was rebuilt (every
   * instance must then be written again).
   */
  ensure(count: number): boolean {
    const capacity = this.capacity;
    let next = capacity;
    while (next < count) next *= 2;
    if (this.shrink) while (next / 4 >= Math.max(count, this.minCapacity) && next > this.minCapacity) next /= 4;
    next = Math.max(next, this.minCapacity);
    let rebuilt = false;
    if (next !== capacity) {
      const old = this.mesh;
      this.mesh = this.create(next);
      this.mesh.visible = old.visible;
      this.mesh.userData = old.userData;
      this.release(old);
      rebuilt = true;
    }
    this.mesh.count = count;
    return rebuilt;
  }

  /** Takes the mesh out of its parent and frees it and its own geometry (not the shared material). */
  dispose(): void {
    this.release(this.mesh);
  }

  private release(mesh: InstancedMesh): void {
    this.parent.remove(mesh);
    mesh.dispose();
    mesh.geometry.dispose(); // frees the instanced attributes too (see the class comment)
  }

  private create(capacity: number): InstancedMesh {
    const mesh = new InstancedMesh(this.makeGeometry(), this.material, capacity);
    mesh.name = this.name;
    mesh.frustumCulled = false;
    if (this.unpickable) mesh.raycast = () => undefined; // never pickable (rendering caveats: overlays)
    const white = new Color(1, 1, 1);
    for (let i = 0; i < capacity; i++) mesh.setColorAt(i, white);
    this.parent.add(mesh);
    return mesh;
  }
}
