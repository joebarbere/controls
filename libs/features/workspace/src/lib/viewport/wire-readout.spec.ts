import { TestBed } from '@angular/core/testing';
import { CONSOLE_AVAILABLE_KEY } from '@controls/commands';
import { Session, SimHost } from '@controls/feature-session';
import { ViewportRenderer, type ViewportState } from '@controls/renderer';
import { fakeSnapshotView, type SnapshotView } from '@controls/sim-protocol';
import { within } from '@testing-library/dom';
import { benchDescriptor, connectionRecords } from '../netlist/netlist.fakes';
import { Viewport } from './viewport';
import { WireReadoutPanel } from './wire-readout';
import type { WireReadoutView } from './wire-readout-model';

/*
 * The wire readout in the viewport (F3.6 part 3): shown for the hovered, else the selected, wire in
 * work mode while the console is available (D16); a selection is announced once in a polite live
 * region, a hover never; the panel is text that never takes the pointer. jsdom has no renderer, so the
 * view state is set as the renderer would publish it and snapshots come from a stubbed `SimHost`.
 */

const lead = { currentA: 0.3906, conductorDropV: 0.03, conductorTempK: 293.4, status: 1, readings: 63 };
const loose = (endATempK: number, currentA = 11.8059) => ({
  currentA,
  conductorDropV: 0.2011,
  endADropV: 0.300478,
  endBDropV: 0.0061,
  conductorTempK: 303.033,
  endATempK,
  endBTempK: 301.709,
  endAState: 1,
  endBState: 1,
  status: 1,
  readings: 63,
});
const snapshot = (wire: Readonly<Record<string, number>>): SnapshotView =>
  fakeSnapshotView({ descriptor: benchDescriptor(), connections: connectionRecords([lead, lead, lead, wire]) });
const WIRE = { kind: 'connection', id: 9 } as const;

function viewState(s: Partial<ViewportState>): ViewportState {
  return { mode: 'work', hovered: null, selected: null, hoveredWire: null, selectedWire: null, ...s } as ViewportState;
}

async function setup(consoleAvailable = true) {
  const listeners: ((view: SnapshotView | null) => void)[] = [];
  vi.spyOn(SimHost.prototype, 'subscribe').mockImplementation((listener) => {
    listeners.push(listener);
    return () => undefined;
  });
  const fixture = TestBed.createComponent(Viewport);
  await fixture.whenStable();
  const session = TestBed.inject(Session);
  if (consoleAvailable) session.setContext(CONSOLE_AVAILABLE_KEY, true);
  const send = async (view: SnapshotView | null) => {
    for (const listener of listeners) listener(view);
    await fixture.whenStable();
  };
  const set = async (s: Partial<ViewportState>) => {
    fixture.componentInstance.state.set(viewState(s));
    await fixture.whenStable();
  };
  const host = fixture.nativeElement as HTMLElement;
  const panel = () => host.querySelector<HTMLElement>('[data-testid="wire-readout"]');
  const status = () => host.querySelector('[data-testid="wire-status"]')?.textContent?.trim() ?? '';
  return { fixture, session, send, set, host, panel, status };
}

describe('WireReadoutPanel', () => {
  async function render(readout: WireReadoutView) {
    const fixture = TestBed.createComponent(WireReadoutPanel);
    fixture.componentRef.setInput('readout', readout);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('is a named region with a table of each part’s drop and temperature, as text', async () => {
    const el = await render({
      title: 'Wire 2',
      source: 'hover',
      current: '11.8 A',
      parts: [
        { key: 'conductor', name: 'Conductor', terminated: true, drop: '201 mV', temperature: '303 K (30 °C)' },
        { key: 'end-a', name: 'End a', terminated: true, drop: '300 mV', temperature: '394 K (121 °C)' },
        { key: 'end-b', name: 'End b', terminated: false, drop: '', temperature: '' },
      ],
      state: 'overheating at end a',
    });
    const region = within(el).getByRole('region', { name: 'Wire readout: Wire 2' });
    expect(within(region).getByRole('heading', { name: 'Wire 2' })).toBeTruthy();
    expect(within(region).getByRole('columnheader', { name: 'Temperature' })).toBeTruthy();
    expect(within(region).getByRole('row', { name: 'End a 300 mV 394 K (121 °C)' })).toBeTruthy();
    expect(within(region).getByRole('row', { name: 'End b no termination' })).toBeTruthy();
    expect(within(region).getByText('State: overheating at end a')).toBeTruthy();
    expect(el.querySelector('[tabindex]')).toBeNull(); // nothing in it takes focus
  });

  it('shows a cable jacket without a table', async () => {
    const el = await render({ title: 'Cable 1', source: 'selection', current: '', parts: [], state: 'no reading' });
    expect(el.querySelector('table')).toBeNull();
    expect(el.querySelector('[data-testid="wire-readout"]')?.getAttribute('data-source')).toBe('selection');
  });
});

describe('the wire readout in the viewport (F3.6 part 3)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined); // jsdom has no WebGL/WebGPU
  });

  it('shows the hovered wire’s record in work mode, updating only as the readout changes', async () => {
    const { send, set, panel, status, host } = await setup();
    await send(snapshot(loose(393.822)));
    expect(panel()).toBeNull();
    await set({ hoveredWire: WIRE });
    expect(host.getAttribute('data-wire-hovered')).toBe('c9');
    const region = panel() as HTMLElement;
    expect(region.getAttribute('data-source')).toBe('hover');
    expect(within(region).getByRole('row', { name: 'Conductor 201 mV 303 K (30 °C)' })).toBeTruthy();
    expect(within(region).getByRole('row', { name: 'End a 300 mV 394 K (121 °C)' })).toBeTruthy();
    expect(within(region).getByText('Current 11.8 A')).toBeTruthy();
    expect(status()).toBe(''); // a hover is never announced
    // The panel's text changes with the record (the end heats past a whole kelvin).
    await send(snapshot(loose(396.2)));
    expect(within(panel() as HTMLElement).getByRole('row', { name: 'End a 300 mV 396 K (123 °C)' })).toBeTruthy();
    // A reset: no reading, never stale values.
    await send(null);
    expect(within(panel() as HTMLElement).getByText('Current no reading')).toBeTruthy();
    await set({ hoveredWire: null });
    expect(panel()).toBeNull();
  });

  it('shows the selected wire (the keyboard’s way in) and announces the selection once', async () => {
    const { send, set, panel, status, host } = await setup();
    await send(snapshot(loose(393.822)));
    await set({ selectedWire: WIRE });
    expect(host.getAttribute('data-wire-selected')).toBe('c9');
    expect(panel()?.getAttribute('data-source')).toBe('selection');
    expect(status()).toBe(
      'Wire 9 selected. Current 11.8 A. Conductor 303 K (30 °C), drop 201 mV. End a 394 K (121 °C), drop 300 mV. ' +
        'End b 302 K (29 °C), drop 6.10 mV. State: overheating at end a.',
    );
    // New values update the panel but not the live region.
    await send(snapshot(loose(410, 12.5)));
    expect(within(panel() as HTMLElement).getByText('Current 12.5 A')).toBeTruthy();
    expect(status()).toContain('Current 11.8 A');
    // A hover over another wire takes the panel; the selection's announcement stands.
    await set({ selectedWire: WIRE, hoveredWire: { kind: 'cable', id: 1 } });
    expect(panel()?.getAttribute('data-source')).toBe('hover');
    expect(within(panel() as HTMLElement).getByRole('heading', { name: 'Cable 1' })).toBeTruthy();
    expect(status()).toContain('Wire 9 selected.');
  });

  it('is a debug aid (D16): nothing without the console, and only in work mode', async () => {
    const { send, set, panel, status, session } = await setup(false);
    await send(snapshot(loose(393.822)));
    await set({ hoveredWire: WIRE, selectedWire: WIRE });
    expect(panel()).toBeNull();
    expect(status()).toBe('Wire 9 selected.'); // the selection is still named
    session.setContext(CONSOLE_AVAILABLE_KEY, true);
    await set({ mode: 'walk', hoveredWire: WIRE });
    expect(panel()).toBeNull();
    await set({ mode: 'work', hoveredWire: WIRE });
    expect(panel()).not.toBeNull();
  });

  it('never takes the pointer, and moves to the other corner when the pointer is under it', async () => {
    const { set, host, fixture } = await setup();
    await set({ hoveredWire: WIRE });
    const element = host.querySelector('ctl-wire-readout') as HTMLElement;
    expect(element.getAttribute('data-corner')).toBe('top-right');
    // jsdom has no layout: give the viewport and the panel sizes.
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 600));
    Object.defineProperty(host, 'clientWidth', { value: 1000 });
    Object.defineProperty(host, 'clientHeight', { value: 600 });
    Object.defineProperty(element, 'offsetWidth', { value: 280 });
    Object.defineProperty(element, 'offsetHeight', { value: 120 });
    host.dispatchEvent(new MouseEvent('pointermove', { clientX: 500, clientY: 300 }));
    await fixture.whenStable();
    expect(element.getAttribute('data-corner')).toBe('top-right');
    host.dispatchEvent(new MouseEvent('pointermove', { clientX: 900, clientY: 60 }));
    await fixture.whenStable();
    expect(element.getAttribute('data-corner')).toBe('bottom-left');
    host.dispatchEvent(new MouseEvent('pointermove', { clientX: 100, clientY: 520 }));
    await fixture.whenStable();
    expect(element.getAttribute('data-corner')).toBe('top-right');
  });

  it('N with no wire drawn selects nothing and says so; it never logs or changes the world', async () => {
    const { session, status, fixture } = await setup();
    const select = vi.spyOn(ViewportRenderer.prototype, 'selectWire');
    const world = session.world();
    const logged = session.entries().length;
    expect(session.exec('view.wireNext').ok).toBe(true);
    await fixture.whenStable();
    expect(select).not.toHaveBeenCalled();
    expect(status()).toBe('No wire to select.');
    expect(session.world()).toBe(world);
    expect(session.entries().length).toBe(logged);
  });
});
