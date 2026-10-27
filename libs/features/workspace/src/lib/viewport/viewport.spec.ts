import { TestBed } from '@angular/core/testing';
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

  it('does not expose the E2E hook without ?e2e=1', async () => {
    const fixture = TestBed.createComponent(Viewport);
    await fixture.whenStable();
    expect((window as unknown as Record<string, unknown>)['__controlsViewport']).toBeUndefined();
  });
});
