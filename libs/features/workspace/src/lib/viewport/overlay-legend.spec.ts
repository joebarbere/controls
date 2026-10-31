import { TestBed } from '@angular/core/testing';
import { Session } from '@controls/feature-session';
import { SettingsStore } from '@controls/feature-settings';
import { ViewportRenderer, type OverlayLegendState } from '@controls/renderer';
import { OverlayLegend } from './overlay-legend';
import { Viewport } from './viewport';

const state = (s: Partial<OverlayLegendState>): OverlayLegendState => ({
  voltage: false,
  current: false,
  bands: [],
  noScale: false,
  unknown: false,
  ...s,
});

async function legend(s: Partial<OverlayLegendState>, reducedMotion = false) {
  const fixture = TestBed.createComponent(OverlayLegend);
  fixture.componentRef.setInput('state', state(s));
  fixture.componentRef.setInput('reducedMotion', reducedMotion);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}
/** The visible text, one space between paragraphs and list items. */
const text = (el: Element | null) => {
  if (!el) return '';
  const parts = el.matches('p') ? [el] : Array.from(el.querySelectorAll('p, li'));
  return parts.map((p) => p.textContent?.replace(/\s+/g, ' ').trim()).join(' ');
};

describe('OverlayLegend', () => {
  it('names a voltage scale and its ticks in text, not colour alone', async () => {
    const el = await legend({ voltage: true, bands: ['dc12'] });
    const scale = el.querySelector('[data-testid="legend-voltage-scale"]');
    expect(text(scale)).toBe(
      '|V| to the island reference, 12 V DC scale 0 V 4 V 8 V 12 V (nominal) 16 V over 16 V (magenta)',
    );
    expect(el.querySelector('section')?.getAttribute('aria-label')).toBe('Overlay legend');
    expect(el.querySelector('.bar')?.getAttribute('aria-hidden')).toBe('true'); // the colours are decoration
    expect(el.querySelector('[data-testid="legend-no-scale"]')).toBeNull();
  });

  it('says when there is no voltage scale (band 0) and when there is no reading', async () => {
    const el = await legend({ voltage: true, noScale: true, unknown: true });
    expect(el.querySelector('[data-testid="legend-voltage-scale"]')).toBeNull();
    expect(text(el.querySelector('[data-testid="legend-no-scale"]'))).toBe(
      'No nominal band: no voltage scale (light grey)',
    );
    expect(text(el.querySelector('[data-testid="legend-unknown"]'))).toContain('No reading');
  });

  it('describes the current scale and how its arrows move, static under reduced motion', async () => {
    const moving = await legend({ current: true });
    expect(text(moving.querySelector('[data-testid="legend-current-scale"]'))).toBe(
      '|I| along each lead (log scale) 1 mA 10 mA 100 mA 1 A 10 A 100 A over 100 A (magenta)',
    );
    expect(text(moving.querySelector('[data-testid="legend-current-motion"]'))).toContain(
      'Arrows travel with DC current',
    );
    const still = await legend({ current: true }, true);
    expect(text(still.querySelector('[data-testid="legend-current-motion"]'))).toContain(
      'stand still (reduced motion)',
    );
    expect(still.textContent).toContain('AC shows magnitude only');
  });
});

describe('Viewport overlays', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined); // jsdom has no WebGL/WebGPU
  });

  it('applies view.overlay from any surface to the renderer, and subscribes it to the sim host', async () => {
    const setOverlay = vi.spyOn(ViewportRenderer.prototype, 'setOverlay');
    const attach = vi.spyOn(ViewportRenderer.prototype, 'attachSnapshots');
    const fixture = TestBed.createComponent(Viewport);
    await fixture.whenStable();
    expect(attach).toHaveBeenCalledTimes(1);
    const session = TestBed.inject(Session);
    expect(session.exec('view.overlay', { name: 'voltage', on: true }).ok).toBe(true);
    expect(session.exec('view.overlay', { name: 'current', on: false }).ok).toBe(true);
    expect(setOverlay.mock.calls).toStrictEqual([
      ['voltage', true],
      ['current', false],
    ]);
    expect(session.entries().map((e) => e.id)).toEqual(['view.overlay', 'view.overlay']);
    fixture.destroy();
    session.exec('view.overlay', { name: 'voltage', on: false });
    expect(setOverlay).toHaveBeenCalledTimes(2); // unsubscribed with the component
  });

  it('reduces motion from the setting, and from prefers-reduced-motion while it says system', async () => {
    const reduce = vi.spyOn(ViewportRenderer.prototype, 'setReducedMotion');
    let listener: ((e: { matches: boolean }) => void) | null = null;
    const query = {
      matches: false,
      addEventListener: vi.fn((_: string, l: (e: { matches: boolean }) => void) => (listener = l)),
      removeEventListener: vi.fn(),
    };
    // jsdom has no matchMedia: give the window one for this test.
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => query) });
    const fixture = TestBed.createComponent(Viewport);
    await fixture.whenStable();
    expect(reduce).toHaveBeenLastCalledWith(false);
    (listener as unknown as (e: { matches: boolean }) => void)({ matches: true });
    await fixture.whenStable();
    expect(reduce).toHaveBeenLastCalledWith(true);
    const settings = TestBed.inject(SettingsStore);
    settings.update('display', { reducedMotion: 'full' });
    await fixture.whenStable();
    expect(reduce).toHaveBeenLastCalledWith(false);
    settings.update('display', { reducedMotion: 'reduce' });
    await fixture.whenStable();
    expect(reduce).toHaveBeenLastCalledWith(true);
    fixture.destroy();
    expect(query.removeEventListener).toHaveBeenCalledTimes(1);
    delete (window as { matchMedia?: unknown }).matchMedia;
  });
});
