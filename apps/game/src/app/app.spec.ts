import { TestBed } from '@angular/core/testing';
import type { Platform } from '@controls/platform-api';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { App } from './app';
import { PLATFORM } from './platform.token';

describe('App', () => {
  const quit = vi.fn();
  const fakePlatform: Platform = {
    kind: 'electron',
    getAppInfo: async () => ({
      appVersion: '9.8.7',
      platform: 'linux',
      arch: 'x64',
      isPackaged: true,
      versions: { electron: '45.0.0' },
    }),
    canQuit: true,
    quit,
  };

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined); // jsdom has no WebGL/WebGPU
    quit.mockReset();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: PLATFORM, useValue: fakePlatform }],
    }).compileComponents();
  });

  afterEach(() => (document.body.innerHTML = ''));

  async function setup() {
    const fixture = TestBed.createComponent(App);
    document.body.appendChild(fixture.nativeElement);
    await fixture.whenStable();
    return { fixture, user: userEvent.setup() };
  }

  it('boots to the main menu over the viewport, with the about box values available', async () => {
    const { fixture } = await setup();
    const el = fixture.nativeElement as HTMLElement;
    expect(screen.getByRole('heading', { level: 1, name: 'Controls' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New sandbox' }));
    expect(el.querySelector('ctl-viewport')).toBeTruthy();
    expect(el.querySelector('ctl-workspace')?.hasAttribute('inert')).toBe(true);
    expect(el.querySelector('[data-testid="about-version"]')?.textContent).toBe('9.8.7');
    expect(el.querySelector('[data-testid="about-platform"]')?.textContent).toContain('Electron 45.0.0');
  });

  it('runs New sandbox, Escape to the menu, Resume, all from the keyboard', async () => {
    const { fixture, user } = await setup();
    await user.keyboard('{Enter}'); // New sandbox
    await fixture.whenStable();
    expect(screen.queryByRole('navigation', { name: 'Controls' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('region', { name: '3D viewport' }));
    expect(screen.getByRole('region', { name: 'Status' }).textContent).toContain('Work');
    expect(screen.getByRole('region', { name: 'Inspector' })).toBeTruthy();

    await user.keyboard('{Escape}');
    await fixture.whenStable();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Resume' }));

    await user.keyboard('{Escape}');
    await fixture.whenStable();
    expect(document.activeElement).toBe(screen.getByRole('region', { name: '3D viewport' }));

    await user.click(screen.getByRole('button', { name: 'Menu' }));
    await fixture.whenStable();
    await user.keyboard('{Enter}'); // Resume
    await fixture.whenStable();
    expect(document.activeElement).toBe(screen.getByRole('region', { name: '3D viewport' }));
  });

  it('opens settings and about from the menu, and Escape closes the dialog only', async () => {
    const { fixture, user } = await setup();
    const settingsButton = screen.getByRole('button', { name: 'Settings' });
    await user.click(settingsButton);
    await fixture.whenStable();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await fixture.whenStable();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Controls' })).toBeTruthy();
    expect(document.activeElement).toBe(settingsButton);

    await user.click(screen.getByRole('button', { name: 'About' }));
    await fixture.whenStable();
    expect(screen.getByRole('dialog', { name: 'About Controls' })).toBeTruthy();
  });

  it('persists a layout change in settings and confirms Reset layout with a notification', async () => {
    const { fixture, user } = await setup();
    await user.click(screen.getByRole('button', { name: 'New sandbox' }));
    await fixture.whenStable();
    screen.getByRole('separator', { name: 'Resize inspector' }).focus();
    await user.keyboard('{ArrowLeft}');
    await fixture.whenStable();
    expect(screen.getByRole('separator', { name: 'Resize inspector' }).getAttribute('aria-valuenow')).toBe('336');
    await user.click(screen.getByRole('button', { name: 'Reset layout' }));
    await fixture.whenStable();
    expect(screen.getByRole('separator', { name: 'Resize inspector' }).getAttribute('aria-valuenow')).toBe('320');
    expect(screen.getByRole('status').textContent).toContain('Layout reset.');
  });

  it('quits through the platform', async () => {
    const { user } = await setup();
    await user.click(screen.getByRole('button', { name: 'Quit' }));
    expect(quit).toHaveBeenCalledOnce();
  });
});
