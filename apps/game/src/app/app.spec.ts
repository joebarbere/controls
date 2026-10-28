import { TestBed } from '@angular/core/testing';
import { KeybindingService, Session } from '@controls/feature-session';
import {
  MemorySettingsService,
  provideKeybindingOverridesFromSettings,
  SettingsStore,
} from '@controls/feature-settings';
import type { Platform } from '@controls/platform-api';
import { defaultSettings } from '@controls/save-format';
import { screen, waitFor } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { App } from './app';
import { provideSettingsFromPlatform } from './app.config';
import { provideSandboxLevel } from './levels';
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
        provideSandboxLevel(),
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
    await user.keyboard('{Enter}'); // Start, with the dialog's fresh seed
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

  it('New sandbox asks for a seed and starts the workshop with it (F1.9)', async () => {
    const { fixture, user } = await setup();
    const session = TestBed.inject(Session);
    await user.keyboard('{Enter}'); // New sandbox
    await fixture.whenStable();
    const dialog = screen.getByRole('dialog', { name: 'New sandbox' });
    expect(dialog).toBeTruthy();
    const seed = screen.getByRole('textbox', { name: 'Seed' }) as HTMLInputElement;
    expect(document.activeElement).toBe(seed);
    expect(seed.value).toMatch(/^\d+$/); // a fresh seed
    await user.clear(seed);
    await user.type(seed, '31337{Enter}');
    await fixture.whenStable();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(session.world().seed).toBe(31337);
    expect(session.world().fixtures.map((f) => f.id)).toContain('stud-wall');
    expect(session.world().difficulty).toBe(TestBed.inject(SettingsStore).settings().gameplay.defaultDifficulty);
    expect(session.entries()).toEqual([]);
    expect(document.activeElement).toBe(document.querySelector('ctl-viewport canvas'));

    // Escape on the dialog goes back to the menu without starting anything.
    screen.getByRole('button', { name: 'Menu' }).click();
    await fixture.whenStable();
    screen.getByRole('button', { name: 'New sandbox' }).focus();
    await user.keyboard('{Enter}');
    await fixture.whenStable();
    await user.keyboard('{Escape}');
    await fixture.whenStable();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New sandbox' }));
    expect(session.world().seed).toBe(31337);
  });

  it('selects tool-belt slots from the keyboard and keeps rebinding in settings (F1.4)', async () => {
    const { fixture, user } = await setup();
    await user.keyboard('{Enter}'); // New sandbox
    await fixture.whenStable();
    await user.keyboard('{Enter}'); // Start, with the dialog's fresh seed
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

  it('toggles the dev console with backtick from the viewport and from inside it (F1.5)', async () => {
    // jsdom has no layout: CodeMirror measures text with Range rects (ui caveats).
    Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect ??= () => new DOMRect();
    const { fixture, user } = await setup();
    const session = TestBed.inject(Session);
    expect(session.isEnabled('console.toggle')).toBe(false); // not in the main menu
    await user.keyboard('{Enter}'); // New sandbox
    await fixture.whenStable();
    await user.keyboard('{Enter}'); // Start, with the dialog's fresh seed
    await fixture.whenStable();
    expect(session.isEnabled('console.toggle')).toBe(true);
    const canvas = document.querySelector('ctl-viewport canvas');
    expect(document.activeElement).toBe(canvas);
    await waitFor(() => expect(document.querySelector('[data-editor="ready"]')).toBeTruthy());

    await user.keyboard('[Backquote]'); // by code: user-event's key map has no backtick
    await fixture.whenStable();
    const input = screen.getByRole('textbox', { name: 'Console input' });
    expect(document.activeElement).toBe(input);

    await user.keyboard('[Backquote]'); // a global binding: it fires while typing in the console, and types nothing
    await fixture.whenStable();
    expect(input.textContent).toBe('');
    expect(screen.queryByRole('region', { name: 'Console' })).toBeNull(); // collapsed
    expect(document.activeElement).toBe(canvas);
    expect(session.entries()).toEqual([]); // console.toggle is UI chrome: never logged
  });

  it('does not open the menu for an Escape an inner handler already consumed', async () => {
    const { fixture, user } = await setup();
    await user.keyboard('{Enter}'); // New sandbox
    await fixture.whenStable();
    await user.keyboard('{Enter}'); // Start, with the dialog's fresh seed
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
    await user.click(screen.getByRole('button', { name: 'Start' }));
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
    expect(screen.getAllByRole('status').map((s) => s.textContent)).toContainEqual(
      expect.stringContaining('Layout reset.'),
    );
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
    await user.click(screen.getByRole('button', { name: 'Start' }));
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
