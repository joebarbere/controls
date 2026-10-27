import { TestBed } from '@angular/core/testing';
import { KeybindingService, Session } from '@controls/feature-session';
import {
  MemorySettingsService,
  provideKeybindingOverridesFromSettings,
  SettingsStore,
} from '@controls/feature-settings';
import type { Platform } from '@controls/platform-api';
import { defaultSettings } from '@controls/save-format';
import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { App } from './app';
import { provideSettingsFromPlatform } from './app.config';
import { PLATFORM } from './platform.token';

describe('App', () => {
  const quit = vi.fn();
  let settings: MemorySettingsService;
  const fakePlatform: Platform = {
    kind: 'electron',
    getAppInfo: async () => ({
      appVersion: '9.8.7',
      platform: 'linux',
      arch: 'x64',
      isPackaged: true,
      versions: { electron: '45.0.0' },
    }),
    get settings() {
      return settings;
    },
    canQuit: true,
    quit,
  };

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined); // jsdom has no WebGL/WebGPU
    quit.mockReset();
    settings = new MemorySettingsService();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        { provide: PLATFORM, useValue: fakePlatform },
        provideSettingsFromPlatform(),
        provideKeybindingOverridesFromSettings(),
      ],
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
    const canvas = () => document.querySelector('ctl-viewport canvas');
    await user.keyboard('{Enter}'); // New sandbox
    await fixture.whenStable();
    expect(screen.queryByRole('navigation', { name: 'Controls' })).toBeNull();
    expect(document.activeElement).toBe(canvas()); // the canvas is the single viewport focus target
    expect(screen.getByRole('region', { name: '3D viewport' }).hasAttribute('tabindex')).toBe(false);
    expect(screen.getByRole('region', { name: 'Status' }).textContent).toContain('Work');
    expect(screen.getByRole('region', { name: 'Inspector' })).toBeTruthy();

    screen.getByRole('button', { name: 'Menu' }).focus();
    await user.keyboard('{Escape}');
    await fixture.whenStable();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Resume' }));

    await user.keyboard('{Escape}');
    await fixture.whenStable();
    expect(document.activeElement).toBe(canvas());

    await user.click(screen.getByRole('button', { name: 'Menu' }));
    await fixture.whenStable();
    await user.keyboard('{Enter}'); // Resume
    await fixture.whenStable();
    expect(document.activeElement).toBe(canvas());
  });

  it('selects tool-belt slots from the keyboard and keeps rebinding in settings (F1.4)', async () => {
    const { fixture, user } = await setup();
    await user.keyboard('{Enter}'); // New sandbox
    await fixture.whenStable();
    const tool = () => screen.getByTestId('hud-tool').textContent;
    expect(tool()).toBe('None');
    await user.keyboard('3');
    await fixture.whenStable();
    expect(tool()).toBe('3: Spool');
    await user.keyboard('4');
    await fixture.whenStable();
    expect(tool()).toBe('4: Empty');
    expect(
      TestBed.inject(Session)
        .entries()
        .map((e) => e.args),
    ).toEqual([{ slot: 3 }, { slot: 4 }]);

    TestBed.inject(KeybindingService).setBinding('toolbelt.select.slot2', 'Q');
    expect(TestBed.inject(SettingsStore).settings().controls.keybindings).toEqual({ 'toolbelt.select.slot2': 'Q' });
    await user.keyboard('q');
    await fixture.whenStable();
    expect(tool()).toBe('2: Crate');
  });

  it('does not open the menu for an Escape an inner handler already consumed', async () => {
    const { fixture, user } = await setup();
    await user.keyboard('{Enter}'); // New sandbox
    await fixture.whenStable();
    const canvas = document.querySelector('ctl-viewport canvas') as HTMLElement;
    canvas.addEventListener('keydown', (e) => e.preventDefault()); // as the renderer does (clear selection)
    await user.keyboard('{Escape}');
    await fixture.whenStable();
    expect(screen.queryByRole('navigation', { name: 'Controls' })).toBeNull();
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
    expect(TestBed.inject(SettingsStore).settings().workspace.layout).toEqual({
      kind: 'split-panes',
      version: 1,
      inspector: { size: 336, collapsed: false },
      bottom: { size: 200, collapsed: false },
    });
    await user.click(screen.getByRole('button', { name: 'Reset layout' }));
    await fixture.whenStable();
    expect(screen.getByRole('separator', { name: 'Resize inspector' }).getAttribute('aria-valuenow')).toBe('320');
    expect(screen.getByRole('status').textContent).toContain('Layout reset.');
  });

  it('restores a stored layout at start-up, and ignores an unrecognised one', async () => {
    const layout = {
      kind: 'split-panes',
      version: 1,
      inspector: { size: 480, collapsed: false },
      bottom: { size: 150, collapsed: true },
    };
    settings = new MemorySettingsService({ ...defaultSettings(), workspace: { layout } });
    const { fixture, user } = await setup();
    await TestBed.inject(SettingsStore).loaded;
    await user.click(screen.getByRole('button', { name: 'New sandbox' }));
    await fixture.whenStable();
    expect(screen.getByRole('separator', { name: 'Resize inspector' }).getAttribute('aria-valuenow')).toBe('480');
    expect(screen.queryByRole('region', { name: 'Console' })).toBeNull(); // collapsed

    TestBed.inject(SettingsStore).update('workspace', { layout: { dockview: 'tree' } });
    await fixture.whenStable();
    expect(screen.getByRole('separator', { name: 'Resize inspector' }).getAttribute('aria-valuenow')).toBe('320');
  });

  it('quits through the platform', async () => {
    const { user } = await setup();
    await user.click(screen.getByRole('button', { name: 'Quit' }));
    expect(quit).toHaveBeenCalledOnce();
  });
});
