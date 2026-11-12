/**
 * Draws the world's entities from world snapshots (plan §4.9: the scene is a projection of the
 * world model). {@link WorldSync.sync} diffs a snapshot against what is drawn, **by entity id**:
 * new ids are added, changed transforms, refs and drawn state (a switch's lever, a breaker's handle,
 * an enclosure's open entries) are updated, missing ids are removed. It never writes to the world; snapshots are immutable, so an unchanged entity is
 * skipped by identity.
 *
 * Lamps (F2.5) glow by sim output given to {@link WorldSync.setLampOutputs}, through the display curve
 * and the validity rule (`sim/lamp-display`). Each lamp entity draws with its own clone of the recipe's
 * bulb material (the other slots stay shared), disposed when the lamp is removed.
 *
 * Enclosures (F3.5) draw their catalogue entries as two child meshes (`entries:closed`,
 * `entries:open`) from the commanded `openEntries` bit set, so a box costs at most two draws for its
 * entries however many it has. With every entry closed the closed mesh draws the recipe's shared
 * merged geometry; once one is open the entity owns two merged geometries, rebuilt only when the bits
 * change and disposed on the next change or on removal. Entry meshes are never picked (the body is).
 * Enclosure roots are also what placement aims at ({@link WorldSync.enclosureRoots}).
 */
import {
  Group,
  Mesh,
  type BufferGeometry,
  type Material,
  type MeshStandardMaterial,
  type Object3D,
  type Scene,
} from 'three/webgpu';
import { mdegToRadians, mm } from '@controls/units';
import type { CatalogRef, Entity, EntityId, Transform, World } from '@controls/world-model';
import {
  applyBulbLook,
  BULB_SLOT,
  CLOSED_ENTRY_SLOT,
  entryIsOpen,
  LAMP_KIND,
  leverAngle,
  mergeEntryGeometries,
  OPENING_SLOT,
  type DeviceEntryPart,
  type DeviceLever,
} from '../geometry/devices';
import { PropRecipes } from '../geometry/props';
import { lampDrawLevel, lampDrawStatus, type DrawnLamp, type LampOutput } from '../sim/lamp-display';
import { markSelectable, UNPICKABLE_KEY } from '../picking/picker';
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
  /** A lever mesh (child of `object`: a switch's lever, a breaker's handle) and what turns it, or `null`. */
  readonly lever: { readonly mesh: Mesh; readonly def: DeviceLever } | null;
  /** An enclosure's entries, drawn closed and open, or `null`. */
  readonly entries: EntryDrawing | null;
  /** Whether it is an enclosure (placement aims at it). */
  readonly enclosure: boolean;
}

/** An enclosure's entries as two meshes: the closed ones and the open ones. */
interface EntryDrawing {
  readonly parts: readonly DeviceEntryPart[];
  /** Every entry merged: the recipe's, shared. */
  readonly all: BufferGeometry;
  readonly closed: Mesh;
  readonly open: Mesh;
  /** The bit set drawn, or `null` before the first draw. */
  bits: number | null;
  /** Merged geometries this entity owns for its current bits (disposed on change and removal). */
  owned: BufferGeometry[];
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

  /** The scene objects of the drawn enclosures, in entity id order: surfaces placement aims at (their mounts). */
  enclosureRoots(): Object3D[] {
    return [...this.drawn.values()].filter((d) => d.enclosure).map((d) => d.object);
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
          applyEntries(drawn);
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
    let lever: Drawn['lever'] = null;
    let entries: EntryDrawing | null = null;
    if (Array.isArray(recipe.material)) {
      const materials = recipe.material;
      if (recipe.lever !== null) {
        const mesh = new Mesh(recipe.lever.geometry, materials[recipe.lever.slot] as Material);
        mesh.name = 'lever';
        const p = recipe.lever.pivotMm;
        mesh.position.set(mm(p.x), mm(p.y), mm(p.z));
        object.add(mesh);
        lever = { mesh, def: recipe.lever };
      }
      if (recipe.entriesAll !== null) {
        const all = recipe.entriesAll;
        const mesh = (name: string, slot: number) => {
          const m = new Mesh(all, materials[slot] as Material);
          m.name = name;
          m.userData[UNPICKABLE_KEY] = true;
          m.raycast = () => undefined; // decoration: a pick lands on the body
          object.add(m);
          return m;
        };
        const closed = mesh('entries:closed', CLOSED_ENTRY_SLOT);
        const open = mesh('entries:open', OPENING_SLOT);
        entries = { parts: recipe.entries, all, closed, open, bits: null, owned: [] };
      }
    }
    markSelectable(object, {
      id: entitySelectableId(entity.id),
      kind: recipe.label !== null ? 'device' : 'prop',
      label: `${recipe.spec.title} #${entity.id}`,
      entityId: entity.id,
    });
    this.group.add(object);
    const drawn: Drawn = { entity, object, bulb, lamp: null, lever, entries, enclosure: recipe.enclosure };
    applyLever(drawn);
    applyEntries(drawn);
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
    drawn.entries?.owned.forEach((g) => g.dispose());
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

/**
 * Turns a lever to the entity's commanded state: a switch's by `state.closed`, a breaker's handle by
 * `state.on` (`true` leans it toward +y). Published as `userData.switch` / `userData.breaker`.
 */
function applyLever(drawn: Drawn): void {
  if (drawn.lever === null) return;
  const { stateKey, userKey } = drawn.lever.def;
  const value = drawn.entity.state[stateKey] === true;
  drawn.lever.mesh.rotation.x = leverAngle(value);
  drawn.object.userData[userKey] = { [stateKey]: value };
}

/**
 * Draws the entries open or closed from the entity's commanded `openEntries` bits: the closed ones in
 * one mesh, the open ones in the other. Nothing is rebuilt unless the bits changed. Published as
 * `userData.openEntries` (the open entry ids, catalogue order) for the scene-graph snapshot.
 */
function applyEntries(drawn: Drawn): void {
  const e = drawn.entries;
  if (e === null) return;
  const raw = drawn.entity.state['openEntries'];
  const bits = typeof raw === 'number' ? raw : 0;
  if (e.bits === bits) return;
  e.bits = bits;
  e.owned.forEach((g) => g.dispose());
  e.owned = [];
  const open = e.parts.filter((_, i) => entryIsOpen(bits, i));
  const closed = e.parts.filter((_, i) => !entryIsOpen(bits, i));
  const merged = (parts: readonly DeviceEntryPart[]): BufferGeometry => {
    const g = mergeEntryGeometries(parts.map((p) => p.geometry));
    e.owned.push(g);
    return g;
  };
  e.closed.geometry = open.length === 0 || closed.length === 0 ? e.all : merged(closed);
  e.closed.visible = closed.length > 0;
  e.open.geometry = open.length > 0 ? merged(open) : e.all;
  e.open.visible = open.length > 0;
  drawn.object.userData['openEntries'] = open.map((p) => p.id);
}
