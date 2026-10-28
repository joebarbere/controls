/**
 * Draws the world's entities from world snapshots (plan §4.9: the scene is a projection of the
 * world model). {@link WorldSync.sync} diffs a snapshot against what is drawn, **by entity id**:
 * new ids are added, changed transforms or refs are updated, missing ids are removed. It never
 * writes to the world; snapshots are immutable, so an unchanged entity is skipped by identity.
 */
import { Group, Mesh, type Object3D, type Scene } from 'three/webgpu';
import { mdegToRadians, mm } from '@controls/units';
import type { CatalogRef, Entity, EntityId, World } from '@controls/world-model';
import { PropRecipes } from '../geometry/props';
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
}

const sameRef = (a: CatalogRef, b: CatalogRef): boolean => a.id === b.id && a.version === b.version;

export class WorldSync {
  /** Parent of every entity object; named so the scene-graph snapshot shows it. */
  readonly group = new Group();
  private readonly drawn = new Map<EntityId, Drawn>();

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
    const object = new Mesh(recipe.geometry, recipe.material);
    object.name = entitySelectableId(entity.id);
    applyTransform(object, entity);
    markSelectable(object, {
      id: entitySelectableId(entity.id),
      kind: 'prop',
      label: `${recipe.spec.title} #${entity.id}`,
      entityId: entity.id,
    });
    this.group.add(object);
    this.drawn.set(entity.id, { entity, object });
  }

  private remove(id: EntityId): void {
    const drawn = this.drawn.get(id);
    if (!drawn) return;
    this.group.remove(drawn.object);
    this.recipes.release(drawn.entity.ref);
    this.drawn.delete(id);
  }
}

/**
 * Integer mm and millidegrees → scene metres and radians, at draw time only. Euler order `YXZ` is
 * ADR 0007's intrinsic yaw (about +y), then pitch (new +x), then roll (new +z).
 */
export function applyTransform(object: Object3D, entity: Entity): void {
  const { positionMm: p, orientationMdeg: o } = entity.transform;
  object.position.set(mm(p.x), mm(p.y), mm(p.z));
  object.rotation.set(mdegToRadians(o.pitch), mdegToRadians(o.yaw), mdegToRadians(o.roll), 'YXZ');
}
