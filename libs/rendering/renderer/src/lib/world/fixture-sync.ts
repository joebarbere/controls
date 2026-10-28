/**
 * Draws a world's fixed level geometry (`world.fixtures`, F1.9) from world snapshots, by fixture id,
 * like `WorldSync` does for entities. Fixtures change only when a different level or save is loaded
 * (no command touches them), so a sync that sees the same array does nothing, and a changed fixture
 * is simply rebuilt. Never writes to the world.
 *
 * Each fixture is a group named by its id holding its recipe's meshes. Fixtures that can be focused
 * (everything but floors) are selectable, with their world-space snap target (if any) from
 * `fixtureSnapTarget` (`@controls/world-model`), the same one scripts snap to.
 */
import { Group, Mesh, type Object3D, type Scene } from 'three/webgpu';
import {
  fixtureFocusNormal,
  fixtureSnapTarget,
  quarterTurns,
  type Fixture,
  type FixtureId,
  type FixtureSpec,
  type World,
} from '@controls/world-model';
import type { RoomBoundsMm } from '../cameras/camera-math';
import { FixtureRecipes } from '../geometry/fixtures';
import { markSelectable } from '../picking/picker';
import type { SelectableInfo, SelectableKind } from '../picking/selection';
import { applyTransform } from './world-sync';

/** Selectable kind of each focusable fixture kind. */
const SELECTABLE_KIND: Partial<Record<FixtureSpec['kind'], SelectableKind>> = {
  backplate: 'backplate',
  'din-rail': 'din-rail',
  'stud-wall': 'wall',
  board: 'board',
  bench: 'bench',
};

/**
 * Work mode looks down at a bench top from this elevation (game-design: about how a standing person
 * sees a bench), and straight at walls, backplates and rails.
 */
export const BENCH_FOCUS_ELEVATION_DEG = 40;

interface Drawn {
  fixture: Fixture;
  readonly spec: FixtureSpec | null;
  readonly object: Group;
  readonly info: SelectableInfo | null;
}

const sameFixture = (a: Fixture, b: Fixture): boolean => JSON.stringify(a) === JSON.stringify(b);

export class FixtureSync {
  /** Parent of every fixture object; named so the scene-graph snapshot shows it. */
  readonly group = new Group();
  private readonly drawn = new Map<FixtureId, Drawn>();
  private last: readonly Fixture[] | null = null;

  constructor(
    private readonly scene: Scene,
    readonly recipes: FixtureRecipes = new FixtureRecipes(),
  ) {
    this.group.name = 'fixtures';
    scene.add(this.group);
  }

  /** Number of fixtures drawn. */
  get size(): number {
    return this.drawn.size;
  }

  objectOf(id: FixtureId): Object3D | undefined {
    return this.drawn.get(id)?.object;
  }

  /** Selectable fixtures and their infos, in fixture id order. */
  selectables(): Array<{ root: Object3D; info: SelectableInfo }> {
    return [...this.drawn.values()].flatMap((d) => (d.info ? [{ root: d.object, info: d.info }] : []));
  }

  /** The fixtures last synced, as the world has them (for `worldSnapTargets`). */
  worldFixtures(): { readonly fixtures: readonly Fixture[] } {
    return { fixtures: this.last ?? [] };
  }

  /**
   * The placement picker's roots, in fixture id order: every selectable fixture, not only those
   * with a snap target, so a fixture without one (the backboard) still blocks the studs behind it.
   * A hit on it is on no target, so the ghost hides.
   */
  surfaceRoots(): Object3D[] {
    return this.selectables().map((s) => s.root);
  }

  /**
   * The walkable area: the first floor fixture's extent (quarter-turn yaws only), or `null` if the
   * world has no floor.
   */
  room(): RoomBoundsMm | null {
    for (const { fixture, spec } of this.drawn.values()) {
      const turns = quarterTurns(fixture.transform.orientationMdeg);
      if (spec?.kind !== 'floor' || turns === null) continue;
      const p = fixture.transform.positionMm;
      const [dx, dz] = turns % 2 === 0 ? [spec.widthMm, spec.depthMm] : [spec.depthMm, spec.widthMm];
      // Corner opposite the origin after the turn: +x/+z for 0, then rotating (x, z) → (z, -x).
      const sx = turns === 0 || turns === 1 ? 1 : -1;
      const sz = turns === 0 || turns === 3 ? 1 : -1;
      const x1 = p.x + sx * dx;
      const z1 = p.z + sz * dz;
      return {
        minXMm: Math.min(p.x, x1),
        maxXMm: Math.max(p.x, x1),
        minZMm: Math.min(p.z, z1),
        maxZMm: Math.max(p.z, z1),
        floorYMm: p.y,
      };
    }
    return null;
  }

  /** Draws `world.fixtures`. Returns whether anything changed (rebuild the pickers if so). */
  sync(world: World): boolean {
    if (world.fixtures === this.last) return false;
    this.last = world.fixtures;
    let changed = false;
    const seen = new Set<FixtureId>();
    for (const fixture of world.fixtures) {
      seen.add(fixture.id);
      const drawn = this.drawn.get(fixture.id);
      if (drawn && (drawn.fixture === fixture || sameFixture(drawn.fixture, fixture))) {
        drawn.fixture = fixture;
        continue;
      }
      if (drawn) this.remove(fixture.id);
      this.add(fixture);
      changed = true;
    }
    for (const id of [...this.drawn.keys()]) {
      if (seen.has(id)) continue;
      this.remove(id);
      changed = true;
    }
    if (changed) this.group.updateMatrixWorld(true);
    return changed;
  }

  /** Removes every fixture object and releases its recipe (viewport teardown). */
  dispose(): void {
    for (const id of [...this.drawn.keys()]) this.remove(id);
    this.recipes.dispose();
    this.scene.remove(this.group);
    this.last = null;
  }

  private add(fixture: Fixture): void {
    const recipe = this.recipes.acquire(fixture.ref);
    const object = new Group();
    object.name = fixture.id;
    for (const part of recipe.parts) {
      const mesh = new Mesh(part.geometry, part.material);
      mesh.name = `${fixture.id}:${part.name}`;
      object.add(mesh);
    }
    applyTransform(object, fixture);
    const info = this.selectableInfo(fixture, recipe.spec);
    if (info) markSelectable(object, info);
    this.group.add(object);
    this.drawn.set(fixture.id, { fixture, spec: recipe.spec, object, info });
  }

  private selectableInfo(fixture: Fixture, spec: FixtureSpec | null): SelectableInfo | null {
    const kind = spec && SELECTABLE_KIND[spec.kind];
    const focusNormal = fixtureFocusNormal(fixture);
    if (!spec || !kind || !focusNormal) return null;
    const snapTarget = fixtureSnapTarget(fixture) ?? undefined;
    return {
      id: fixture.id,
      kind,
      label: labelOf(spec, fixture.id),
      focusNormal,
      ...(spec.kind === 'bench' ? { focusElevationDeg: BENCH_FOCUS_ELEVATION_DEG } : {}),
      ...(snapTarget ? { snapTarget } : {}),
    };
  }

  private remove(id: FixtureId): void {
    const drawn = this.drawn.get(id);
    if (!drawn) return;
    this.group.remove(drawn.object);
    this.recipes.release(drawn.fixture.ref);
    this.drawn.delete(id);
  }
}

/** HUD label: the kind's title, numbered like its id (`din-rail-1` → `DIN rail 1 (TS35, 500 mm)`). */
export function labelOf(spec: FixtureSpec, id: string): string {
  const n = /-(\d+)$/.exec(id)?.[1];
  const title = n ? `${spec.title.replace(/ \(.*\)$/, '')} ${n}` : spec.title.replace(/ \(.*\)$/, '');
  switch (spec.kind) {
    case 'backplate':
      return `${title} ${spec.widthMm} × ${spec.heightMm}`;
    case 'din-rail':
      return `${title} (TS35, ${spec.lengthMm} mm)`;
    case 'stud-wall':
      return `${title} (2×4 at 16 in o.c.)`;
    default:
      return title;
  }
}
