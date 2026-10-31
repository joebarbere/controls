import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  Injector,
  isDevMode,
  resource,
  signal,
  viewChild,
} from '@angular/core';
import { DevConsoleComponent, isConsoleAvailable } from '@controls/feature-console';
import {
  AboutDialog,
  Hud,
  MainMenu,
  NewGameDialog,
  NotificationService,
  Notifications,
  ShellState,
} from '@controls/feature-shell';
import { CommandPalette } from '@controls/feature-palette';
import { LoadGameDialog, SaveGameDialog, SaveGames, SaveThumbnails } from '@controls/feature-saves';
import { KeybindingService, Session, type SimCrash, ToolBelt } from '@controls/feature-session';
import { EVENT_TOAST_COALESCE_MS, type SimEvent } from '@controls/sim-protocol';
import { SettingsDialog, SettingsStore } from '@controls/feature-settings';
import { parseWorkspaceLayout, serialiseWorkspaceLayout, Workspace } from '@controls/feature-workspace';
import { Button } from '@controls/ui';
import { PLATFORM } from './platform.token';

/**
 * Assembles the shell: the workspace (always mounted; behind the main menu it is the 3D backdrop),
 * the main menu, the settings and about dialogs, the HUD and notifications. Navigation is UI-only
 * state in {@link ShellState}; world changes go through the command registry via {@link Session}.
 */
@Component({
  selector: 'ctl-root',
  imports: [
    Workspace,
    MainMenu,
    AboutDialog,
    NewGameDialog,
    SettingsDialog,
    Hud,
    Notifications,
    Button,
    CommandPalette,
    DevConsoleComponent,
    LoadGameDialog,
    SaveGameDialog,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'onEscape($event)' },
  template: `
    <ctl-workspace
      [chrome]="!shell.menuOpen()"
      [attr.inert]="shell.menuOpen() ? '' : null"
      [layout]="layout()"
      (layoutChange)="settings.update('workspace', { layout: serialiseLayout($event) })"
      (layoutReset)="notifications.notify('Layout reset.')"
      (backendChange)="backend.set($event)"
    >
      <button ctlButton="ghost" type="button" ctlWorkspaceToolbar (click)="openMenu()">Menu</button>
      <ctl-dev-console ctlBottomPanel [available]="consoleAvailable()" />
      @if (!shell.menuOpen()) {
        <ctl-hud
          ctlViewportOverlay
          [mode]="viewState()?.mode ?? 'work'"
          [selection]="viewState()?.selected?.label ?? null"
          [tool]="toolLabel()"
          [assisted]="session.world().assisted"
        />
      }
    </ctl-workspace>
    @if (shell.menuOpen()) {
      <ctl-main-menu
        [sessionActive]="shell.sessionActive()"
        [canQuit]="platform.canQuit"
        [canContinue]="saves.canContinue()"
        (resumeGame)="resume()"
        (saveGame)="shell.openDialog('save')"
        (newSandbox)="newSandbox()"
        (continueGame)="continueGame()"
        (loadGame)="session.exec('file.load')"
        (openSettings)="shell.openDialog('settings')"
        (openAbout)="shell.openDialog('about')"
        (quitGame)="platform.quit()"
      />
    }
    <ctl-new-game-dialog
      [open]="shell.dialog() === 'newGame'"
      (openChange)="dialogOpenChange($event)"
      (start)="startSandbox($event)"
    />
    <ctl-save-game-dialog [open]="shell.dialog() === 'save'" (openChange)="dialogOpenChange($event)" />
    <ctl-load-game-dialog [open]="shell.dialog() === 'load'" (openChange)="dialogOpenChange($event)" />
    <ctl-settings-dialog [open]="shell.dialog() === 'settings'" (openChange)="dialogOpenChange($event)" />
    <ctl-about-dialog
      [open]="shell.dialog() === 'about'"
      (openChange)="dialogOpenChange($event)"
      [info]="info.value()"
      [backend]="backend()"
      [isolated]="isolated"
    />
    <ctl-command-palette />
    <ctl-notifications />
    <!-- A load's sim check runs in the worker; say so while it does (ADR 0011 §10). -->
    <p class="checking" role="status" data-testid="checking-save">{{ saves.loading() ? 'Checking save…' : '' }}</p>
  `,
  styleUrl: './app.scss',
})
export class App {
  protected readonly platform = inject(PLATFORM);
  protected readonly shell = inject(ShellState);
  protected readonly settings = inject(SettingsStore);
  /** The world session (F1.2): the HUD's assisted badge reads the world's flag. */
  protected readonly session = inject(Session);
  /** Keyboard → commands (F1.4). Injected here so its document listener is live from start-up. */
  protected readonly keybindings = inject(KeybindingService);
  /**
   * Saving and loading (F1.8b). Injected here so the `file.*` command handlers, the autosave timer
   * and the quit flush exist from start-up, and Continue knows about saves before the menu is used.
   */
  protected readonly saves = inject(SaveGames);
  private readonly toolBelt = inject(ToolBelt);
  /** The active tool-belt slot and the prop it holds (settings `toolBelt.slots`), for the HUD. */
  protected readonly toolLabel = computed(() => {
    const slot = this.toolBelt.activeSlot();
    if (slot === null) return null;
    const ref = this.settings.settings().toolBelt.slots[slot - 1];
    return `${slot}: ${ref ? propLabel(ref.id) : 'Empty'}`;
  });
  protected readonly notifications = inject(NotificationService);
  protected readonly info = resource({ loader: () => this.platform.getAppInfo() });
  protected readonly backend = signal<string>('starting…');
  /** SharedArrayBuffer (sim worker snapshots) needs cross-origin isolation — see docs/caveats/electron.md. */
  protected readonly isolated = globalThis.crossOriginIsolated === true;
  private readonly workspace = viewChild(Workspace);
  /** The panel layout, decoded from the opaque `settings.workspace.layout` (defaults if unrecognised). */
  protected readonly layout = computed(() => parseWorkspaceLayout(this.settings.settings().workspace.layout));
  protected readonly serialiseLayout = serialiseWorkspaceLayout;
  /** Mode and selection from the renderer, for the HUD. */
  protected readonly viewState = computed(() => this.workspace()?.viewState());
  private readonly injector = inject(Injector);
  /** The dev console (F1.5): Sandbox and dev builds, while the workspace shows. Every P1 game is a sandbox. */
  protected readonly consoleAvailable = computed(() =>
    isConsoleAvailable({
      inWorkspace: !this.shell.menuOpen(),
      sessionKind: this.shell.sessionActive() ? 'sandbox' : null,
      devBuild: isDevMode(),
    }),
  );

  constructor() {
    // A save (Continue, Load, Open, from any surface) replaced the session: enter the game.
    const offLoaded = this.saves.onLoaded(() => this.enterGame());
    // Saves carry a small PNG of the viewport (F1.8b).
    const offThumbnail = inject(SaveThumbnails).register(
      async () => (await this.workspace()?.captureThumbnail()) ?? null,
    );
    // Toast actions run commands through the one registry (the crash toast's Restart simulation).
    this.notifications.setActionRunner((commandId) => void this.session.exec(commandId));
    const offCrash = this.session.sim.onCrash((crash) => this.crashed(crash));
    const offEvents = this.session.sim.onEvents((events) => this.simEvents(events));
    inject(DestroyRef).onDestroy(() => {
      offLoaded();
      offThumbnail();
      offCrash();
      offEvents();
      this.notifications.setActionRunner(null);
    });
  }

  /** The worker crashed (ADR 0011 §10): the sim is paused, the world untouched, and Restart offered. */
  private crashed(crash: SimCrash): void {
    const when = crash.tick === null ? '' : ` at ${(crash.tick / 1000).toFixed(3)} s`;
    this.notifications.notify(`The simulation stopped (${crash.code})${when}. Your world is safe.`, {
      level: 'error',
      action: { label: 'Restart simulation', commandId: 'sim.restart' },
    });
  }

  /** Trips and blown fuses get one warning toast per device per `EVENT_TOAST_COALESCE_MS` of wall time (ADR 0011 §4). */
  private readonly toasted = new Map<string, number>();
  private simEvents(events: readonly SimEvent[]): void {
    for (const event of events) {
      if ((event.kind !== 'tripped' && event.kind !== 'blown') || event.entity === null) continue;
      const key = `${event.kind}:${event.entity}`;
      const now = performance.now(); // wall time: at 60× a window of sim time would be a blink
      const last = this.toasted.get(key);
      if (last !== undefined && now - last < EVENT_TOAST_COALESCE_MS) continue;
      this.toasted.set(key, now);
      const what = event.kind === 'tripped' ? 'tripped' : 'blew';
      this.notifications.notify(`Device #${event.entity} ${what}.`, { level: 'warning' });
    }
  }

  /** New sandbox asks for a seed first (the new-game dialog); {@link startSandbox} runs on Start. */
  protected newSandbox(): void {
    this.shell.openDialog('newGame');
  }

  /**
   * Starts a sandbox on the workshop level with `seed` and the player's default difficulty (F1.9):
   * a fresh world, history and replay log, then the workspace with the viewport focused.
   */
  protected startSandbox(seed: number): void {
    this.session.newSandbox({ seed, difficulty: this.settings.settings().gameplay.defaultDifficulty });
    this.enterGame();
  }

  /** Continue (F1.8b): resumes the last-played save, else the newest that loads; then {@link enterGame}. */
  protected continueGame(): void {
    void this.saves.continueLatest();
  }

  /** A game started or loaded: the workspace, with the viewport focused. */
  private enterGame(): void {
    this.toolBelt.clear(); // the tool belt's active slot belongs to the old session
    this.shell.enterGame();
    this.focusViewportAfterRender();
  }

  protected resume(): void {
    this.shell.resume();
    this.focusViewportAfterRender();
  }

  /** Back to the menu; a game with unsaved changes is autosaved on the way (F1.8b). */
  protected openMenu(): void {
    this.shell.openMenu(); // the menu focuses its first item (Resume) when it appears
    void this.saves.autosave();
  }

  protected dialogOpenChange(open: boolean): void {
    if (!open) this.shell.closeDialog();
  }

  /**
   * Escape opens the menu from the workspace and resumes from the menu. Inner handlers win: dialogs
   * and the focused viewport canvas (Escape = clear selection, F1.7) mark the event handled, so
   * with a selection the first Escape clears it and the next opens the menu.
   * Escape is the shell's fixed "back" key, not a binding: the keybinding service reserves it
   * (`RESERVED_CHORDS`), so no command can take it and the menu is always reachable.
   */
  protected onEscape(event: Event): void {
    if (event.defaultPrevented || this.shell.dialog()) return;
    if (!this.shell.menuOpen()) this.openMenu();
    else if (this.shell.sessionActive()) this.resume();
  }

  private focusViewportAfterRender(): void {
    afterNextRender(() => this.workspace()?.focusViewport(), { injector: this.injector });
  }
}

/** `prop.crate` → `Crate` (built-in props until the catalogue brings display names). */
function propLabel(id: string): string {
  const name = id.slice(id.lastIndexOf('.') + 1);
  return name.charAt(0).toUpperCase() + name.slice(1);
}
