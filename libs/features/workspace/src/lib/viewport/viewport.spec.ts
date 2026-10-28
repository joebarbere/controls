import { TestBed } from '@angular/core/testing';
import { KEY_PLATFORM, KeybindingService, Session, ToolBelt } from '@controls/feature-session';
import type { ViewportIntent } from '@controls/renderer';
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
        'Number keys pick a prop; click or Enter places it at the pointer or the centre. ' +
        'Drag an object, or M then Enter, to move it; Delete deletes it; Escape cancels.',
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
    });
    sendIntent(viewport, { kind: 'move', id: 1, positionMm: { x: -70, y: 110, z: 0 } });
    sendIntent(viewport, { kind: 'cancelPlacement' });
    expect(belt.activeSlot()).toBeNull();
    expect(session.contextKeys()['toolbelt.slot']).toBeUndefined();
    expect(session.entries().map((e) => [e.id, e.args])).toEqual([
      ['toolbelt.select', { slot: 1 }],
      [
        'entity.place',
        { ref: box, positionMm: { x: -210, y: 260, z: 0 }, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } },
      ],
      ['entity.move', { id: 1, positionMm: { x: -70, y: 110, z: 0 } }],
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    sendIntent(viewport, { kind: 'move', id: 99, positionMm: { x: 0, y: 0, z: 0 } });
    expect(warn).toHaveBeenCalledOnce();
    expect(session.entries()).toHaveLength(3);
  });

  it('applies view.mode and view.focus from any surface without touching the world', async () => {
    const fixture = TestBed.createComponent(Viewport);
    await fixture.whenStable();
    const session = TestBed.inject(Session);
    const before = session.hash();
    expect(session.exec('view.mode', { mode: 'walk' }).ok).toBe(true);
    expect(session.exec('view.focus', { target: 'backplate' }).ok).toBe(true);
    expect(session.hash()).toBe(before);
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

  it('does not expose the E2E hook without ?e2e=1', async () => {
    const fixture = TestBed.createComponent(Viewport);
    await fixture.whenStable();
    expect((window as unknown as Record<string, unknown>)['__controlsViewport']).toBeUndefined();
  });
});
