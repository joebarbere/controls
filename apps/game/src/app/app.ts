import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  inject,
  Injector,
  resource,
  signal,
  viewChild,
} from '@angular/core';
import { AboutDialog, Hud, MainMenu, NotificationService, Notifications, ShellState } from '@controls/feature-shell';
import { SettingsDialog, SettingsStore } from '@controls/feature-settings';
import { Workspace } from '@controls/feature-workspace';
import { Button } from '@controls/ui';
import { PLATFORM } from './platform.token';

/**
 * Assembles the shell: the workspace (always mounted; behind the main menu it is the 3D backdrop),
 * the main menu, the settings and about dialogs, the HUD and notifications. Navigation is UI-only
 * state in {@link ShellState}; world changes will go through the command registry (F1.2).
 */
@Component({
  selector: 'ctl-root',
  imports: [Workspace, MainMenu, AboutDialog, SettingsDialog, Hud, Notifications, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'onEscape($event)' },
  template: `
    <ctl-workspace
      [chrome]="!shell.menuOpen()"
      [attr.inert]="shell.menuOpen() ? '' : null"
      [layout]="settings.settings().workspace.layout"
      (layoutChange)="settings.update('workspace', { layout: $event })"
      (layoutReset)="notifications.notify('Layout reset.')"
      (backendChange)="backend.set($event)"
    >
      <button ctlButton="ghost" type="button" ctlWorkspaceToolbar (click)="openMenu()">Menu</button>
      @if (!shell.menuOpen()) {
        <ctl-hud ctlViewportOverlay [mode]="shell.mode()" />
      }
    </ctl-workspace>
    @if (shell.menuOpen()) {
      <ctl-main-menu
        [sessionActive]="shell.sessionActive()"
        [canQuit]="platform.canQuit"
        (resumeGame)="resume()"
        (newSandbox)="newSandbox()"
        (openSettings)="shell.openDialog('settings')"
        (openAbout)="shell.openDialog('about')"
        (quitGame)="platform.quit()"
      />
    }
    <ctl-settings-dialog [open]="shell.dialog() === 'settings'" (openChange)="dialogOpenChange($event)" />
    <ctl-about-dialog
      [open]="shell.dialog() === 'about'"
      (openChange)="dialogOpenChange($event)"
      [info]="info.value()"
      [backend]="backend()"
      [isolated]="isolated"
    />
    <ctl-notifications />
  `,
  styleUrl: './app.scss',
})
export class App {
  protected readonly platform = inject(PLATFORM);
  protected readonly shell = inject(ShellState);
  protected readonly settings = inject(SettingsStore);
  protected readonly notifications = inject(NotificationService);
  protected readonly info = resource({ loader: () => this.platform.getAppInfo() });
  protected readonly backend = signal<string>('starting…');
  /** SharedArrayBuffer (sim worker snapshots) needs cross-origin isolation — see docs/caveats/electron.md. */
  protected readonly isolated = globalThis.crossOriginIsolated === true;
  private readonly workspace = viewChild.required(Workspace);
  private readonly injector = inject(Injector);

  protected newSandbox(): void {
    this.shell.newSandbox();
    this.focusViewportAfterRender();
  }

  protected resume(): void {
    this.shell.resume();
    this.focusViewportAfterRender();
  }

  protected openMenu(): void {
    this.shell.openMenu(); // the menu focuses its first item (Resume) when it appears
  }

  protected dialogOpenChange(open: boolean): void {
    if (!open) this.shell.closeDialog();
  }

  /**
   * Escape opens the menu from the workspace and resumes from the menu. Dialogs handle their own
   * Escape first (and mark the event handled). TODO(F1.4): bind through the keybinding service.
   */
  protected onEscape(event: Event): void {
    if (event.defaultPrevented || this.shell.dialog()) return;
    if (!this.shell.menuOpen()) this.openMenu();
    else if (this.shell.sessionActive()) this.resume();
  }

  private focusViewportAfterRender(): void {
    afterNextRender(() => this.workspace().focusViewport(), { injector: this.injector });
  }
}
