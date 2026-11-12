import { TestBed } from '@angular/core/testing';
import { KEY_PLATFORM, KeybindingService, Session, SimHost, ToolBelt } from '@controls/feature-session';
import { type LampOutputs, type ViewportIntent, ViewportRenderer, type ViewportState } from '@controls/renderer';
import type { SnapshotView } from '@controls/sim-protocol';
import { SettingsStore } from '@controls/feature-settings';
import { fakeView, lampDescriptor, writeLamp } from './lamp-feed.fakes';
import { Viewport } from './viewport';

/** The component's gesture handler (private: the renderer calls it, and jsdom has no renderer). */
const sendIntent = (viewport: Viewport, intent: ViewportIntent) =>
  (viewport as unknown as { onIntent(i: ViewportIntent): void }).onIntent(intent);

describe('Viewport', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined); // jsdom has no WebGL/WebGPU
  });

  it('renders a keyboard-focusable canvas that explains its keys', async () => {
    const fixture = TestBed.createComponent(Viewport);
    await fixture.whenStable();
    const canvas = (fixture.nativeElement as HTMLElement).querySelector('canvas');
    expect(canvas?.getAttribute('tabindex')).toBe('0');
    expect(canvas?.getAttribute('aria-label')).toMatch(/cycle selection/);
  });

  it('names the current input-action keys and follows rebinding', async () => {
    TestBed.configureTestingModule({ providers: [{ provide: KEY_PLATFORM, useValue: 'other' }] });
    const fixture = TestBed.createComponent(Viewport);
    await fixture.whenStable();
    const canvas = (fixture.nativeElement as HTMLElement).querySelector('canvas') as HTMLCanvasElement;
    expect(canvas.getAttribute('aria-label')).toBe(
      '3D workspace. Click to select. [ and ] cycle selection, F focuses it, V toggles walk and work mode, W A S D walk. ' +
        'Number keys pick a tool-belt slot; a prop is placed with a click or Enter at the pointer or the centre, a tool is held. ' +
        'Drag an object, or M then Enter, to move it; E or a double-click operates a selected switch; ' +
        'Delete deletes it; Escape cancels.',
    );
    TestBed.inject(KeybindingService).setBinding('input.moveForward', 'I');
    TestBed.inject(KeybindingService).setBinding('view.mode.walk', null);
    await fixture.whenStable();
    expect(canvas.getAttribute('aria-label')).toContain('unbound toggles walk and work mode, I A S D walk.');
  });

  it('arms placement with the active tool-belt prop', async () => {
    const fixture = TestBed.createComponent(Viewport);
    await fixture.whenStable();
    const session = TestBed.inject(Session);
    expect(fixture.componentInstance.activeProp()).toBeNull();
    session.exec('toolbelt.select', { slot: 2 });
    expect(fixture.componentInstance.activeProp()).toEqual({ id: 'prop.crate', version: 1 });
    session.exec('toolbelt.select', { slot: 9 }); // an empty slot
    expect(fixture.componentInstance.activeProp()).toBeNull();
  });

  it('never arms placement from a tool slot: a tool arms its flow (F3.4 part 1)', async () => {
    const fixture = TestBed.createComponent(Viewport);
    await fixture.whenStable();
    const store = TestBed.inject(SettingsStore);
    const slots = [...store.settings().toolBelt.slots];
    slots[3] = { id: 'tool.veltmark-ws-1018', version: 1 };
    store.update('toolBelt', { slots });
    TestBed.inject(Session).exec('toolbelt.select', { slot: 4 });
    expect(fixture.componentInstance.activeProp()).toBeNull();
    // Swapping the slot's contents for a prop arms placement without selecting again.
    slots[3] = { id: 'prop.box', version: 1 };
    store.update('toolBelt', { slots });
    expect(fixture.componentInstance.activeProp()).toEqual({ id: 'prop.box', version: 1 });
  });

  it('turns each gesture commit into exactly one Command; a cancelled placement into none', async () => {
    const fixture = TestBed.createComponent(Viewport);
    await fixture.whenStable();
    const session = TestBed.inject(Session);
    const belt = TestBed.inject(ToolBelt);
    const viewport = fixture.componentInstance;
    const box = { id: 'prop.box', version: 1 };
    session.exec('toolbelt.select', { slot: 1 });
    sendIntent(viewport, {
      kind: 'place',
      ref: box,
      positionMm: { x: -210, y: 260, z: 0 },
      orientationMdeg: { yaw: 0, pitch: 0, roll: 0 },
      mountedOn: null,
    });
    sendIntent(viewport, { kind: 'move', id: 1, positionMm: { x: -70, y: 110, z: 0 } });
    sendIntent(viewport, { kind: 'cancelPlacement' });
    expect(belt.activeSlot()).toBeNull();
    expect(session.contextKeys()['toolbelt.slot']).toBeUndefined();
    expect(session.entries().map((e) => [e.id, e.args])).toEqual([
      ['toolbelt.select', { slot: 1 }],
      [
        'entity.place',
        {
          ref: box,
          positionMm: { x: -210, y: 260, z: 0 },
          orientationMdeg: { yaw: 0, pitch: 0, roll: 0 },
          mountedOn: null,
        },
      ],
      ['entity.move', { id: 1, positionMm: { x: -70, y: 110, z: 0 } }],
    ]);
    // A refusal is the world's answer: it reaches the shell's toasts (`onRefusal`), not the console.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const refusals: unknown[] = [];
    session.onRefusal((r) => refusals.push(r));
    sendIntent(viewport, { kind: 'move', id: 99, positionMm: { x: 0, y: 0, z: 0 } });
    expect(refusals).toEqual([
      { commandId: 'entity.move', title: 'Move object', code: 'not-found', message: 'No entity with id 99' },
    ]);
    expect(warn).not.toHaveBeenCalled();
    // Bad arguments are a bug in the renderer, not a refusal: the console says so.
    sendIntent(viewport, { kind: 'move', id: 1, positionMm: { x: 0.5, y: 0, z: 0 } });
    expect(warn).toHaveBeenCalledOnce();
    expect(refusals).toHaveLength(1);
    expect(session.entries()).toHaveLength(3);
  });

  it('passes mountedOn through to entity.place and explains a placement that breaks a rule (F3.5)', async () => {
    const fixture = TestBed.createComponent(Viewport);
    await fixture.whenStable();
    const session = TestBed.inject(Session);
    session.newSandbox({ seed: 0 });
    const viewport = fixture.componentInstance;
    const panel = { id: 'panel.pellmoor-din-400x500', version: 1 };
    const breaker = { id: 'breaker.saltmere-1p-15a', version: 1 };
    const Z = { yaw: 0, pitch: 0, roll: 0 };
    sendIntent(viewport, {
      kind: 'place',
      ref: panel,
      positionMm: { x: 0, y: 0, z: 0 },
      orientationMdeg: Z,
      mountedOn: null,
    });
    const mountedOn = { entity: 1, mount: 'rail-1' };
    sendIntent(viewport, {
      kind: 'place',
      ref: breaker,
      positionMm: { x: 35, y: 305, z: 22 },
      orientationMdeg: Z,
      mountedOn,
    });
    expect(session.world().entities.map((e) => e.mountedOn)).toEqual([null, mountedOn]);
    expect(session.entries().at(-1)?.args).toMatchObject({ mountedOn });

    const hint = () => (fixture.nativeElement as HTMLElement).querySelector('[data-testid="placement-hint"]');
    const placement = (reason: string | null) =>
      viewport.state.set({
        placement: { kind: 'place', ref: breaker, reason, valid: reason === null },
      } as unknown as ViewportState);
    placement('mount-full');
    await fixture.whenStable();
    expect(hint()?.textContent?.trim()).toBe('That spot on the mount is taken.');
    expect(hint()?.getAttribute('role')).toBe('status');
    expect((fixture.nativeElement as HTMLElement).getAttribute('data-placement-reason')).toBe('mount-full');
    placement('no-target'); // nothing under the cursor isn't a rule: no hint
    await fixture.whenStable();
    expect(hint()).toBeNull();
    placement(null);
    await fixture.whenStable();
    expect(hint()).toBeNull();
  });

  it('applies view.mode and view.focus from any surface without touching the world', async () => {
    const fixture = TestBed.createComponent(Viewport);
    await fixture.whenStable();
    const session = TestBed.inject(Session);
    const before = await session.hashAt();
    expect(session.exec('view.mode', { mode: 'walk' }).ok).toBe(true);
    expect(session.exec('view.focus', { target: 'backplate' }).ok).toBe(true);
    expect(await session.hashAt()).toBe(before);
  });

  it('sets viewport.focused while the canvas has focus', async () => {
    const fixture = TestBed.createComponent(Viewport);
    document.body.appendChild(fixture.nativeElement);
    await fixture.whenStable();
    const session = TestBed.inject(Session);
    const canvas = (fixture.nativeElement as HTMLElement).querySelector('canvas') as HTMLCanvasElement;
    canvas.focus();
    expect(session.contextKeys()['viewport.focused']).toBe(true);
    canvas.blur();
    expect(session.contextKeys()['viewport.focused']).toBeUndefined();
    canvas.focus();
    fixture.destroy();
    expect(session.contextKeys()['viewport.focused']).toBeUndefined();
    document.body.replaceChildren();
  });

  it('E and a double-click operate the selected switch: its toggle in the context keys, one command each (F2.5)', async () => {
    const fixture = TestBed.createComponent(Viewport);
    await fixture.whenStable();
    const session = TestBed.inject(Session);
    session.newSandbox({ seed: 0 });
    const at = { x: 0, y: 0, z: 0 };
    expect(
      session.exec('entity.place', { ref: { id: 'switch.tessaline-spst-toggle', version: 1 }, positionMm: at }).ok,
    ).toBe(true);
    const id = session.world().entities.at(-1)?.id as number;
    const viewport = fixture.componentInstance;
    // jsdom has no renderer: select the switch through the view state the renderer would publish.
    const info = { id: `entity-${id}`, kind: 'device', entityId: id };
    viewport.state.set({ selected: info, hovered: null } as unknown as ViewportState);
    // jsdom has no layout or GPU: give the canvas a size and stand in for the pick under the pointer.
    const pick = vi.spyOn(ViewportRenderer.prototype, 'pickAt').mockReturnValue(info as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 100));
    await fixture.whenStable();
    expect(session.contextKeys()['selection.toggleControl']).toBe('closed');
    expect(session.contextKeys()['selection.toggleValue']).toBe(true);
    const canvas = (fixture.nativeElement as HTMLElement).querySelector('canvas') as HTMLCanvasElement;
    const logged = session.entries().length;
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(
      session
        .entries()
        .slice(logged)
        .map((e) => [e.id, e.args]),
    ).toEqual([['device.operate', { id, control: 'closed', value: true }]]);
    await fixture.whenStable();
    expect(session.contextKeys()['selection.toggleValue']).toBe(false); // the next flip opens it
    expect(pick).toHaveBeenCalled(); // picked at the pointer
    // With the pointer off the switch (over empty space), a double-click operates nothing.
    pick.mockReturnValue(null);
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 100, clientY: 50 }));
    expect(session.entries().length).toBe(logged + 1);
    // A selection without a toggle publishes none, and a double-click does nothing.
    viewport.state.set({ selected: null } as unknown as ViewportState);
    await fixture.whenStable();
    expect(session.contextKeys()['selection.toggleControl']).toBeUndefined();
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(session.entries().length).toBe(logged + 1);
  });

  it('draws each lamp from every sim snapshot, not per command, and every lamp unknown on a reset (F2.5)', async () => {
    const listeners: ((view: SnapshotView | null) => void)[] = [];
    const off = vi.fn();
    vi.spyOn(SimHost.prototype, 'subscribe').mockImplementation((listener) => {
      listeners.push(listener);
      return off;
    });
    const drawn: (readonly [number | undefined, string | undefined, number])[] = [];
    vi.spyOn(ViewportRenderer.prototype, 'setLampOutputs').mockImplementation((outputs: LampOutputs) => {
      const lamp = outputs.get(4);
      drawn.push([lamp?.lightOutputRel, lamp?.status, outputs.size]);
    });
    const fixture = TestBed.createComponent(Viewport);
    await fixture.whenStable();
    expect(listeners).toHaveLength(1);
    const session = TestBed.inject(Session);
    const logged = session.entries().length;
    const descriptor = lampDescriptor([{ entity: 4, kind: 'lamp.incandescent', recordOffset: 0 }]);
    const section = new DataView(new ArrayBuffer(56));
    // A filament warming over three snapshots, with no command in between, then a reset.
    for (const light of [0.02, 0.4, 1]) {
      writeLamp(section, 0, light, 1);
      listeners[0](fakeView(descriptor, section));
    }
    listeners[0](null);
    expect(session.entries().length).toBe(logged);
    expect(drawn).toStrictEqual([
      [0.02, 'solved', 1],
      [0.4, 'solved', 1],
      [1, 'solved', 1],
      [undefined, undefined, 0],
    ]);
    fixture.destroy();
    expect(off).toHaveBeenCalledOnce();
  });

  it('does not expose the E2E hook without ?e2e=1', async () => {
    const fixture = TestBed.createComponent(Viewport);
    await fixture.whenStable();
    expect((window as unknown as Record<string, unknown>)['__controlsViewport']).toBeUndefined();
  });
});
