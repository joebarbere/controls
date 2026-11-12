import {
  BoxGeometry,
  CylinderGeometry,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type BufferGeometry,
  type Material,
} from 'three/webgpu';
import { mm } from '@controls/units';
import {
  type BodyState,
  BUILTIN_CATALOG,
  type Catalog,
  cutLengthMm,
  deviceBodySizeMm,
  type DeviceDefinition,
  racewayOf,
} from '@controls/catalog';
import { builtinProp, type CatalogRef, type PropSpec } from '@controls/world-model';
import {
  buildDeviceCover,
  buildDeviceEntries,
  buildDeviceGeometry,
  buildDeviceLever,
  buildDeviceMaterials,
  deviceDefinitionFor,
  mergeEntryGeometries,
  deviceLabel,
  type DeviceEntryPart,
  type DeviceLever,
} from './devices';

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

/** The spec to draw for a ref: the built-in prop, or {@link UNKNOWN_PROP} (catalogue devices: `PropRecipes`). */
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
  /** One material, or one per geometry group (catalogue devices, `devices.ts`). */
  readonly material: Material | Material[];
  /** The fictional brand and model a device carries (`userData.label`); `null` for props. */
  readonly label: string | null;
  /** The catalogue model kind a device draws (`lamp.incandescent`, …); `null` for props. */
  readonly modelKind: string | null;
  /** The lever (a switch's lever, a breaker's handle; its geometry is owned by the recipe), or `null`. */
  readonly lever: DeviceLever | null;
  /** An enclosure's entries (geometry owned by the recipe), in catalogue order; empty for anything else. */
  readonly entries: readonly DeviceEntryPart[];
  /** Every entry merged (owned by the recipe): what a new enclosure, every entry closed, draws; else `null`. */
  readonly entriesAll: BufferGeometry | null;
  /** Whether it is an enclosure: placement aims at it as a surface (its mounts). */
  readonly enclosure: boolean;
  /** Whether it is a raceway: conduit placement aims at it as a surface (its free ends). */
  readonly raceway: boolean;
  /** A duct's cover (owned by the recipe), drawn as the `cover` child when `coverOn`; else `null`. */
  readonly cover: BufferGeometry | null;
  users: number;
}

/** A catalogue device as a prop spec: its title and (cut) body size, for labels, bounds and the selectable. */
function deviceSpec(def: DeviceDefinition, state: BodyState): PropSpec {
  return {
    id: def.id,
    title: def.title,
    shape: 'box',
    sizeMm: deviceBodySizeMm(def, state) as NonNullable<DeviceDefinition['sizeMm']>,
    kind: 'game-design',
    source: `catalogue entry ${def.id}@${def.version} (its sources)`,
  };
}

function buildRecipe(ref: CatalogRef, catalog: Catalog, state: BodyState): Recipe {
  const prop = builtinProp(ref);
  const device = prop === undefined ? deviceDefinitionFor(ref, catalog) : undefined;
  if (device !== undefined) {
    const entries = buildDeviceEntries(device);
    return {
      spec: deviceSpec(device, state),
      geometry: buildDeviceGeometry(device, state),
      material: buildDeviceMaterials(device),
      label: deviceLabel(device),
      modelKind: device.model.kind,
      lever: buildDeviceLever(device),
      entries,
      entriesAll: entries.length > 0 ? mergeEntryGeometries(entries.map((e) => e.geometry)) : null,
      enclosure: device.enclosure !== null,
      raceway: racewayOf(device) !== null,
      cover: buildDeviceCover(device, state),
      users: 0,
    };
  }
  const spec = prop ?? UNKNOWN_PROP;
  return {
    spec,
    geometry: buildPropGeometry(spec),
    material: buildPropMaterial(spec),
    label: null,
    modelKind: null,
    lever: null,
    entries: [],
    entriesAll: null,
    enclosure: false,
    raceway: false,
    cover: null,
    users: 0,
  };
}

function disposeRecipe(recipe: Recipe): void {
  recipe.geometry.dispose();
  recipe.lever?.geometry.dispose();
  recipe.entries.forEach((e) => e.geometry.dispose());
  recipe.entriesAll?.dispose();
  recipe.cover?.dispose();
  if (Array.isArray(recipe.material)) recipe.material.forEach((m) => m.dispose());
  else recipe.material.dispose();
}

/**
 * Shared, reference-counted prop and device geometry and materials: every instance of a prop (or of a
 * catalogue device with a recipe, `devices.ts`) draws with one geometry and its materials, and the last
 * release disposes them, so removing every entity returns GPU memory to baseline. Keyed by
 * `id@version`, and for a cut-to-length raceway also by its cut length (`id@version#lengthMm`, F3.5
 * part 2): ducts and sticks cut alike share one recipe; each new length builds one more.
 */
export class PropRecipes {
  private readonly recipes = new Map<string, Recipe>();

  constructor(private readonly catalog: Catalog = BUILTIN_CATALOG) {}

  /** Number of live recipes (for disposal tests). */
  get size(): number {
    return this.recipes.size;
  }

  /** The cache key of `ref` drawn with commanded `state` (see the class comment). */
  keyOf(ref: CatalogRef, state: BodyState = null): string {
    const device = this.catalog.device(ref);
    const length = device ? cutLengthMm(device, state) : null;
    return length === null ? `${ref.id}@${ref.version}` : `${ref.id}@${ref.version}#${length}`;
  }

  /** The recipe for `ref` with commanded `state` (a cut part's length; `null`: its default length). */
  acquire(ref: CatalogRef, state: BodyState = null): Recipe {
    const key = this.keyOf(ref, state);
    let recipe = this.recipes.get(key);
    if (!recipe) {
      recipe = buildRecipe(ref, this.catalog, state);
      this.recipes.set(key, recipe);
    }
    recipe.users++;
    return recipe;
  }

  /** Releases what {@link acquire} gave for the same `ref` and `state`. */
  release(ref: CatalogRef, state: BodyState = null): void {
    const key = this.keyOf(ref, state);
    const recipe = this.recipes.get(key);
    if (!recipe) return;
    recipe.users--;
    if (recipe.users > 0) return;
    disposeRecipe(recipe);
    this.recipes.delete(key);
  }

  /** Disposes everything, whatever the counts (viewport teardown). */
  dispose(): void {
    this.recipes.forEach(disposeRecipe);
    this.recipes.clear();
  }
}
