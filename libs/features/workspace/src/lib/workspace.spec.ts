import { ChangeDetectionStrategy, Component, output, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { Session } from '@controls/feature-session';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  normaliseLayout,
  parseWorkspaceLayout,
  serialiseWorkspaceLayout,
  type WorkspaceLayout,
} from './layout';
import { Viewport } from './viewport/viewport';
import { Workspace } from './workspace';

/** jsdom has no WebGL/WebGPU; the real viewport is covered by the e2e suites. */
@Component({
  selector: 'ctl-viewport',
  template: '<canvas tabindex="0" aria-label="3D workspace"></canvas>',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class FakeViewport {
  readonly backendChange = output<string>();
}

@Component({
  selector: 'ctl-workspace-host',
  imports: [Workspace],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ctl-workspace [chrome]="chrome()" [(layout)]="layout" (layoutReset)="resets = resets + 1">
      <button type="button" ctlWorkspaceToolbar>Menu</button>
      <p ctlInspector>Selected: panel</p>
    </ctl-workspace>
  `,
})
class Host {
  readonly chrome = signal(true);
  readonly layout = signal<WorkspaceLayout>(DEFAULT_WORKSPACE_LAYOUT);
  readonly workspace = viewChild.required(Workspace);
  resets = 0;
}

async function setup() {
  TestBed.overrideComponent(Workspace, { remove: { imports: [Viewport] }, add: { imports: [FakeViewport] } });
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  return { fixture, host: fixture.componentInstance, user: userEvent.setup() };
}

describe('Workspace', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it('docks the viewport, an inspector and a console panel, with projected content and placeholders', async () => {
    await setup();
    expect(screen.getByRole('region', { name: '3D viewport' })).toBeTruthy();
    const inspector = screen.getByRole('region', { name: 'Inspector' });
    expect(within(inspector).getByText('Selected: panel')).toBeTruthy();
    const consolePanel = screen.getByRole('region', { name: 'Console' });
    expect(within(consolePanel).getByText('The developer console will dock here.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Menu' })).toBeTruthy();
    expect(screen.getByRole('separator', { name: 'Resize inspector' })).toBeTruthy();
    expect(screen.getByRole('separator', { name: 'Resize console' })).toBeTruthy();
  });

  it('resizes panels from the keyboard and writes the layout back', async () => {
    const { fixture, host, user } = await setup();
    screen.getByRole('separator', { name: 'Resize inspector' }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(host.layout().inspector.size).toBe(336);
    screen.getByRole('separator', { name: 'Resize console' }).focus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(host.layout().bottom.size).toBe(232);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('ctl-workspace')?.getAttribute('style')).toContain(
      '--ctl-inspector-size: 336px',
    );
  });

  it('collapses and restores panels from the toolbar toggles and the splitter', async () => {
    const { fixture, host, user } = await setup();
    const toggle = screen.getByRole('button', { name: 'Inspector' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await user.click(toggle);
    await fixture.whenStable();
    expect(host.layout().inspector.collapsed).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Inspector' })).toBeNull();

    screen.getByRole('separator', { name: 'Resize console' }).focus();
    await user.keyboard('{Enter}');
    expect(host.layout().bottom.collapsed).toBe(true);
    await user.keyboard('{Enter}');
    expect(host.layout().bottom.collapsed).toBe(false);
  });

  it('resets the layout through the view.resetLayout command and reports it', async () => {
    const { fixture, host, user } = await setup();
    const session = TestBed.inject(Session);
    const hash = await session.hashAt();
    host.layout.set({ inspector: { size: 500, collapsed: true }, bottom: { size: 120, collapsed: true } });
    await fixture.whenStable();
    await user.click(screen.getByRole('button', { name: 'Reset layout' }));
    expect(host.layout()).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    expect(host.resets).toBe(1);
    // A view command: logged, but the world (and its hash) is unchanged.
    expect(session.entries().map((e) => e.id)).toEqual(['view.resetLayout']);
    expect(await session.hashAt()).toBe(hash);
  });

  it('resets the layout when view.resetLayout runs from another surface', async () => {
    const { fixture, host } = await setup();
    host.layout.set({ inspector: { size: 500, collapsed: true }, bottom: { size: 120, collapsed: true } });
    await fixture.whenStable();
    expect(TestBed.inject(Session).exec('view.resetLayout').ok).toBe(true);
    expect(host.layout()).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    expect(host.resets).toBe(1);
    fixture.destroy();
    TestBed.inject(Session).exec('view.resetLayout'); // the destroyed workspace no longer listens
    expect(host.resets).toBe(1);
  });

  it('shows only the viewport when chrome is off (main-menu backdrop) and can focus it', async () => {
    const { fixture, host } = await setup();
    host.chrome.set(false);
    await fixture.whenStable();
    expect(screen.queryByRole('region', { name: 'Inspector' })).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset layout' })).toBeNull();
    host.workspace().focusViewport();
    expect(document.activeElement).toBe(screen.getByLabelText('3D workspace'));
    // One focus target: the region around the canvas is a landmark, not a tab stop.
    expect(screen.getByRole('region', { name: '3D viewport' }).hasAttribute('tabindex')).toBe(false);
    expect(host.workspace().viewState()).toBeUndefined(); // the fake viewport has no renderer
  });
});

@Component({
  selector: 'ctl-console-host',
  imports: [Workspace],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ctl-workspace [chrome]="chrome()" [(layout)]="layout">
      <button type="button" ctlWorkspaceToolbar>Menu</button>
      <div ctlBottomPanel>
        <button type="button">Output</button>
        <input aria-label="Console input" data-autofocus />
      </div>
    </ctl-workspace>
  `,
})
class ConsoleHost {
  readonly chrome = signal(true);
  readonly layout = signal<WorkspaceLayout>(DEFAULT_WORKSPACE_LAYOUT);
}

describe('Workspace console.toggle (F1.5)', () => {
  afterEach(() => (document.body.innerHTML = ''));

  async function setupConsole() {
    TestBed.overrideComponent(Workspace, { remove: { imports: [Viewport] }, add: { imports: [FakeViewport] } });
    const fixture = TestBed.createComponent(ConsoleHost);
    document.body.appendChild(fixture.nativeElement);
    await fixture.whenStable();
    return { fixture, host: fixture.componentInstance, session: TestBed.inject(Session) };
  }

  it('opens the collapsed bottom panel and focuses its [data-autofocus] element, then closes back to the opener', async () => {
    const { fixture, host, session } = await setupConsole();
    host.layout.set({ ...DEFAULT_WORKSPACE_LAYOUT, bottom: { size: 200, collapsed: true } });
    await fixture.whenStable();
    const menu = screen.getByRole('button', { name: 'Menu' });
    menu.focus();

    expect(session.exec('console.toggle').ok).toBe(true);
    await fixture.whenStable();
    expect(host.layout().bottom.collapsed).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Console input' }));

    session.exec('console.toggle'); // focus is in the panel: close it
    await fixture.whenStable();
    expect(host.layout().bottom.collapsed).toBe(true);
    expect(document.activeElement).toBe(menu);
  });

  it('focuses an open console without closing it, and falls back to the viewport', async () => {
    const { fixture, host, session } = await setupConsole();
    (document.activeElement as HTMLElement | null)?.blur();
    session.exec('console.toggle'); // already open (the default layout), focus elsewhere
    await fixture.whenStable();
    expect(host.layout().bottom.collapsed).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Console input' }));
    session.exec('console.toggle'); // the opener was <body>: focus the viewport instead
    await fixture.whenStable();
    expect(document.activeElement).toBe(screen.getByLabelText('3D workspace'));
  });

  it('does nothing behind the main menu', async () => {
    const { fixture, host, session } = await setupConsole();
    host.chrome.set(false);
    await fixture.whenStable();
    session.exec('console.toggle');
    await fixture.whenStable();
    expect(host.layout()).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });
});

describe('normaliseLayout', () => {
  it('clamps sizes into the panel limits, rounds them and coerces flags', () => {
    expect(
      normaliseLayout({
        inspector: { size: 10_000, collapsed: false },
        bottom: { size: Number.NaN, collapsed: 'yes' as unknown as boolean },
      }),
    ).toEqual({ inspector: { size: 640, collapsed: false }, bottom: { size: 96, collapsed: false } });
    expect(
      normaliseLayout({ inspector: { size: 250.4, collapsed: true }, bottom: { size: 1, collapsed: false } }),
    ).toEqual({ inspector: { size: 250, collapsed: true }, bottom: { size: 96, collapsed: false } });
  });
});

describe('workspace layout in settings (opaque JSON)', () => {
  const layout: WorkspaceLayout = {
    inspector: { size: 400, collapsed: true },
    bottom: { size: 150, collapsed: false },
  };

  it('round-trips through the stored form, tagged so a future format can migrate it', () => {
    const stored = serialiseWorkspaceLayout(layout);
    expect(stored).toEqual({ kind: 'split-panes', version: 1, ...layout });
    expect(parseWorkspaceLayout(JSON.parse(JSON.stringify(stored)))).toEqual(layout);
  });

  it.each([
    ['null (the schema default)', null],
    ['another layout format', { kind: 'dockview', version: 1 }],
    ['a newer version', { ...serialiseWorkspaceLayout(layout), version: 2 }],
    ['extra keys', { ...serialiseWorkspaceLayout(layout), extra: true }],
    ['a wrong type', { ...serialiseWorkspaceLayout(layout), inspector: { size: '400', collapsed: true } }],
    ['a string', 'split-panes'],
  ])('falls back to the default layout for %s', (_name, stored) => {
    expect(parseWorkspaceLayout(stored)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
  });

  it('clamps an out-of-range stored size instead of discarding the layout', () => {
    const stored = { ...serialiseWorkspaceLayout(layout), inspector: { size: 5000, collapsed: false } };
    expect(parseWorkspaceLayout(stored).inspector).toEqual({ size: 640, collapsed: false });
  });
});
