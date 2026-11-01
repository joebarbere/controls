import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  type Signal,
  signal,
} from '@angular/core';
import { SimHost, type SimTrace } from '@controls/feature-session';
import { type DescriptorTerminalRef, PANEL_SAMPLE_HZ } from '@controls/sim-protocol';
import { Button } from '@controls/ui';
import {
  buildNetlistTree,
  NO_READING,
  netlistSampler,
  type NetlistTreeItem,
  type NetlistValues,
  sameNetlistValues,
} from './netlist-model';
import { TracePlot } from './trace-plot';

/** The trace's redraw rate under `prefers-reduced-motion`: a still plot, updated once a second. */
export const REDUCED_MOTION_TRACE_HZ = 1;

/**
 * The netlist inspector (plan F2.6): a tree of the sim's islands, their nodes (with member terminals)
 * and branches, with live |V| and |I| from the SimHost snapshot. Docked in the workspace's side panel
 * by `view.netlistInspector`.
 *
 * - **Throttled:** values are sampled through `SimHost.select` at `PANEL_SAMPLE_HZ` (10 Hz, with a
 *   trailing sample) and set only when a displayed string changes, so the panel is redrawn at most
 *   ten times a second, never per snapshot. The structure is rebuilt only for a new descriptor.
 * - **Validity:** an island that isn't solved, or a node of an island with no reference, reads
 *   "no reading", never 0 V or 0 A (`NetlistReadout`, the overlays' readout).
 * - **Keyboard:** an ARIA tree with a roving tab stop. Up and Down move, Home and End jump, Right
 *   expands or goes to the first child, Left collapses or goes to the parent. The focused row is the
 *   selection; a selected node's terminals are {@link highlighted} (the workspace passes them to the
 *   renderer: view state only).
 * - **Trace** (ADR 0011 §4): T on a branch row, or the Trace button for the selected branch, starts a
 *   live trace of its current, sampled by the worker at every electrical solve (the lamp's inrush is
 *   in it), drawn below the tree; again stops it. One trace at a time; view state, never logged.
 */
@Component({
  selector: 'ctl-netlist-inspector',
  imports: [Button, TracePlot],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'data-testid': 'netlist-inspector' },
  template: `
    <h3 id="ctl-netlist-title" class="title">Netlist</h3>
    @if (values(); as v) {
      <p class="meta" data-testid="netlist-tick">
        Tick {{ v.tick }}
        @if (stale()) {
          · sim stopped, values frozen
        }
      </p>
    }
    @if (tree().length === 0) {
      <p class="ctl-hint" tabindex="-1" data-autofocus>
        {{ values() === null ? 'No sim snapshot yet.' : 'The netlist is empty.' }}
      </p>
    } @else {
      <ul role="tree" aria-labelledby="ctl-netlist-title" class="tree">
        @for (item of visible(); track item.key) {
          <li
            role="treeitem"
            [class]="'row level-' + item.level"
            [attr.data-key]="item.key"
            [attr.data-kind]="item.kind"
            [attr.aria-level]="item.level"
            [attr.aria-setsize]="item.setSize"
            [attr.aria-posinset]="item.posInSet"
            [attr.aria-expanded]="item.expandable ? !collapsed().has(item.key) : null"
            [attr.aria-selected]="item.key === selected()"
            [attr.aria-keyshortcuts]="item.kind === 'branch' ? 'T' : null"
            [attr.data-traced]="item.key === traced()?.key ? '' : null"
            [attr.tabindex]="item.key === tabStop() ? 0 : -1"
            [attr.data-autofocus]="item.key === tabStop() ? '' : null"
            (focus)="selected.set(item.key)"
            (click)="focusItem(item.key)"
            (keydown)="onKeydown($event, item)"
          >
            <span class="label">{{ item.label }}</span>
            <span class="value" [class.unknown]="valueOf(item) === noReading">{{ valueOf(item) }}</span>
          </li>
        }
      </ul>
      <section class="trace" aria-labelledby="ctl-trace-title" data-testid="netlist-trace">
        <div class="trace-head">
          <h4 id="ctl-trace-title" class="trace-title">
            {{ traced() ? 'Trace · ' + traced()!.label : 'Trace' }}
          </h4>
          <button
            ctlButton="ghost"
            type="button"
            data-testid="trace-toggle"
            [disabled]="!traced() && !selectedBranch()"
            (click)="toggleTrace(buttonStops() ? null : selectedBranch())"
          >
            {{ buttonStops() ? 'Stop trace' : 'Trace selected branch' }}
          </button>
        </div>
        @if (traced(); as t) {
          <ctl-trace-plot [trace]="t.trace" [label]="t.label + ' current'" unit="A" />
        } @else {
          <p class="ctl-hint">Select a branch and press T to trace its current.</p>
        }
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
      font-variant-numeric: tabular-nums;
    }
    .title {
      margin: 0 0 var(--ctl-space-1);
      font-size: 1rem;
    }
    .meta {
      margin: 0 0 var(--ctl-space-2);
      color: var(--ctl-fg-muted);
    }
    .tree {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .row {
      display: flex;
      justify-content: space-between;
      gap: var(--ctl-space-2);
      padding: 2px var(--ctl-space-1);
      border-radius: var(--ctl-radius);
      cursor: default;
    }
    .row[aria-selected='true'] {
      background: var(--ctl-surface-raised);
      outline: 1px solid var(--ctl-accent);
    }
    .level-2 {
      padding-left: 1.2rem;
    }
    .level-3 {
      padding-left: 2.4rem;
      font-family: var(--ctl-font-mono);
    }
    .row[aria-expanded='false'] .label::before {
      content: '▸ ';
    }
    .row[aria-expanded='true'] .label::before {
      content: '▾ ';
    }
    .value {
      white-space: nowrap;
    }
    .row[data-traced] .label::after {
      content: ' · traced';
      color: var(--ctl-accent);
    }
    .trace {
      margin-top: var(--ctl-space-2);
    }
    .trace-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--ctl-space-2);
    }
    .trace-title {
      margin: 0;
      font-size: 0.9rem;
    }
    .value.unknown {
      color: var(--ctl-fg-muted);
      font-style: italic;
    }
  `,
})
export class NetlistInspector {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly sim = inject(SimHost);
  private readonly destroyRef = inject(DestroyRef);
  private readonly view = inject(DOCUMENT).defaultView;
  private readonly sample = this.sim.select<NetlistValues | null>(netlistSampler(), {
    initial: null,
    hz: PANEL_SAMPLE_HZ,
    equal: sameNetlistValues,
    destroyRef: this.destroyRef,
  });
  /** The traced branch (its row key and label) and its live trace, or `null`. */
  readonly traced = signal<{ readonly key: string; readonly label: string; readonly trace: SimTrace } | null>(null);
  protected readonly noReading = NO_READING;
  /** The latest sample's display strings, or `null` before the first snapshot (or after a reset). */
  readonly values: Signal<NetlistValues | null> = this.sample;
  /** True while the sim has crashed: the values shown are the last ones. */
  protected readonly stale = this.sample.stale;
  private readonly descriptor = computed(() => this.values()?.descriptor ?? null);
  /** Every row, rebuilt only for a new descriptor (a new topology generation). */
  readonly tree = computed(() => {
    const d = this.descriptor();
    return d === null ? [] : buildNetlistTree(d);
  });
  protected readonly collapsed = signal<ReadonlySet<string>>(new Set());
  /** The selected (focused) row's key; kept across generations while the key exists. */
  protected readonly selected = signal<string | null>(null);
  protected readonly visible = computed(() => {
    const closed = this.collapsed();
    const hidden = new Set<string>();
    return this.tree().filter((item) => {
      if (item.parent !== null && (hidden.has(item.parent) || closed.has(item.parent))) {
        hidden.add(item.key);
        return false;
      }
      return true;
    });
  });
  /** The one row in the tab order: the selection if shown, else the first row. */
  protected readonly tabStop = computed(() => {
    const rows = this.visible();
    const key = this.selected();
    return rows.some((r) => r.key === key) ? key : (rows[0]?.key ?? null);
  });
  /** The selected node's member terminals, for the 3D highlight; `null` unless a node is selected. */
  readonly highlighted = computed<readonly DescriptorTerminalRef[] | null>(() => {
    const key = this.selected();
    const item = this.tree().find((i) => i.key === key);
    return item?.kind === 'node' ? item.members : null;
  });

  /** The selected row if it is a branch. */
  protected readonly selectedBranch = computed(() => {
    const key = this.selected();
    const item = this.tree().find((i) => i.key === key);
    return item?.kind === 'branch' ? item : null;
  });

  /** The Trace button stops the trace: nothing else is selected to trace, or the selection is what is traced. */
  protected readonly buttonStops = computed(() => {
    const traced = this.traced();
    const branch = this.selectedBranch();
    return traced !== null && (branch === null || branch.key === traced.key);
  });

  constructor() {
    this.destroyRef.onDestroy(() => this.traced()?.trace.stop());
  }

  /** Starts a trace of `item`'s current (a branch row), or stops the current trace if it is that one (or none). */
  toggleTrace(item: NetlistTreeItem | null): void {
    const current = this.traced();
    current?.trace.stop();
    this.traced.set(null);
    if (item === null || item.kind !== 'branch' || current?.key === item.key) return;
    const branch = this.descriptor()?.branches[item.index];
    if (branch === undefined) return;
    const reduced = this.view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const trace = this.sim.watch(
      { kind: 'branch', element: branch.element },
      { hz: reduced ? REDUCED_MOTION_TRACE_HZ : PANEL_SAMPLE_HZ },
    );
    this.traced.set({ key: item.key, label: item.label.replace(/:.*$/, ''), trace });
  }

  protected valueOf(item: NetlistTreeItem): string {
    const v = this.values();
    if (v === null) return '';
    switch (item.kind) {
      case 'island':
        return v.islands[item.index] ?? '';
      case 'node':
        return v.nodes[item.index] ?? NO_READING;
      case 'branch':
        return v.branches[item.index] ?? NO_READING;
      default:
        return '';
    }
  }

  protected focusItem(key: string): void {
    for (const el of this.host.nativeElement.querySelectorAll<HTMLElement>('[role="treeitem"]')) {
      if (el.dataset['key'] === key) {
        el.focus();
        break;
      }
    }
    this.selected.set(key);
  }

  protected onKeydown(event: KeyboardEvent, item: NetlistTreeItem): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const rows = this.visible();
    const at = rows.findIndex((r) => r.key === item.key);
    const expanded = item.expandable && !this.collapsed().has(item.key);
    let target: string | null = null;
    switch (event.key) {
      case 'ArrowDown':
        target = rows[at + 1]?.key ?? null;
        break;
      case 'ArrowUp':
        target = rows[at - 1]?.key ?? null;
        break;
      case 'Home':
        target = rows[0]?.key ?? null;
        break;
      case 'End':
        target = rows[rows.length - 1]?.key ?? null;
        break;
      case 'ArrowRight':
        if (item.expandable && !expanded) this.setCollapsed(item.key, false);
        else if (expanded) target = rows[at + 1]?.key ?? null;
        break;
      case 'ArrowLeft':
        if (expanded) this.setCollapsed(item.key, true);
        else target = item.parent;
        break;
      case 'Enter':
      case ' ':
        if (item.expandable) this.setCollapsed(item.key, expanded);
        break;
      case 't':
      case 'T':
        if (item.kind !== 'branch') return;
        this.toggleTrace(item);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (target !== null) this.focusItem(target);
  }

  private setCollapsed(key: string, collapsed: boolean): void {
    this.collapsed.update((set) => {
      const next = new Set(set);
      if (collapsed) next.add(key);
      else next.delete(key);
      return next;
    });
  }
}
