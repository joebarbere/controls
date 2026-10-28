import {
  BoxGeometry,
  CylinderGeometry,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type BufferGeometry,
  type Material,
} from 'three/webgpu';
import { mm } from '@controls/units';
import { builtinProp, type CatalogRef, type PropSpec } from '@controls/world-model';

/*
 * Procedural prop recipes (plan §4.9 "procedural first"). Sizes come from the built-in prop table
 * in `@controls/world-model` (the same table placement snaps with); only the look lives here.
 * Geometry origin is the prop's min corner, matching the entity position convention: the prop spans
 * +x (width), +y (height) and +z (depth, standing off its mounting surface).
 */

/** Drawn for a ref this build doesn't know (a save from a newer build, a removed prop). */
export const UNKNOWN_PROP: PropSpec = {
  id: 'unknown',
  title: 'Unknown object',
  shape: 'box',
  sizeMm: { widthMm: 100, heightMm: 100, depthMm: 100 },
  kind: 'game-design',
  source: 'game-design: 100 mm placeholder cube for unresolved catalogue refs',
};

/** Surface colours (renderer-local look, not world data). */
const LOOK: Readonly<Record<string, { color: number; roughness: number; metalness: number }>> = {
  'prop.bench': { color: 0x6b5a48, roughness: 0.8, metalness: 0 }, // oiled hardwood
  'prop.box': { color: 0x9aa3ab, roughness: 0.5, metalness: 0.3 }, // painted steel enclosure
  'prop.crate': { color: 0xa67c52, roughness: 0.9, metalness: 0 }, // pine
  'prop.spool': { color: 0x3d6fb3, roughness: 0.6, metalness: 0 }, // plastic reel
  unknown: { color: 0xd04a9a, roughness: 0.7, metalness: 0 }, // deliberately loud
};

/** The spec to draw for a ref: the built-in prop, or {@link UNKNOWN_PROP}. */
export function propSpecFor(ref: CatalogRef): PropSpec {
  return builtinProp(ref) ?? UNKNOWN_PROP;
}

/** Geometry for a prop, in metres, with its origin at the min corner (see module comment). */
export function buildPropGeometry(spec: PropSpec): BufferGeometry {
  const w = mm(spec.sizeMm.widthMm);
  const h = mm(spec.sizeMm.heightMm);
  const d = mm(spec.sizeMm.depthMm);
  if (spec.shape === 'cylinder') {
    const geometry = new CylinderGeometry(Math.min(w, h) / 2, Math.min(w, h) / 2, d, 32);
    geometry.rotateX(Math.PI / 2); // axis along +z, the prop's depth
    geometry.translate(w / 2, h / 2, d / 2);
    return geometry;
  }
  const geometry = new BoxGeometry(w, h, d);
  geometry.translate(w / 2, h / 2, d / 2);
  return geometry;
}

export function buildPropMaterial(spec: PropSpec): Material {
  const look = LOOK[spec.id] ?? LOOK['unknown'];
  return new MeshStandardMaterial(look);
}

/** The placement ghost's look: translucent, unlit, never writes depth (it must not hide what it's over). */
export function buildGhostMaterial(): Material {
  return new MeshBasicMaterial({ color: 0x7fb8ff, transparent: true, opacity: 0.45, depthWrite: false });
}

interface Recipe {
  readonly spec: PropSpec;
  readonly geometry: BufferGeometry;
  readonly material: Material;
  users: number;
}

/**
 * Shared, reference-counted prop geometry and materials: every instance of a prop draws with one
 * geometry and one material, and the last release disposes them, so removing every entity returns
 * GPU memory to baseline. Keyed by `id@version`.
 */
export class PropRecipes {
  private readonly recipes = new Map<string, Recipe>();

  /** Number of live recipes (for disposal tests). */
  get size(): number {
    return this.recipes.size;
  }

  acquire(ref: CatalogRef): Recipe {
    const key = `${ref.id}@${ref.version}`;
    let recipe = this.recipes.get(key);
    if (!recipe) {
      const spec = propSpecFor(ref);
      recipe = { spec, geometry: buildPropGeometry(spec), material: buildPropMaterial(spec), users: 0 };
      this.recipes.set(key, recipe);
    }
    recipe.users++;
    return recipe;
  }

  release(ref: CatalogRef): void {
    const key = `${ref.id}@${ref.version}`;
    const recipe = this.recipes.get(key);
    if (!recipe) return;
    recipe.users--;
    if (recipe.users > 0) return;
    recipe.geometry.dispose();
    recipe.material.dispose();
    this.recipes.delete(key);
  }

  /** Disposes everything, whatever the counts (viewport teardown). */
  dispose(): void {
    this.recipes.forEach((r) => {
      r.geometry.dispose();
      r.material.dispose();
    });
    this.recipes.clear();
  }
}
