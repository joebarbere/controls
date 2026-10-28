import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BoxGeometry,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  type BufferGeometry,
  type Material,
} from 'three/webgpu';
import { mm } from '@controls/units';
import {
  fixtureSpec,
  studCentres,
  WALL_STUD_DEPTH,
  WALL_STUD_THICKNESS,
  type CatalogRef,
  type FixtureSpec,
} from '@controls/world-model';
import { buildDinRailGeometry } from './din-rail';

/*
 * Procedural fixture recipes (F1.9, plan §4.9 "procedural first"): the workshop's floor, stud wall,
 * plywood backboard, backplate, DIN rails and bench. Sizes come from `FIXTURE_SPECS` in
 * `@controls/world-model` (the table placement snaps with) and the sourced constants; only the look
 * lives here. Each recipe's geometry is in the kind's local frame (see `fixtures.ts` in world-model),
 * in metres, so a fixture object only needs its transform.
 */

/** One mesh of a fixture: geometry and material are shared by every fixture with the same ref. */
export interface FixturePart {
  readonly name: string;
  readonly geometry: BufferGeometry;
  readonly material: Material;
}

export interface FixtureRecipe {
  /** The spec drawn, or `null` for an unknown ref (drawn as nothing). */
  readonly spec: FixtureSpec | null;
  readonly parts: readonly FixturePart[];
}

/** Surface looks (renderer-local, not world data). */
const look = {
  concrete: () => new MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.9 }), // sealed concrete
  lumber: () => new MeshStandardMaterial({ color: 0xc9a76f, roughness: 0.85 }), // kiln-dried SPF framing
  plywood: () => new MeshStandardMaterial({ color: 0xb98d5a, roughness: 0.8 }),
  plate: () => new MeshStandardMaterial({ color: 0xd9dcdf, metalness: 0.2, roughness: 0.6 }), // white-painted sub-panel
  zinc: () => new MeshStandardMaterial({ color: 0xc4cad0, metalness: 0.45, roughness: 0.4 }), // zinc-plated steel
  hardwood: () => new MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.7 }), // oiled bench top
  steel: () => new MeshStandardMaterial({ color: 0x4a5560, metalness: 0.5, roughness: 0.5 }), // painted bench frame
  /**
   * Snap proxies: picked by the placement ray but never drawn (`visible: false` on the material;
   * the mesh itself stays visible, because BVH raycasts skip invisible objects).
   */
  proxy: () => new MeshBasicMaterial({ visible: false }),
};

/** An axis-aligned box spanning [x0, x1] × [y0, y1] × [z0, z1] (millimetres) as geometry in metres. */
export function boxBetween(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): BufferGeometry {
  const g = new BoxGeometry(mm(x1 - x0), mm(y1 - y0), mm(z1 - z0));
  g.translate(mm((x0 + x1) / 2), mm((y0 + y1) / 2), mm((z0 + z1) / 2));
  return g;
}

/** Merges parts and disposes the inputs (the merged copy is all that is kept). */
function merged(parts: BufferGeometry[]): BufferGeometry {
  const g = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  if (!g) throw new Error('fixture geometry could not be merged');
  return g;
}

/** A vertical plane over u ∈ [0, w], v ∈ [0, h] at z = 0, facing +z (a snap proxy). */
function facePlane(widthMm: number, heightMm: number): BufferGeometry {
  const g = new PlaneGeometry(mm(widthMm), mm(heightMm));
  g.translate(mm(widthMm / 2), mm(heightMm / 2), 0);
  return g;
}

function buildParts(spec: FixtureSpec): FixturePart[] {
  switch (spec.kind) {
    case 'floor': {
      const g = new PlaneGeometry(mm(spec.widthMm), mm(spec.depthMm));
      g.rotateX(-Math.PI / 2); // faces +y
      g.translate(mm(spec.widthMm / 2), 0, mm(spec.depthMm / 2));
      return [{ name: 'floor', geometry: g, material: look.concrete() }];
    }
    case 'board':
      return [
        {
          name: 'board',
          geometry: boxBetween(0, 0, -spec.thicknessMm, spec.widthMm, spec.heightMm, 0),
          material: look.plywood(),
        },
      ];
    case 'backplate':
      return [
        {
          name: 'plate',
          geometry: boxBetween(0, 0, -spec.thicknessMm, spec.widthMm, spec.heightMm, 0),
          material: look.plate(),
        },
      ];
    case 'din-rail': {
      const g = buildDinRailGeometry(spec.lengthMm); // centred on x, back at z = 0
      g.translate(mm(spec.lengthMm / 2), 0, 0); // origin at the rail's left end
      return [{ name: 'rail', geometry: g, material: look.zinc() }];
    }
    case 'stud-wall': {
      // Studs on the 16 in layout (the same centres wall-stud snapping uses), a single bottom plate
      // and a double top plate, all dressed 2×4 (1-1/2 × 3-1/2 in) from the sourced constants.
      const t = WALL_STUD_THICKNESS.valueMm;
      const d = WALL_STUD_DEPTH.valueMm;
      const { widthMm: w, heightMm: h } = spec;
      const studTop = h - 2 * t;
      const pieces = studCentres({
        kind: 'wall-studs',
        id: '',
        frame: { origin: { x: 0, y: 0, z: 0 }, normal: '+z' },
        widthMm: w,
        heightMm: h,
        firstStudCentreMm: spec.firstStudCentreMm,
      }).map((c) => boxBetween(c - t / 2, t, -d, c + t / 2, studTop, 0));
      pieces.push(boxBetween(0, 0, -d, w, t, 0), boxBetween(0, studTop, -d, w, h, 0));
      return [
        { name: 'framing', geometry: merged(pieces), material: look.lumber() },
        { name: 'snap-plane', geometry: facePlane(w, h), material: look.proxy() },
      ];
    }
    case 'bench': {
      // game-design: 60 mm square legs inset 40 mm, a 30 mm apron below the top, a lower shelf.
      const { widthMm: w, heightMm: h, depthMm: d, topThicknessMm: top } = spec;
      const leg = 60;
      const inset = 40;
      const under = h - top;
      const legs = [
        [inset, inset],
        [w - inset - leg, inset],
        [inset, d - inset - leg],
        [w - inset - leg, d - inset - leg],
      ].map(([x, z]) => boxBetween(x, 0, z, x + leg, under, z + leg));
      legs.push(boxBetween(inset, under - 30, inset, w - inset, under, d - inset));
      return [
        { name: 'top', geometry: boxBetween(0, under, 0, w, h, d), material: look.hardwood() },
        { name: 'frame', geometry: merged(legs), material: look.steel() },
        { name: 'shelf', geometry: boxBetween(inset, 150, inset, w - inset, 170, d - inset), material: look.plywood() },
      ];
    }
  }
}

interface Entry {
  readonly recipe: FixtureRecipe;
  users: number;
}

/**
 * Shared, reference-counted fixture geometry and materials, keyed by `id@version` (two DIN rails
 * draw with one geometry). The last release disposes them, so loading a level without a fixture
 * returns its GPU memory.
 */
export class FixtureRecipes {
  private readonly entries = new Map<string, Entry>();

  /** Number of live recipes (for disposal tests). */
  get size(): number {
    return this.entries.size;
  }

  acquire(ref: CatalogRef): FixtureRecipe {
    const key = `${ref.id}@${ref.version}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const spec = fixtureSpec(ref) ?? null;
      entry = { recipe: { spec, parts: spec ? buildParts(spec) : [] }, users: 0 };
      this.entries.set(key, entry);
    }
    entry.users++;
    return entry.recipe;
  }

  release(ref: CatalogRef): void {
    const key = `${ref.id}@${ref.version}`;
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.users--;
    if (entry.users > 0) return;
    disposeRecipe(entry.recipe);
    this.entries.delete(key);
  }

  /** Disposes everything, whatever the counts (viewport teardown). */
  dispose(): void {
    this.entries.forEach((e) => disposeRecipe(e.recipe));
    this.entries.clear();
  }
}

function disposeRecipe(recipe: FixtureRecipe): void {
  recipe.parts.forEach((p) => {
    p.geometry.dispose();
    p.material.dispose();
  });
}
