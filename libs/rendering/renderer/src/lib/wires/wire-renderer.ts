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
 *   (mesh, its own segment geometry, material); every pool mesh owns its geometry, since in three
 *   r186 that is what frees a large mesh's instance buffers (`instancing/instanced-pool`). Every write is a full
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
 * - **Picking** (F3.2 part 3, ADR 0017 §9): {@link WireRenderer.pick} casts a ray against a
 *   {@link SegmentBvh} over the drawn segments (coils included, sleeves and the preview not), built
 *   lazily on the first pick after a change, with the ray-to-capsule test widened to 4 px on screen.
 *   The meshes themselves are never raycast. {@link WireRenderer.setHighlight} draws the hovered and
 *   selected wires as a translucent sleeve over their segments (`wires:highlight`).
 *
 * The group is in the scene only while something is drawn, so a world without wires has exactly the
 * scene it had before F3.2.
 */
import {
  Color,
  CylinderGeometry,
  Group,
  Matrix4,
  MeshBasicMaterial,
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
import { emptySegmentHit, SegmentBvh, WIRE_PICK_MIN_RADIUS_PX } from '../picking/segment-bvh';
import { VerletRope } from './rope';
import { cableAppearance, conductorAppearance, hexString, lookFinish, type WireAppearance } from './wire-looks';
import {
  coilDrawnTurns,
  coilPolylineMm,
  forEachRouteSegment,
  halfAt,
  SLEEVE_EXTRA_DIAMETER_MM,
  SLEEVE_LENGTH_MM,
  sleevePlacements,
} from './wire-segments';

/** Colours for the halves of single conductors (D15): `0xrrggbb`, or `-1` to draw the conductor's own. */
export interface WireTint {
  /** The colour of connection `connection`'s half at end `end`. Called once per conductor and end per refresh. */
  colour(connection: number, end: 'a' | 'b'): number;
  /**
   * What a cable is drawn in while the tint is on (`0xrrggbb`): the overlay's "unknown" colour, since
   * the overlays have no reading for a jacket (its conductors are coloured from F3.2 part 4). Without
   * it a yellow NM-B jacket would read as a value on the overlay's scale.
   */
  readonly unknownColour: number;
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
  /** The highlighted wires (`c<id>` / `k<id>`): hovered and selected. */
  readonly highlight: { readonly hover: string | null; readonly selected: string | null };
  readonly preview: {
    readonly particles: number;
    readonly settled: boolean;
    readonly frames: number;
    readonly look: string;
  } | null;
}

/** A drawn conductor or cable: what wire picking returns and highlighting takes. */
export interface WireRef {
  readonly kind: 'connection' | 'cable';
  readonly id: number;
}

/** A wire under a ray ({@link WireRenderer.pick}). */
export interface WirePick {
  readonly wire: WireRef;
  /** Distance along the ray to the closest approach, mm. */
  readonly depthMm: number;
  /** How far the ray passes from the centreline there, CSS px. */
  readonly offsetPx: number;
  /** Whether the ray passes through the insulation itself (not only the widened 4 px target). */
  readonly exact: boolean;
}

/** `c<id>` / `k<id>` (the bake's owner) for a wire ref. */
export const wireOwner = (wire: WireRef): string => `${wire.kind === 'connection' ? 'c' : 'k'}${wire.id}`;

/** Highlight colours (hover matches the selection outline's hover blue, selection its amber). */
const HIGHLIGHT_HOVER = 0x7fb8ff;
const HIGHLIGHT_SELECTED = 0xffb000;
/** The highlight sleeve's radius as a multiple of the wire's (game-design). */
const HIGHLIGHT_SCALE = 1.8;

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
  private highlightLayer: { pool: InstancedPool; material: MeshBasicMaterial } | null = null;
  private highlightHover: string | null = null;
  private highlightSelected: string | null = null;
  private inScene = false;
  private disposed = false;
  private seen: { entities: unknown; connections: unknown; cables: unknown } | null = null;
  // Picking: every drawn segment (mm, 6 per segment), its radius and its route; the BVH over them.
  private segPoints = new Float64Array(0);
  private segRadius = new Float64Array(0);
  private segRoute = new Int32Array(0);
  private segCount = 0;
  private readonly bvh = new SegmentBvh();
  private bvhDirty = false;
  private readonly hit = emptySegmentHit();

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
    this.writeHighlight();
    return true;
  }

  /**
   * The wire under the ray from `origin` along the unit vector `direction` (both world mm), by the
   * BVH and the ray-to-capsule test (`picking/segment-bvh`), or `null`. `pxAngle` is the world size
   * of one CSS pixel per mm of depth (`2 tan(fov / 2) / heightPx`): no wire is a thinner target than
   * {@link WIRE_PICK_MIN_RADIUS_PX} on screen. Allocation-free except for the answer; the BVH is
   * rebuilt here, once, after the drawn wires changed.
   */
  pick(
    origin: { readonly x: number; readonly y: number; readonly z: number },
    direction: { readonly x: number; readonly y: number; readonly z: number },
    pxAngle: number,
  ): WirePick | null {
    if (this.disposed || this.segCount === 0) return null;
    if (this.bvhDirty) {
      this.bvh.build(this.segPoints, this.segRadius, this.segCount);
      this.bvhDirty = false;
    }
    const h = this.hit;
    const { x, y, z } = origin;
    if (!this.bvh.raycast(x, y, z, direction.x, direction.y, direction.z, pxAngle, h, WIRE_PICK_MIN_RADIUS_PX)) {
      return null;
    }
    const owner = this.routes[this.segRoute[h.segment]].baked.owner;
    return {
      wire: { kind: owner.startsWith('c') ? 'connection' : 'cable', id: Number(owner.slice(1)) },
      depthMm: h.depthMm,
      offsetPx: h.offsetPx,
      exact: h.exact,
    };
  }

  /** Whether `wire` is drawn. */
  drawn(wire: WireRef): boolean {
    const owner = wireOwner(wire);
    return this.routes.some((r) => r.baked.owner === owner);
  }

  /**
   * Draws the hovered and the selected wire (either `null`) as a translucent sleeve over their
   * segments. A wire that isn't drawn draws nothing. Returns whether the highlight changed.
   */
  setHighlight(hover: WireRef | null, selected: WireRef | null): boolean {
    if (this.disposed) return false;
    const h = hover && wireOwner(hover);
    const s = selected && wireOwner(selected);
    if (h === this.highlightHover && s === this.highlightSelected) return false;
    this.highlightHover = h;
    this.highlightSelected = s;
    this.writeHighlight();
    this.onInvalidate();
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
      const a = this.tintColour(c, 'a');
      const b = this.tintColour(c, 'b');
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
      const pool = new InstancedPool('wires:preview', segmentGeometry, material, this.group, {
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
      highlight: { hover: this.highlightHover, selected: this.highlightSelected },
      preview: this.previewLayer && {
        particles: this.rope.count,
        settled: this.rope.settled,
        frames: this.rope.frames,
        look: this.previewLayer.look,
      },
    };
  }

  /**
   * GPU resources alive: each look's, the sleeves', the preview's and the highlight's mesh, its own
   * geometry and its material (3 each). 0 when nothing is drawn (the disposal baseline).
   */
  get resourceCount(): number {
    const layers =
      this.looks.size + (this.sleeves ? 1 : 0) + (this.previewLayer ? 1 : 0) + (this.highlightLayer ? 1 : 0);
    return 3 * layers;
  }

  /** Releases every mesh, geometry and material, and leaves the scene. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.routes = [];
    for (const look of [...this.looks.keys()]) this.disposeLook(look);
    this.disposeSleeves();
    this.disposePreviewLayer();
    this.disposeHighlight();
    this.segCount = 0;
    this.bvh.clear();
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
        const pool = new InstancedPool(`wires:${look}`, segmentGeometry, material, this.group, {
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
    const total = this.routes.reduce((n, r) => n + r.segments, 0);
    if (this.segRadius.length < total || this.segRadius.length > 4 * Math.max(total, 64)) {
      const capacity = Math.max(total, 64);
      this.segPoints = new Float64Array(6 * capacity);
      this.segRadius = new Float64Array(capacity);
      this.segRoute = new Int32Array(capacity);
    }
    let seg = 0;
    const next = new Map<string, number>();
    this.tintA = new Int32Array(this.routes.length).fill(-1);
    this.tintB = new Int32Array(this.routes.length).fill(-1);
    this.routes.forEach((r, ri) => {
      const layer = this.looks.get(r.appearance.look);
      if (!layer) return;
      const radius = mm(r.appearance.diameterMm / 2);
      const radiusMm = r.appearance.diameterMm / 2;
      let k = next.get(r.appearance.look) ?? 0;
      const write = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, half: 0 | 1) => {
        this.segmentMatrix(ax, ay, az, bx, by, bz, radius);
        layer.pool.mesh.setMatrixAt(k, this.m);
        layer.route[k] = ri;
        layer.half[k] = half;
        k++;
        const j = 6 * seg;
        const p = this.segPoints;
        p[j] = ax;
        p[j + 1] = ay;
        p[j + 2] = az;
        p[j + 3] = bx;
        p[j + 4] = by;
        p[j + 5] = bz;
        this.segRadius[seg] = radiusMm;
        this.segRoute[seg] = ri;
        seg++;
      };
      forEachRouteSegment(r.baked.points, write);
      const coil = coils[ri];
      if (coil && r.baked.coil) {
        // The coil hangs in one half of the route: the half its point is in.
        const half = halfAt(r.baked.points, r.baked.coil.at);
        for (let i = 3; i + 2 < coil.length; i += 3) {
          write(coil[i - 3], coil[i - 2], coil[i - 1], coil[i], coil[i + 1], coil[i + 2], half);
        }
      }
      next.set(r.appearance.look, k);
    });
    this.segCount = seg;
    this.bvhDirty = true;
    this.readTint();
    for (const layer of this.looks.values()) {
      layer.pool.mesh.instanceMatrix.needsUpdate = true;
      this.writeColours(layer);
    }
    this.writeSleeves();
    this.applyScene();
  }

  /** A route's tint colour at one end: its conductor's, the unknown colour for a cable, or −1 (no tint). */
  private tintColour(connection: number | null, end: 'a' | 'b'): number {
    if (this.tint === null) return -1;
    return connection === null ? this.tint.unknownColour : this.tint.colour(connection, end);
  }

  /** Reads the tint's colours for every route (after a re-bake: the route indices changed). */
  private readTint(): void {
    if (this.tint === null) return;
    for (let r = 0; r < this.routes.length; r++) {
      const c = this.routes[r].connection;
      this.tintA[r] = this.tintColour(c, 'a');
      this.tintB[r] = this.tintColour(c, 'b');
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
      const pool = new InstancedPool('wires:sleeves', segmentGeometry, material, this.group, {
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
    const rebuilt = layer.pool.ensure(n);
    if (rebuilt) this.orderChildren();
    if (rebuilt || layer.pool.mesh.userData['colour'] !== appearance.colour) {
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

  /** The highlight sleeves over the hovered and selected routes' segments; none: no mesh. */
  private writeHighlight(): void {
    let count = 0;
    for (let i = 0; i < this.segCount; i++) if (this.highlightOf(i) !== 0) count++;
    if (count === 0) {
      if (this.highlightLayer) {
        this.disposeHighlight();
        this.applyScene();
      }
      return;
    }
    if (!this.highlightLayer) {
      const material = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false });
      material.name = 'wires:highlight';
      const pool = new InstancedPool('wires:highlight', segmentGeometry, material, this.group, {
        minCapacity: MIN_LOOK_CAPACITY,
        unpickable: false,
        shrink: true,
      });
      this.highlightLayer = { pool, material };
    }
    const pool = this.highlightLayer.pool;
    pool.ensure(count);
    const mesh = pool.mesh;
    const p = this.segPoints;
    let k = 0;
    for (let i = 0; i < this.segCount; i++) {
      const which = this.highlightOf(i);
      if (which === 0) continue;
      const j = 6 * i;
      const radius = mm(this.segRadius[i] * HIGHLIGHT_SCALE);
      this.segmentMatrix(p[j], p[j + 1], p[j + 2], p[j + 3], p[j + 4], p[j + 5], radius);
      mesh.setMatrixAt(k, this.m);
      mesh.setColorAt(k, this.colour.setHex(which === 2 ? HIGHLIGHT_SELECTED : HIGHLIGHT_HOVER));
      k++;
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.userData['wires'] = { hover: this.highlightHover, selected: this.highlightSelected, instances: count };
    this.applyScene();
  }

  /** Segment `i`'s highlight: 2 selected (wins), 1 hovered, 0 none. */
  private highlightOf(i: number): 0 | 1 | 2 {
    const owner = this.routes[this.segRoute[i]].baked.owner;
    if (owner === this.highlightSelected) return 2;
    return owner === this.highlightHover ? 1 : 0;
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

  private disposeLook(look: string): void {
    const layer = this.looks.get(look);
    if (!layer) return;
    layer.pool.dispose();
    layer.material.dispose();
    this.looks.delete(look);
  }

  private disposeSleeves(): void {
    if (!this.sleeves) return;
    this.sleeves.pool.dispose();
    this.sleeves.material.dispose();
    this.sleeves = null;
  }

  private disposeHighlight(): void {
    if (!this.highlightLayer) return;
    this.highlightLayer.pool.dispose();
    this.highlightLayer.material.dispose();
    this.highlightLayer = null;
  }

  private disposePreviewLayer(): void {
    if (!this.previewLayer) return;
    this.previewLayer.pool.dispose();
    this.previewLayer.material.dispose();
    this.previewLayer = null;
  }

  /**
   * The group's children in a fixed order, whatever the history (pools rebuilt, sleeves or the
   * preview added and removed): the looks by name, then `wires:sleeves`, `wires:highlight`, then
   * `wires:preview`.
   */
  private orderChildren(): void {
    const wanted = [...this.looks.keys()].sort().map((look) => (this.looks.get(look) as LookLayer).pool.mesh);
    if (this.sleeves) wanted.push(this.sleeves.pool.mesh);
    if (this.highlightLayer) wanted.push(this.highlightLayer.pool.mesh);
    if (this.previewLayer) wanted.push(this.previewLayer.pool.mesh);
    const children = this.group.children;
    if (children.length === wanted.length && wanted.every((m, i) => children[i] === m)) return;
    for (const mesh of wanted) {
      this.group.remove(mesh);
      this.group.add(mesh);
    }
  }

  /** In the scene only while some route, sleeve or preview is drawn; children in a fixed order. */
  private applyScene(): void {
    this.orderChildren();
    const wanted =
      this.looks.size > 0 || this.sleeves !== null || this.previewLayer !== null || this.highlightLayer !== null;
    if (wanted && !this.inScene) this.scene.add(this.group);
    else if (!wanted && this.inScene) this.scene.remove(this.group);
    this.inScene = wanted;
  }
}

/** A 6-sided unit cylinder (along +y, radius 1, height 1): one per pool mesh, disposed with it. */
function segmentGeometry(): BufferGeometry {
  const geometry = new CylinderGeometry(1, 1, 1, 6, 1);
  geometry.name = 'wires:segment';
  return geometry;
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
