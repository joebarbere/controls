import { TestBed } from '@angular/core/testing';
import { KEY_PLATFORM, KeybindingService, Session } from '@controls/feature-session';
import { Viewport } from './viewport';

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
      '3D workspace. Click to select. [ and ] cycle selection, F focuses it, V toggles walk and work mode, W A S D walk.',
    );
    TestBed.inject(KeybindingService).setBinding('input.moveForward', 'I');
    TestBed.inject(KeybindingService).setBinding('input.toggleMode', null);
    await fixture.whenStable();
    expect(canvas.getAttribute('aria-label')).toContain('unbound toggles walk and work mode, I A S D walk.');
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
