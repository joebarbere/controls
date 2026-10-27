import { ChangeDetectionStrategy, Component, output, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { DEFAULT_WORKSPACE_LAYOUT, normaliseLayout, type WorkspaceLayout } from './layout';
import { Viewport } from './viewport/viewport';
import { Workspace } from './workspace';

/** jsdom has no WebGL/WebGPU; the real viewport is covered by the e2e suites. */
@Component({ selector: 'ctl-viewport', template: '', changeDetection: ChangeDetectionStrategy.OnPush })
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

  it('resets the layout and reports it', async () => {
    const { fixture, host, user } = await setup();
    host.layout.set({ inspector: { size: 500, collapsed: true }, bottom: { size: 120, collapsed: true } });
    await fixture.whenStable();
    await user.click(screen.getByRole('button', { name: 'Reset layout' }));
    expect(host.layout()).toEqual(DEFAULT_WORKSPACE_LAYOUT);
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
    expect(document.activeElement).toBe(screen.getByRole('region', { name: '3D viewport' }));
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
