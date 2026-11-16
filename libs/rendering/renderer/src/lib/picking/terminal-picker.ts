/**
 * The world's wireable terminals as screen points (F3.2 part 3, ADR 0017 §9). Each terminal is its
 * first method's entry point in the world (`terminalPlace` with `'auto'`, the point a route starts or
 * ends at), never a mesh. {@link TerminalPicker.sync} rebuilds the list when the world's entities
 * change (by identity); {@link TerminalPicker.project} projects it with the camera into a
 * {@link ScreenPoints} grid, and the pure `screen-terminals` maths picks from that. Occlusion is the
 * caller's (the controller's BVH picker).
 *
 * Order is canonical: entities by id, then each entity's terminals in catalogue order (a device's
 * terminals are contiguous). Terminals
 * `terminalPlace` can't place (no method, not at quarter-turns) are left out: no route can end there.
 */
import { Vector3, type Camera } from 'three/webgpu';
import type { Catalog } from '@controls/catalog';
import { mm } from '@controls/units';
import { terminalPlace, type EntityId, type PositionMm, type World } from '@controls/world-model';
import {
  emptyTerminalPick,
  groupPitchPx,
  pickScreenTerminal,
  ScreenPoints,
  type ScreenTerminalPick,
} from './screen-terminals';
import { terminalCycleOrder } from './terminal-order';

/** A terminal of an entity: what a route end names. */
export interface TerminalRef {
  readonly entity: EntityId;
  readonly terminal: string;
}

/** How far outside the canvas (CSS px) a terminal still counts as on screen (it may be picked at the edge). */
const SCREEN_MARGIN_PX = 16;

export class TerminalPicker {
  private entities: World['entities'] | null = null;
  private refs: TerminalRef[] = [];
  /** World integer mm, 3 per terminal. */
  private points = new Float64Array(0);
  /** Per entity: its terminals' range in the list, and its Tab order (lazily). */
  private readonly ranges = new Map<EntityId, { from: number; to: number; order: readonly string[] }>();
  readonly screen = new ScreenPoints();
  private readonly tmp = new Vector3();
  private readonly result: ScreenTerminalPick = emptyTerminalPick();

  constructor(private readonly catalog: Catalog) {}

  /** Number of wireable terminals in the world. */
  get count(): number {
    return this.refs.length;
  }

  /** Re-reads the world's terminals when its entities changed (by identity). Returns whether they did. */
  sync(world: World): boolean {
    if (world.entities === this.entities) return false;
    this.entities = world.entities;
    const refs: TerminalRef[] = [];
    const points: number[] = [];
    this.ranges.clear();
    for (const entity of world.entities) {
      const def = this.catalog.device(entity.ref);
      if (!def) continue;
      const from = refs.length;
      const wireable: typeof def.terminals = [];
      for (const t of def.terminals) {
        const place = terminalPlace(world, this.catalog, { entity: entity.id, terminal: t.id });
        if (!place.ok) continue;
        refs.push({ entity: entity.id, terminal: t.id });
        points.push(place.point.x, place.point.y, place.point.z);
        wireable.push(t);
      }
      if (refs.length > from) {
        this.ranges.set(entity.id, { from, to: refs.length, order: terminalCycleOrder(wireable) });
      }
    }
    this.refs = refs;
    this.points = Float64Array.from(points);
    this.screen.reset(0);
    this.screen.build();
    return true;
  }

  /** Terminal `i`'s ref. */
  ref(i: number): TerminalRef {
    return this.refs[i];
  }

  /** Terminal `i`'s point (world integer mm). */
  pointMm(i: number): PositionMm {
    return { x: this.points[3 * i], y: this.points[3 * i + 1], z: this.points[3 * i + 2] };
  }

  /** Terminal `i`'s distance from `eye` (scene metres). Allocation-free. */
  depthM(i: number, eye: { readonly x: number; readonly y: number; readonly z: number }): number {
    const dx = mm(this.points[3 * i]) - eye.x;
    const dy = mm(this.points[3 * i + 1]) - eye.y;
    const dz = mm(this.points[3 * i + 2]) - eye.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** The list index of `ref`, or −1. */
  indexOf(ref: TerminalRef): number {
    const range = this.ranges.get(ref.entity);
    if (!range) return -1;
    for (let i = range.from; i < range.to; i++) if (this.refs[i].terminal === ref.terminal) return i;
    return -1;
  }

  /** Whether `entity` has wireable terminals. */
  has(entity: EntityId): boolean {
    return this.ranges.has(entity);
  }

  /** `entity`'s wireable terminals in Tab order (`terminalCycleOrder` of their catalogue positions). */
  cycleOrder(entity: EntityId): readonly string[] {
    return this.ranges.get(entity)?.order ?? [];
  }

  /**
   * Projects every terminal with `camera` onto a `widthPx × heightPx` canvas (CSS px from the top
   * left). Terminals behind the camera, beyond its far plane, or more than a margin off the canvas
   * are off screen. Allocation-free once the grid has grown to the terminal count.
   */
  project(camera: Camera, widthPx: number, heightPx: number): void {
    const n = this.refs.length;
    const s = this.screen;
    s.reset(n);
    const v = this.tmp;
    for (let i = 0; i < n; i++) {
      v.set(mm(this.points[3 * i]), mm(this.points[3 * i + 1]), mm(this.points[3 * i + 2])).project(camera);
      const x = ((v.x + 1) / 2) * widthPx;
      const y = ((1 - v.y) / 2) * heightPx;
      const on =
        v.z > -1 &&
        v.z < 1 &&
        x >= -SCREEN_MARGIN_PX &&
        x <= widthPx + SCREEN_MARGIN_PX &&
        y >= -SCREEN_MARGIN_PX &&
        y <= heightPx + SCREEN_MARGIN_PX;
      s.set(i, x, y, on);
    }
    s.build();
  }

  /** The pick at (`x`, `y`) CSS px after {@link project} (the result object is reused). */
  pick(x: number, y: number, visible: (i: number) => boolean): ScreenTerminalPick {
    return pickScreenTerminal(this.screen, x, y, visible, this.result);
  }

  /** `entity`'s terminal-group pitch on screen after {@link project} (px; `Infinity`: ample or off screen). */
  groupPitch(entity: EntityId): number {
    const range = this.ranges.get(entity);
    if (!range) return Infinity;
    return groupPitchPx(this.screen, range.from, range.to);
  }
}
