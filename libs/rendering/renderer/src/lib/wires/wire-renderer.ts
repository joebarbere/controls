/**
 * The wire renderer (F3.2 part 2, ADR 0010, ADR 0017): draws every routed conductor and cable from
 * the domain bake, and the one live preview rope.
 *
 * - **Baked wires come only from `bakeWorldRoutes`** (`@controls/world-model` routing): the renderer
 *   computes no route shape. It re-bakes when the world's connections, cables or entities change (by
 *   identity) and rewrites the GPU side only when some drawn route, look, colour or label changed.
 * - **One `InstancedMesh` per conductor look** (`wire-looks`: the insulation or jacket material), each
 *   a pool of 6-sided unit cylinders, one instance per segment, coloured per instance, whose capacity
 *   doubles when full and shrinks when a quarter used; a look with no instances left is disposed
 *   (mesh, material), and the shared segment geometry with the last look. Every write is a full
 *   `needsUpdate` upload, never `addUpdateRange` (three r186, rendering caveats). Draw calls follow
 *   the number of looks in use, never the number of wires.
 * - **Coils** (a cut much longer than its route, ADR 0017 §7) are drawn as rings at the bake's coil
 *   point, in the same look mesh; **labels** (`connection.label`, `cable.label`) as two sleeve
 *   markers per labelled route in one more instanced mesh, the text as data on it (`userData.wires`,
 *   the scene-graph snapshot) like a device's label plate: no canvas text.
 * - **Overlays recolour conductor instances** (D15): {@link WireRenderer.setTint} takes a
 *   {@link WireTint} that gives each single conductor's end-`a` and end-`b` halves a colour (or `-1`
 *   for its own). The debug overlays drive it; the heat overlay (F3.6 part 3) will too.
 * - **One live preview rope** ({@link WireRenderer.setPreview}): a {@link VerletRope} through the
 *   pins the routing gesture gives (F3.2 part 3), drawn in its own small instanced mesh and stepped in
 *   {@link WireRenderer.update} until it settles. It is view state: never committed, stored or hashed.
 *
 * The group is in the scene only while something is drawn, so a world without wires has exactly the
 * scene it had before F3.2. Never pickable here: wire picking is F3.2 part 3's BVH.
 */
import {
  Color,
  CylinderGeometry,
  Group,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Scene,
} from 'three/webgpu';
import { BUILTIN_CATALOG, type Catalog } from '@controls/catalog';
import { mm } from '@controls/units';
import {
  bakeWorldRoutes,
  type BakedRoute,
  type CatalogRef,
  type ConductorColour,
  type Vec3Mm,
  type World,
} from '@controls/world-model';
import { InstancedPool } from '../instancing/instanced-pool';
import { VerletRope } from './rope';
import { cableAppearance, conductorAppearance, hexString, lookFinish, type WireAppearance } from './wire-looks';
import {
  coilDrawnTurns,
  coilPolylineMm,
  forEachRouteSegment,
  SLEEVE_EXTRA_DIAMETER_MM,
  SLEEVE_LENGTH_MM,
  sleevePlacements,
} from './wire-segments';

/** Colours for the halves of single conductors (D15): `0xrrggbb`, or `-1` to draw the conductor's own. */
export interface WireTint {
  /** The colour of connection `connection`'s half at end `end`. Called once per conductor and end per refresh. */
  colour(connection: number, end: 'a' | 'b'): number;
}

/** What the live preview rope is drawn through and as (F3.2 part 3 drives it). */
export interface WirePreview {
  /** Pins in order (mm): the first terminal's point, waypoints, the cursor or the second terminal. */
  readonly pointsMm: readonly Vec3Mm[];
  /** The conductor on the spool. */
  readonly ref: CatalogRef;
  readonly colour: ConductorColour | null;
}

/** JSON-plain summary of what is drawn (scene-graph snapshot tests, the e2e hook). */
export interface WireGraph {
  /** Whether the `wires` group is in the scene. */
  readonly inScene: boolean;
  /** Each look's instanced mesh: instances drawn and capacity, in look order. */
  readonly looks: readonly { readonly look: string; readonly instances: number; readonly capacity: number }[];
  readonly routes: readonly {
    /** `c<connection id>` or `k<cable id>` (the bake's owner). */
    readonly owner: string;
    readonly look: string;
    /** sRGB `#rrggbb`: its insulation (or jacket) colour, before any tint. */
    readonly colour: string;
    readonly diameterMm: number;
    readonly segments: number;
    /** First and last baked point (mm, to 0.1 mm). */
    readonly fromMm: readonly [number, number, number];
    readonly toMm: readonly [number, number, number];
    readonly coil: { readonly atMm: readonly [number, number, number]; readonly turns: number } | null;
    readonly label: string | null;
    /** The colours an overlay draws its halves in (`#rrggbb`), or `null` when untinted. */
    readonly tint: readonly [string, string] | null;
  }[];
  readonly sleeves: number;
  readonly preview: {
    readonly particles: number;
    readonly settled: boolean;
    readonly frames: number;
    readonly look: string;
  } | null;
}

/** One drawn route: what it is, how it looks, and where its instances are. */
interface DrawnRoute {
  readonly baked: BakedRoute;
  /** The single conductor's id (for a tint), or `null` for a cable. */
  readonly connection: number | null;
  readonly appearance: WireAppearance;
  readonly label: string | null;
  segments: number;
}

/** A look's instanced segments and its material. */
interface LookLayer {
  readonly pool: InstancedPool;
  readonly material: MeshStandardMaterial;
  /** Per instance: its route's index in `routes`, and its half (0 `a`, 1 `b`). */
  route: Int32Array;
  half: Uint8Array;
}

/** First pool size for a look (64 segments: a few wires before the first doubling). */
const MIN_LOOK_CAPACITY = 64;
/** Sleeve marker colour (game-design: white printed heat-shrink). */
const SLEEVE_COLOUR = 0xf4f4ee;

const UP = new Vector3(0, 1, 0);

export class WireRenderer {
  /** Parent of every wire mesh; in the scene only while something is drawn. */
  readonly group = new Group();
  private geometry: BufferGeometry | null = null;
  private readonly looks = new Map<string, LookLayer>();
  private sleeves: { pool: InstancedPool; material: MeshStandardMaterial } | null = null;
  private previewLayer: {
    pool: InstancedPool;
    material: MeshStandardMaterial;
    look: string;
    appearance: WireAppearance;
  } | null = null;
  private readonly rope = new VerletRope();
  private routes: DrawnRoute[] = [];
  private tint: WireTint | null = null;
  /** Per route (index), the tint colour of each half, or −1. */
  private tintA = new Int32Array(0);
  private tintB = new Int32Array(0);
  private inScene = false;
  private disposed = false;
  private seen: { entities: unknown; connections: unknown; cables: unknown } | null = null;

  // Scratch: writes allocate nothing per instance.
  private readonly m = new Matrix4();
  private readonly p = new Vector3();
  private readonly d = new Vector3();
  private readonly s = new Vector3();
  private readonly q = new Quaternion();
  private readonly colour = new Color();

  constructor(
    private readonly scene: Scene,
    private readonly catalog: Catalog = BUILTIN_CATALOG,
    private readonly onInvalidate: () => void = () => undefined,
  ) {
    this.group.name = 'wires';
  }

  /**
   * Draws `world`'s routes: re-bakes when its connections, cables or entities changed (by identity)
   * and rewrites instances only if a drawn route, look, colour or label changed. Never mutates
   * `world`. Returns whether anything drawn changed (the caller's sync already asks for a frame).
   */
  sync(world: World): boolean {
    if (this.disposed) return false;
    const seen = this.seen;
    if (
      seen &&
      seen.entities === world.entities &&
      seen.connections === world.connections &&
      seen.cables === world.cables
    )
      return false;
    this.seen = { entities: world.entities, connections: world.connections, cables: world.cables };
    const next = this.drawnRoutes(world);
    if (sameRoutes(next, this.routes)) return false;
    this.routes = next;
    this.writeRoutes();
    return true;
  }

  /**
   * Sets (or clears, with `null`) the overlay colours of single conductors' halves (D15), and
   * rewrites the instance colours. Call {@link refreshTint} when the colours the same tint gives
   * have changed (new overlay steps).
   */
  setTint(tint: WireTint | null): void {
    if (this.disposed || tint === this.tint) return;
    this.tint = tint;
    this.refreshTint();
  }

  /** Re-reads the tint's colours and rewrites instance colours where they changed. Allocation-free. */
  refreshTint(): void {
    if (this.disposed) return;
    let changed = false;
    for (let r = 0; r < this.routes.length; r++) {
      const c = this.routes[r].connection;
      const a = this.tint && c !== null ? this.tint.colour(c, 'a') : -1;
      const b = this.tint && c !== null ? this.tint.colour(c, 'b') : -1;
      if (a !== this.tintA[r] || b !== this.tintB[r]) changed = true;
      this.tintA[r] = a;
      this.tintB[r] = b;
    }
    if (!changed) return;
    for (const layer of this.looks.values()) this.writeColours(layer);
    this.onInvalidate();
  }

  /**
   * Shows the live preview rope through `preview.pointsMm` (or hides it, `null`). Re-pinning keeps
   * the rope's sag (no pop); the rope then animates in {@link update} until it settles.
   */
  setPreview(preview: WirePreview | null): void {
    if (this.disposed) return;
    if (preview === null || preview.pointsMm.length < 2) {
      this.rope.setPins([]);
      this.disposePreviewLayer();
      this.applyScene();
      this.onInvalidate();
      return;
    }
    const appearance = conductorAppearance(this.catalog, preview.ref, preview.colour);
    if (this.previewLayer && this.previewLayer.look !== appearance.look) this.disposePreviewLayer();
    if (!this.previewLayer) {
      const material = lookMaterial(appearance.look);
      const pool = new InstancedPool('wires:preview', this.segmentGeometry(), material, this.group, {
        minCapacity: MIN_LOOK_CAPACITY,
        unpickable: false,
      });
      this.previewLayer = { pool, material, look: appearance.look, appearance };
    }
    this.previewLayer.appearance = appearance;
    this.rope.setPins(preview.pointsMm);
    this.writePreview();
    this.applyScene();
    this.onInvalidate();
  }

  /** Steps the preview rope one frame. Returns `true` while it still moves (another frame wanted). */
  update(): boolean {
    if (this.previewLayer === null || this.rope.settled) return false;
    const moving = this.rope.step();
    this.writePreview();
    return moving;
  }

  /** JSON-plain summary of what is drawn. */
  describe(): WireGraph {
    const round = (v: number) => Math.round(v * 10) / 10 + 0;
    const point = (points: readonly number[], i: number): [number, number, number] => [
      round(points[3 * i] / 10),
      round(points[3 * i + 1] / 10),
      round(points[3 * i + 2] / 10),
    ];
    return {
      inScene: this.inScene,
      looks: [...this.looks.entries()]
        .sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0))
        .map(([look, l]) => ({
          look,
          instances: l.pool.mesh.count,
          capacity: l.pool.capacity,
        })),
      routes: this.routes.map((r, i) => {
        const n = r.baked.points.length / 3;
        const coil = r.baked.coil;
        return {
          owner: r.baked.owner,
          look: r.appearance.look,
          colour: hexString(r.appearance.colour),
          diameterMm: round(r.appearance.diameterMm),
          segments: r.segments,
          fromMm: point(r.baked.points, 0),
          toMm: point(r.baked.points, Math.max(0, n - 1)),
          coil: coil && { atMm: [coil.at[0] / 10, coil.at[1] / 10, coil.at[2] / 10], turns: coilDrawnTurns(coil) },
          label: r.label,
          tint:
            this.tintA[i] >= 0 || this.tintB[i] >= 0
              ? [
                  hexString(this.tintA[i] >= 0 ? this.tintA[i] : r.appearance.colour),
                  hexString(this.tintB[i] >= 0 ? this.tintB[i] : r.appearance.colour),
                ]
              : null,
        };
      }),
      sleeves: this.sleeves?.pool.mesh.count ?? 0,
      preview: this.previewLayer && {
        particles: this.rope.count,
        settled: this.rope.settled,
        frames: this.rope.frames,
        look: this.previewLayer.look,
      },
    };
  }

  /**
   * GPU resources alive: the segment geometry, each look's mesh and material, the sleeve and preview
   * meshes and materials. 0 when nothing is drawn (the disposal baseline).
   */
  get resourceCount(): number {
    return (this.geometry ? 1 : 0) + 2 * this.looks.size + (this.sleeves ? 2 : 0) + (this.previewLayer ? 2 : 0);
  }

  /** Releases every mesh, material and the geometry, and leaves the scene. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.routes = [];
    for (const look of [...this.looks.keys()]) this.disposeLook(look);
    this.disposeSleeves();
    this.disposePreviewLayer();
    this.releaseGeometry();
    if (this.inScene) this.scene.remove(this.group);
    this.inScene = false;
    this.tint = null;
    this.disposed = true;
  }

  // --- baking ----------------------------------------------------------------------------------

  /** The world's baked routes with their looks and labels (bake order: conductors, then cables, by id). */
  private drawnRoutes(world: World): DrawnRoute[] {
    const { routes } = bakeWorldRoutes(world, this.catalog);
    const connections = new Map(world.connections.map((c) => [c.id, c]));
    const cables = new Map(world.cables.map((c) => [c.id, c]));
    const out: DrawnRoute[] = [];
    for (const baked of routes) {
      const id = Number(baked.owner.slice(1));
      if (baked.owner.startsWith('c')) {
        const c = connections.get(id);
        if (!c) continue;
        out.push({
          baked,
          connection: c.id,
          appearance: conductorAppearance(this.catalog, c.ref, c.colour),
          label: c.label,
          segments: 0,
        });
      } else {
        const k = cables.get(id);
        if (!k) continue;
        out.push({
          baked,
          connection: null,
          appearance: cableAppearance(this.catalog, k.ref),
          label: k.label,
          segments: 0,
        });
      }
    }
    return out;
  }

  /** Writes every route's segments into its look's pool, sleeves for labelled routes, and the scene membership. */
  private writeRoutes(): void {
    // Instances per look: the route's segments plus its coil's.
    const counts = new Map<string, number>();
    const coils: (number[] | null)[] = this.routes.map((r) =>
      r.baked.coil ? coilPolylineMm(r.baked.coil, r.appearance.diameterMm) : null,
    );
    this.routes.forEach((r, i) => {
      const n = Math.max(0, r.baked.points.length / 3 - 1) + Math.max(0, (coils[i]?.length ?? 0) / 3 - 1);
      r.segments = n;
      if (n > 0) counts.set(r.appearance.look, (counts.get(r.appearance.look) ?? 0) + n);
    });
    for (const look of [...this.looks.keys()]) if (!counts.has(look)) this.disposeLook(look);
    const sorted = [...counts.keys()].sort();
    for (const look of sorted) {
      let layer = this.looks.get(look);
      if (!layer) {
        const material = lookMaterial(look);
        const pool = new InstancedPool(`wires:${look}`, this.segmentGeometry(), material, this.group, {
          minCapacity: MIN_LOOK_CAPACITY,
          unpickable: false,
          shrink: true,
        });
        layer = { pool, material, route: new Int32Array(0), half: new Uint8Array(0) };
        this.looks.set(look, layer);
      }
      const count = counts.get(look) as number;
      layer.pool.ensure(count);
      if (layer.route.length < layer.pool.capacity) {
        layer.route = new Int32Array(layer.pool.capacity);
        layer.half = new Uint8Array(layer.pool.capacity);
      }
      layer.pool.mesh.userData['wires'] = { look, instances: count };
    }
    // Keep the looks in sorted order in the group (a stable scene graph whatever the insertion order).
    for (const look of sorted) {
      const mesh = (this.looks.get(look) as LookLayer).pool.mesh;
      this.group.remove(mesh);
      this.group.add(mesh);
    }
    const next = new Map<string, number>();
    this.tintA = new Int32Array(this.routes.length).fill(-1);
    this.tintB = new Int32Array(this.routes.length).fill(-1);
    this.routes.forEach((r, ri) => {
      const layer = this.looks.get(r.appearance.look);
      if (!layer) return;
      const radius = mm(r.appearance.diameterMm / 2);
      let k = next.get(r.appearance.look) ?? 0;
      const write = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, half: 0 | 1) => {
        this.segmentMatrix(ax, ay, az, bx, by, bz, radius);
        layer.pool.mesh.setMatrixAt(k, this.m);
        layer.route[k] = ri;
        layer.half[k] = half;
        k++;
      };
      forEachRouteSegment(r.baked.points, write);
      const coil = coils[ri];
      if (coil) {
        for (let i = 3; i + 2 < coil.length; i += 3) {
          write(coil[i - 3], coil[i - 2], coil[i - 1], coil[i], coil[i + 1], coil[i + 2], 1);
        }
      }
      next.set(r.appearance.look, k);
    });
    this.readTint();
    for (const layer of this.looks.values()) {
      layer.pool.mesh.instanceMatrix.needsUpdate = true;
      this.writeColours(layer);
    }
    this.writeSleeves();
    this.applyScene();
  }

  /** Reads the tint's colours for every route (after a re-bake: the route indices changed). */
  private readTint(): void {
    if (this.tint === null) return;
    for (let r = 0; r < this.routes.length; r++) {
      const c = this.routes[r].connection;
      this.tintA[r] = c === null ? -1 : this.tint.colour(c, 'a');
      this.tintB[r] = c === null ? -1 : this.tint.colour(c, 'b');
    }
  }

  /** Every instance colour of a look: its route's colour, or its half's tint. Full upload. */
  private writeColours(layer: LookLayer): void {
    const mesh = layer.pool.mesh;
    for (let i = 0; i < mesh.count; i++) {
      const r = layer.route[i];
      const tint = layer.half[i] === 0 ? this.tintA[r] : this.tintB[r];
      mesh.setColorAt(i, this.colour.setHex(tint >= 0 ? tint : this.routes[r].appearance.colour));
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /** Two sleeve markers per labelled route, in one instanced mesh; the labels as data on it. */
  private writeSleeves(): void {
    const labelled = this.routes.filter((r) => r.label !== null);
    const placements = labelled.map((r) => ({ r, at: sleevePlacements(r.baked.points) }));
    const count = placements.reduce((n, p) => n + p.at.length, 0);
    if (count === 0) {
      this.disposeSleeves();
      return;
    }
    if (!this.sleeves) {
      const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0 });
      const pool = new InstancedPool('wires:sleeves', this.segmentGeometry(), material, this.group, {
        minCapacity: 16,
        unpickable: false,
        shrink: true,
      });
      this.sleeves = { pool, material };
    }
    this.sleeves.pool.ensure(count);
    const pool = this.sleeves.pool.mesh;
    let k = 0;
    const half = SLEEVE_LENGTH_MM / 2;
    for (const { r, at } of placements) {
      const radius = mm((r.appearance.diameterMm + SLEEVE_EXTRA_DIAMETER_MM) / 2);
      for (const s of at) {
        const [x, y, z] = s.at;
        const [dx, dy, dz] = s.direction;
        this.segmentMatrix(
          x - dx * half,
          y - dy * half,
          z - dz * half,
          x + dx * half,
          y + dy * half,
          z + dz * half,
          radius,
          0,
        );
        pool.setMatrixAt(k, this.m);
        pool.setColorAt(k, this.colour.setHex(SLEEVE_COLOUR));
        k++;
      }
    }
    pool.instanceMatrix.needsUpdate = true;
    if (pool.instanceColor) pool.instanceColor.needsUpdate = true;
    pool.userData['wires'] = {
      labels: labelled.map((r) => `${r.baked.owner} ${r.label as string}`),
      instances: count,
    };
  }

  /** The preview rope's links as segments in its own mesh. */
  private writePreview(): void {
    const layer = this.previewLayer;
    if (!layer) return;
    const appearance = layer.appearance;
    const n = Math.max(0, this.rope.count - 1);
    if (layer.pool.ensure(n) || layer.pool.mesh.userData['colour'] !== appearance.colour) {
      for (let i = 0; i < layer.pool.capacity; i++)
        layer.pool.mesh.setColorAt(i, this.colour.setHex(appearance.colour));
      layer.pool.mesh.userData['colour'] = appearance.colour;
      if (layer.pool.mesh.instanceColor) layer.pool.mesh.instanceColor.needsUpdate = true;
    }
    const shown = layer.pool.mesh.userData['wires'] as { instances: number } | undefined;
    if (shown?.instances !== n) layer.pool.mesh.userData['wires'] = { look: layer.look, instances: n };
    const radius = mm(appearance.diameterMm / 2);
    const rope = this.rope;
    for (let i = 0; i < n; i++) {
      this.segmentMatrix(rope.x(i), rope.y(i), rope.z(i), rope.x(i + 1), rope.y(i + 1), rope.z(i + 1), radius);
      layer.pool.mesh.setMatrixAt(i, this.m);
    }
    layer.pool.mesh.instanceMatrix.needsUpdate = true;
  }

  // --- GPU helpers -----------------------------------------------------------------------------

  /**
   * `this.m` = a unit cylinder (along +y, radius 1, height 1) stood on the segment from a to b (mm),
   * of radius `radius` (scene metres), lengthened by `overlap` radii in all (half at each end) so
   * the outside of a bend has no gap. Allocation-free.
   */
  private segmentMatrix(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    radius: number,
    overlap = 1,
  ): void {
    this.d.set(mm(bx - ax), mm(by - ay), mm(bz - az));
    const length = this.d.length();
    this.p.set(mm((ax + bx) / 2), mm((ay + by) / 2), mm((az + bz) / 2));
    if (length > 0) this.q.setFromUnitVectors(UP, this.d.divideScalar(length));
    else this.q.identity();
    this.m.compose(this.p, this.q, this.s.set(radius, length + overlap * radius, radius));
  }

  /** The shared 6-sided unit cylinder, built on first use and released with the last mesh. */
  private segmentGeometry(): BufferGeometry {
    if (!this.geometry) {
      this.geometry = new CylinderGeometry(1, 1, 1, 6, 1);
      this.geometry.name = 'wires:segment';
    }
    return this.geometry;
  }

  private releaseGeometry(): void {
    if (this.looks.size > 0 || this.sleeves || this.previewLayer || !this.geometry) return;
    this.geometry.dispose();
    this.geometry = null;
  }

  private disposeLook(look: string): void {
    const layer = this.looks.get(look);
    if (!layer) return;
    layer.pool.dispose();
    layer.material.dispose();
    this.looks.delete(look);
    this.releaseGeometry();
  }

  private disposeSleeves(): void {
    if (!this.sleeves) return;
    this.sleeves.pool.dispose();
    this.sleeves.material.dispose();
    this.sleeves = null;
    this.releaseGeometry();
  }

  private disposePreviewLayer(): void {
    if (!this.previewLayer) return;
    this.previewLayer.pool.dispose();
    this.previewLayer.material.dispose();
    this.previewLayer = null;
    this.releaseGeometry();
  }

  /** In the scene only while some route, sleeve or preview is drawn. */
  private applyScene(): void {
    const wanted = this.looks.size > 0 || this.sleeves !== null || this.previewLayer !== null;
    if (wanted && !this.inScene) this.scene.add(this.group);
    else if (!wanted && this.inScene) this.scene.remove(this.group);
    this.inScene = wanted;
  }
}

/** A look's material: white (instances carry the colour), with the look's finish. */
function lookMaterial(look: string): MeshStandardMaterial {
  const finish = lookFinish(look);
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: finish.roughness,
    metalness: finish.metalness,
  });
  material.name = `wires:${look}`;
  return material;
}

/** Whether two drawn route lists draw the same thing (same bake, looks, colours and labels, in order). */
function sameRoutes(a: readonly DrawnRoute[], b: readonly DrawnRoute[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = b[i];
    if (
      p.baked.owner !== q.baked.owner ||
      p.label !== q.label ||
      p.connection !== q.connection ||
      p.appearance.look !== q.appearance.look ||
      p.appearance.colour !== q.appearance.colour ||
      p.appearance.diameterMm !== q.appearance.diameterMm ||
      !sameNumbers(p.baked.points, q.baked.points) ||
      (p.baked.coil === null) !== (q.baked.coil === null) ||
      (p.baked.coil !== null &&
        q.baked.coil !== null &&
        (p.baked.coil.lengthTenths !== q.baked.coil.lengthTenths || !sameNumbers(p.baked.coil.at, q.baked.coil.at)))
    ) {
      return false;
    }
  }
  return true;
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
