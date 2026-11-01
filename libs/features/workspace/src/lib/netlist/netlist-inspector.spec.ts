import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { SimHost } from '@controls/feature-session';
import { fakeSnapshotView, PANEL_SAMPLE_HZ, type SnapshotView, type WatchTarget } from '@controls/sim-protocol';
import { NetlistInspector, REDUCED_MOTION_TRACE_HZ } from './netlist-inspector';
import { BENCH_BRANCHES, BENCH_NODES, benchDescriptor } from './netlist.fakes';

/**
 * A `SimHost` whose `select` samples on demand: `publish(view)` runs the selector as a sample would.
 * The throttle itself (10 Hz, trailing sample, reset per generation) is `SimHost.select`'s, covered
 * in `sim-host.spec.ts`; here we check the inspector asks for the panel rate and change-only updates.
 */
class FakeSimHost {
  options: { hz?: number } | null = null;
  readonly watches: { target: WatchTarget; hz?: number; trace: FakeTrace }[] = [];
  watch(target: WatchTarget, options: { hz?: number } = {}) {
    const trace = new FakeTrace(target, this.watches.length + 1);
    this.watches.push({ target, hz: options.hz, trace });
    return trace;
  }
  publish: (view: SnapshotView | null) => void = () => undefined;
  select<T>(
    selector: (view: SnapshotView) => T,
    options: { initial: T; hz?: number; equal?: (a: T, b: T) => boolean },
  ) {
    this.options = options;
    const value = signal(options.initial, { equal: options.equal });
    this.publish = (view) => value.set(view === null ? options.initial : selector(view));
    return Object.assign(value.asReadonly(), { stale: signal(false).asReadonly() });
  }
}

/** A `SimTrace` whose samples a spec sets. */
class FakeTrace {
  readonly version = signal(0);
  data = new Float64Array(0);
  stopped = false;
  constructor(
    readonly target: WatchTarget,
    readonly id: number,
  ) {}
  samples() {
    return this.data;
  }
  stop() {
    this.stopped = true;
  }
  push(samples: readonly number[]) {
    this.data = Float64Array.from([...this.data, ...samples]);
    this.version.update((v) => v + 1);
  }
}

async function setup() {
  const host = new FakeSimHost();
  TestBed.configureTestingModule({ providers: [{ provide: SimHost, useValue: host }] });
  const fixture = TestBed.createComponent(NetlistInspector);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const panel = fixture.nativeElement as HTMLElement;
  const publish = async (view: SnapshotView | null) => {
    host.publish(view);
    await fixture.whenStable();
  };
  return { host, fixture, panel, publish, user: userEvent.setup() };
}

const lit = (descriptor = benchDescriptor(), scale = 1, tick = 1500) =>
  fakeSnapshotView({
    descriptor,
    tick,
    nodes: BENCH_NODES,
    branches: BENCH_BRANCHES.map(([re]) => [re * scale, 0] as const),
    islands: [{ band: 1 }, { iterations: 0 }],
  });
/** A row by its static label text (cheaper than `getByRole('treeitem', { name })`, docs/caveats/ui.md). */
const row = (panel: HTMLElement, label: string) =>
  within(panel).getByText(label, { selector: '.label' }).closest<HTMLElement>('[role="treeitem"]') as HTMLElement;
const value = (r: HTMLElement) => r.querySelector('.value')?.textContent?.trim();

describe('NetlistInspector', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it('says there is no snapshot yet, samples at the panel rate, and lists the netlist once one arrives', async () => {
    const { host, panel, publish } = await setup();
    expect(host.options?.hz).toBe(PANEL_SAMPLE_HZ);
    expect(within(panel).getByText('No sim snapshot yet.')).toBeTruthy();
    await publish(lit());
    const tree = within(panel).getByRole('tree', { name: 'Netlist' });
    expect(within(panel).getByTestId('netlist-tick').textContent?.trim()).toBe('Tick 1500');
    expect(value(row(panel, 'Island 0 · DC'))).toBe('solved · band dc12');
    expect(value(row(panel, 'Node 2: 2:a 2:b'))).toBe('12.8 V');
    expect(value(row(panel, 'Branch 1 e3.filament: 3 -> 4'))).toBe('391 mA, a -> b');
    // An unsolved island is "no reading", never 0 V or 0 A.
    expect(value(row(panel, 'Island 1 · AC'))).toBe('unmodelled · band none');
    expect(value(row(panel, 'Node 5: 4:l1'))).toBe('no reading');
    expect(value(row(panel, 'Branch 5 e4.l1: 6 -> 5'))).toBe('no reading');
    expect(tree.querySelectorAll('[role="treeitem"]')).toHaveLength(19);
    const island = row(panel, 'Island 0 · DC');
    expect(island.getAttribute('aria-level')).toBe('1');
    expect(island.getAttribute('aria-expanded')).toBe('true');
    expect(island.getAttribute('tabindex')).toBe('0'); // the one tab stop
    expect(row(panel, 'Node 3: 3:a').getAttribute('aria-posinset')).toBe('4');
    await publish(null);
    expect(within(panel).getByText('No sim snapshot yet.')).toBeTruthy();
  });

  it('redraws only when a shown string changes, keeping each row element', async () => {
    const { fixture, panel, publish } = await setup();
    const descriptor = benchDescriptor();
    await publish(lit(descriptor));
    const shown = fixture.componentInstance.values();
    const branch = row(panel, 'Branch 1 e3.filament: 3 -> 4');
    await publish(lit(descriptor, 1.0001)); // same text to three figures: no new sample
    expect(fixture.componentInstance.values()).toBe(shown);
    await publish(lit(descriptor, 2, 1510));
    expect(value(branch)).toBe('781 mA, a -> b');
    expect(row(panel, 'Branch 1 e3.filament: 3 -> 4')).toBe(branch); // tracked by key: same element, new text
  });

  it('moves with the arrow keys, expands and collapses, and highlights the selected node', async () => {
    const { fixture, panel, publish, user } = await setup();
    await publish(lit());
    const inspector = fixture.componentInstance;
    row(panel, 'Island 0 · DC').focus();
    expect(inspector.highlighted()).toBeNull();
    await user.keyboard('{ArrowDown}'); // Nodes (5)
    await user.keyboard('{ArrowLeft}'); // collapse it
    await fixture.whenStable();
    expect(row(panel, 'Nodes (5)').getAttribute('aria-expanded')).toBe('false');
    expect(within(panel).queryByText('Node 0: 1:neg')).toBeNull();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowDown}{ArrowDown}'); // expand, Node 0, 1, 2
    await fixture.whenStable();
    const node = row(panel, 'Node 2: 2:a 2:b');
    expect(document.activeElement).toBe(node);
    expect(node.getAttribute('aria-selected')).toBe('true');
    expect(node.getAttribute('tabindex')).toBe('0');
    expect(inspector.highlighted()).toEqual([
      { entity: 2, terminal: 'a' },
      { entity: 2, terminal: 'b' },
    ]);
    await user.keyboard('{ArrowLeft}'); // a leaf: to its parent
    expect(document.activeElement).toBe(row(panel, 'Nodes (5)'));
    await fixture.whenStable();
    expect(inspector.highlighted()).toBeNull();
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(row(panel, 'Branch 5 e4.l1: 6 -> 5'));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(row(panel, 'Island 0 · DC'));
    await user.keyboard('{Enter}');
    await fixture.whenStable();
    expect(row(panel, 'Island 0 · DC').getAttribute('aria-expanded')).toBe('false');
    await user.click(row(panel, 'Island 1 · AC').querySelector('.label') as HTMLElement);
    expect(document.activeElement).toBe(row(panel, 'Island 1 · AC'));

    // A new generation keeps the selection by key.
    await user.keyboard('{ArrowDown}{ArrowDown}');
    await fixture.whenStable();
    expect(inspector.highlighted()).toEqual([{ entity: 4, terminal: 'l1' }]);
    await publish(lit(benchDescriptor(2)));
    expect(inspector.highlighted()).toEqual([{ entity: 4, terminal: 'l1' }]);
  });

  it("traces a branch's current from the keyboard (T) and the button, drawing peak and latest; T again stops", async () => {
    const { host, fixture, panel, publish, user } = await setup();
    await publish(lit());
    const lamp = row(panel, 'Branch 1 e3.filament: 3 -> 4');
    expect(lamp.getAttribute('aria-keyshortcuts')).toBe('T');
    const toggle = within(panel).getByTestId('trace-toggle') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true); // nothing selected to trace
    row(panel, 'Node 3: 3:a').focus();
    await user.keyboard('t'); // a node has no trace
    expect(host.watches).toHaveLength(0);
    lamp.focus();
    await user.keyboard('t');
    await fixture.whenStable();
    expect(host.watches.map((w) => [w.target, w.hz])).toEqual([
      [{ kind: 'branch', element: { kind: 'entity', entity: 3, part: 'filament' } }, PANEL_SAMPLE_HZ],
    ]);
    expect(document.activeElement).toBe(lamp); // the tree keeps focus
    expect(lamp.hasAttribute('data-traced')).toBe(true);
    const trace = host.watches[0].trace;
    expect(within(panel).getByTestId('trace-summary').textContent?.trim()).toBe('No samples yet.');
    // The inrush: 6.16 A at the switch's tick, settling; a gap (no reading) breaks the line.
    trace.push([0, 6.16, 10, 2.1, 20, Number.NaN, 30, 0.6, 1500, 0.432]);
    await fixture.whenStable();
    const summary = 'Peak 6.16 A at 0.000 s; last solve at 1.500 s: 432 mA.';
    expect(within(panel).getByTestId('trace-summary').textContent?.trim()).toBe(summary);
    const plot = within(panel).getByTestId('trace-plot');
    expect(plot.querySelectorAll('polyline')).toHaveLength(2);
    expect(plot.querySelector('svg')?.getAttribute('aria-label')).toBe(`Branch 1 e3.filament current: ${summary}`);
    expect(within(panel).getByText('Trace · Branch 1 e3.filament')).toBeTruthy();
    await user.keyboard('T'); // again: stops
    await fixture.whenStable();
    expect(trace.stopped).toBe(true);
    expect(within(panel).queryByTestId('trace-plot')).toBeNull();
    // The button traces the selected branch, and stops it.
    expect(toggle.textContent?.trim()).toBe('Trace selected branch');
    await user.click(toggle);
    await fixture.whenStable();
    expect(host.watches).toHaveLength(2);
    expect(toggle.textContent?.trim()).toBe('Stop trace');
    await user.click(toggle);
    expect(host.watches[1].trace.stopped).toBe(true);
    // Destroyed with a trace running: it is stopped.
    lamp.focus();
    await user.keyboard('t');
    fixture.destroy();
    expect(host.watches[2].trace.stopped).toBe(true);
  });

  it('redraws the trace once a second under prefers-reduced-motion', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('reduce'),
    })) as unknown as typeof window.matchMedia;
    try {
      const { host, panel, publish, user } = await setup();
      await publish(lit());
      row(panel, 'Branch 1 e3.filament: 3 -> 4').focus();
      await user.keyboard('t');
      expect(host.watches[0].hz).toBe(REDUCED_MOTION_TRACE_HZ);
    } finally {
      window.matchMedia = original;
    }
  });
});
