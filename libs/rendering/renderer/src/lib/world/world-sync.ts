/**
 * Draws the world's entities from world snapshots (plan §4.9: the scene is a projection of the
 * world model). {@link WorldSync.sync} diffs a snapshot against what is drawn, **by entity id**:
 * new ids are added, changed transforms, refs and drawn state (a switch's lever) are updated, missing
 * ids are removed. It never writes to the world; snapshots are immutable, so an unchanged entity is
 * skipped by identity.
 *
 * Lamps (F2.5) glow by sim output given to {@link WorldSync.setLampOutputs}, through the display curve
 * and the validity rule (`sim/lamp-display`). Each lamp entity draws with its own clone of the recipe's
 * bulb material (the other slots stay shared), disposed when the lamp is removed.
 */
import { Group, Mesh, type Material, type MeshStandardMaterial, type Object3D, type Scene } from 'three/webgpu';
import { mdegToRadians, mm } from '@controls/units';
import type { CatalogRef, Entity, EntityId, Transform, World } from '@controls/world-model';
import { applyBulbLook, BULB_SLOT, LAMP_KIND, leverAngle, SWITCH_KIND } from '../geometry/devices';
import { PropRecipes } from '../geometry/props';
import { lampDrawLevel, lampDrawStatus, type DrawnLamp, type LampOutput } from '../sim/lamp-display';
import { markSelectable } from '../picking/picker';
import type { SelectableInfo } from '../picking/selection';

/** Selectable id of an entity's scene object. */
export const entitySelectableId = (id: EntityId): string => `entity-${id}`;

/** What a sync changed, so the caller can rebuild or refit the picker only when needed. */
export interface SyncResult {
  /** Entities were added or removed (rebuild the picking BVH and the selectable list). */
  readonly membershipChanged: boolean;
  /** Some entity moved or turned (refit the picking BVH). */
  readonly transformsChanged: boolean;
}

interface Drawn {
  entity: Entity;
  readonly object: Mesh;
  /** A lamp's own bulb material (a clone of the recipe's), or `null`. */
  readonly bulb: MeshStandardMaterial | null;
  /** What a lamp is drawn as now (`userData.lamp`), or `null` for other entities. */
  lamp: DrawnLamp | null;
  /** A switch's lever mesh (child of `object`), or `null`. */
  readonly lever: Mesh | null;
}

/** Lamp outputs by entity id (see {@link WorldSync.setLampOutputs}). */
export type LampOutputs = ReadonlyMap<EntityId, LampOutput>;

const NO_OUTPUTS: LampOutputs = new Map();

const sameRef = (a: CatalogRef, b: CatalogRef): boolean => a.id === b.id && a.version === b.version;

export class WorldSync {
  /** Parent of every entity object; named so the scene-graph snapshot shows it. */
  readonly group = new Group();
  private readonly drawn = new Map<EntityId, Drawn>();
  private lampOutputs: LampOutputs = NO_OUTPUTS;

  constructor(
    private readonly scene: Scene,
    readonly recipes: PropRecipes = new PropRecipes(),
  ) {
    this.group.name = 'world';
    scene.add(this.group);
  }

  /** Number of entities drawn. */
  get size(): number {
    return this.drawn.size;
  }

  /** The scene object drawing entity `id`. */
  objectOf(id: EntityId): Object3D | undefined {
    return this.drawn.get(id)?.object;
  }

  /** The drawn entity `id` (the snapshot it was last synced from). */
  entityOf(id: EntityId): Entity | undefined {
    return this.drawn.get(id)?.entity;
  }

  /** Selectable roots and their infos, in entity id order. */
  selectables(): Array<{ root: Object3D; info: SelectableInfo }> {
    return [...this.drawn.values()].map((d) => ({ root: d.object, info: d.object.userData['selectable'] }));
  }

  /** What lamp `id` is drawn as, or `undefined` when it is not a drawn lamp. */
  lampOf(id: EntityId): DrawnLamp | undefined {
    return this.drawn.get(id)?.lamp ?? undefined;
  }

  /**
   * Lamp sim outputs by entity id, decoded from the lamps' device records by the host. Each lamp is
   * drawn by the validity rule: its display level when `solved` or `unsettled` (marked as such),
   * "unknown" (no glow, a distinct tint, never an off lamp) when `unsolved` or `singular` or when it
   * has no entry. Kept for lamps added later. Returns whether any drawn level or status changed, so the
   * caller invalidates only then (ADR 0011 §9.2). No allocation unless something changed.
   */
  setLampOutputs(outputs: LampOutputs): boolean {
    this.lampOutputs = outputs;
    let changed = false;
    for (const drawn of this.drawn.values()) if (this.applyLamp(drawn)) changed = true;
    return changed;
  }

  sync(world: World): SyncResult {
    let membershipChanged = false;
    let transformsChanged = false;
    const seen = new Set<EntityId>();
    for (const entity of world.entities) {
      seen.add(entity.id);
      const drawn = this.drawn.get(entity.id);
      if (!drawn) {
        this.add(entity);
        membershipChanged = true;
      } else if (drawn.entity !== entity) {
        if (!sameRef(drawn.entity.ref, entity.ref)) {
          this.remove(entity.id);
          this.add(entity);
          membershipChanged = true;
        } else {
          drawn.entity = entity;
          applyTransform(drawn.object, entity);
          applyLever(drawn);
          transformsChanged = true;
        }
      }
    }
    for (const id of [...this.drawn.keys()]) {
      if (seen.has(id)) continue;
      this.remove(id);
      membershipChanged = true;
    }
    if (membershipChanged || transformsChanged) this.group.updateMatrixWorld(true);
    return { membershipChanged, transformsChanged };
  }

  /** Removes every entity object and releases its recipe (viewport teardown). */
  dispose(): void {
    for (const id of [...this.drawn.keys()]) this.remove(id);
    this.recipes.dispose();
    this.scene.remove(this.group);
  }

  private add(entity: Entity): void {
    const recipe = this.recipes.acquire(entity.ref);
    // A lamp draws its bulb with its own material, so it glows on its own; other slots stay shared.
    let bulb: MeshStandardMaterial | null = null;
    let material = recipe.material;
    if (recipe.modelKind === LAMP_KIND && Array.isArray(recipe.material)) {
      bulb = (recipe.material[BULB_SLOT] as MeshStandardMaterial).clone();
      material = recipe.material.slice();
      material[BULB_SLOT] = bulb;
    }
    const object = new Mesh(recipe.geometry, material);
    object.name = entitySelectableId(entity.id);
    if (recipe.label !== null) object.userData['label'] = recipe.label;
    applyTransform(object, entity);
    let lever: Mesh | null = null;
    if (recipe.modelKind === SWITCH_KIND && recipe.lever !== null && Array.isArray(recipe.material)) {
      lever = new Mesh(recipe.lever.geometry, recipe.material[recipe.lever.slot] as Material);
      lever.name = 'lever';
      const p = recipe.lever.pivotMm;
      lever.position.set(mm(p.x), mm(p.y), mm(p.z));
      object.add(lever);
    }
    markSelectable(object, {
      id: entitySelectableId(entity.id),
      kind: recipe.label !== null ? 'device' : 'prop',
      label: `${recipe.spec.title} #${entity.id}`,
      entityId: entity.id,
    });
    this.group.add(object);
    const drawn: Drawn = { entity, object, bulb, lamp: null, lever };
    applyLever(drawn);
    this.applyLamp(drawn);
    this.drawn.set(entity.id, drawn);
  }

  /** Draws a lamp's current output; `true` when its drawn level or status changed. */
  private applyLamp(drawn: Drawn): boolean {
    if (drawn.bulb === null) return false;
    const output = this.lampOutputs.get(drawn.entity.id);
    const status = lampDrawStatus(output);
    const level = lampDrawLevel(output);
    if (drawn.lamp !== null && drawn.lamp.level === level && drawn.lamp.status === status) return false;
    drawn.lamp = { level, status };
    drawn.object.userData['lamp'] = drawn.lamp;
    applyBulbLook(drawn.bulb, drawn.lamp);
    return true;
  }

  private remove(id: EntityId): void {
    const drawn = this.drawn.get(id);
    if (!drawn) return;
    this.group.remove(drawn.object);
    drawn.bulb?.dispose();
    this.recipes.release(drawn.entity.ref);
    this.drawn.delete(id);
  }
}

/**
 * Integer mm and millidegrees → scene metres and radians, at draw time only. Euler order `YXZ` is
 * ADR 0007's intrinsic yaw (about +y), then pitch (new +x), then roll (new +z).
 */
export function applyTransform(object: Object3D, placed: { readonly transform: Transform }): void {
  const { positionMm: p, orientationMdeg: o } = placed.transform;
  object.position.set(mm(p.x), mm(p.y), mm(p.z));
  object.rotation.set(mdegToRadians(o.pitch), mdegToRadians(o.yaw), mdegToRadians(o.roll), 'YXZ');
}

/** Turns a switch's lever to the entity's commanded state (`state.closed === true` is closed). */
function applyLever(drawn: Drawn): void {
  if (drawn.lever === null) return;
  const closed = drawn.entity.state['closed'] === true;
  drawn.lever.rotation.x = leverAngle(closed);
  drawn.object.userData['switch'] = { closed };
}
