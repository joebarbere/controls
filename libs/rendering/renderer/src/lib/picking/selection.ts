/**
 * Hover and selection: renderer/UI state, **not** world state. Nothing here is saved or logged;
 * Commands that act on the selection (e.g. `entity.delete`) read it as an argument (F1.2).
 */
import type { SnapTarget, SurfaceNormal } from '@controls/world-model';

export type SelectableKind = 'backplate' | 'din-rail' | 'wall' | 'bench' | 'prop' | 'device';

/** JSON-plain metadata stored on a scene object's `userData.selectable`. */
export interface SelectableInfo {
  /** Stable id: a fixed scene object's name (`backplate`, `din-rail-1`) or `entity-<id>` for world entities. */
  readonly id: string;
  readonly kind: SelectableKind;
  readonly label: string;
  /** Present when work mode can focus this object; the way its working face points. */
  readonly focusNormal?: SurfaceNormal;
  /** Present when placement can snap onto this object. */
  readonly snapTarget?: SnapTarget;
  /** The world entity this object draws (entity selectables only); Commands take it as `id`. */
  readonly entityId?: number;
}

export interface SelectionSnapshot {
  readonly hovered: SelectableInfo | null;
  readonly selected: SelectableInfo | null;
}

export type SelectionListener = (state: SelectionSnapshot) => void;

/** Code-unit order: locale-independent, so cycling order is identical on every machine. */
const byId = (a: SelectableInfo, b: SelectableInfo): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class SelectionModel {
  private items: SelectableInfo[] = [];
  private hoveredId: string | null = null;
  private selectedId: string | null = null;
  private readonly listeners = new Set<SelectionListener>();

  /** Replaces the selectable set. Hover or selection pointing at a removed id is cleared. */
  setSelectables(items: Iterable<SelectableInfo>): void {
    const unique = new Map<string, SelectableInfo>();
    for (const item of items) {
      if (unique.has(item.id)) throw new Error(`duplicate selectable id ${item.id}`);
      unique.set(item.id, item);
    }
    this.items = [...unique.values()].sort(byId);
    const before = this.key();
    if (this.hoveredId !== null && !unique.has(this.hoveredId)) this.hoveredId = null;
    if (this.selectedId !== null && !unique.has(this.selectedId)) this.selectedId = null;
    if (this.key() !== before) this.emit();
  }

  /** Selectables in cycling order. */
  get all(): readonly SelectableInfo[] {
    return this.items;
  }

  get(id: string): SelectableInfo | undefined {
    return this.items.find((i) => i.id === id);
  }

  get hovered(): SelectableInfo | null {
    return this.hoveredId === null ? null : (this.get(this.hoveredId) ?? null);
  }

  get selected(): SelectableInfo | null {
    return this.selectedId === null ? null : (this.get(this.selectedId) ?? null);
  }

  snapshot(): SelectionSnapshot {
    return { hovered: this.hovered, selected: this.selected };
  }

  hover(id: string | null): void {
    const next = id !== null && this.get(id) ? id : null;
    if (next === this.hoveredId) return;
    this.hoveredId = next;
    this.emit();
  }

  /** Selects `id`, or clears the selection for `null`. Returns false for an unknown id. */
  select(id: string | null): boolean {
    if (id !== null && !this.get(id)) return false;
    if (id === this.selectedId) return true;
    this.selectedId = id;
    this.emit();
    return true;
  }

  /** Moves the selection `step` places through the id-sorted list, wrapping. No-op when empty. */
  cycle(step: 1 | -1): SelectableInfo | null {
    const n = this.items.length;
    if (n === 0) return null;
    const current = this.items.findIndex((i) => i.id === this.selectedId);
    const next = current < 0 ? (step > 0 ? 0 : n - 1) : (current + step + n) % n;
    this.select(this.items[next].id);
    return this.items[next];
  }

  onChange(listener: SelectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
    this.items = [];
    this.hoveredId = null;
    this.selectedId = null;
  }

  private key(): string {
    return `${this.hoveredId}|${this.selectedId}`;
  }

  private emit(): void {
    const snap = this.snapshot();
    this.listeners.forEach((l) => l(snap));
  }
}
