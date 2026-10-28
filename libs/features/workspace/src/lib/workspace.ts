import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  input,
  model,
  output,
  viewChild,
} from '@angular/core';
import type { RenderBackend, ViewportState } from '@controls/renderer';
import { Session } from '@controls/feature-session';
import { Button, focusableElements, restoreFocus, Splitter } from '@controls/ui';
import {
  BOTTOM_LIMITS,
  DEFAULT_WORKSPACE_LAYOUT,
  INSPECTOR_LIMITS,
  normaliseLayout,
  type PanelLayout,
  type WorkspaceLayout,
} from './layout';
import { Viewport } from './viewport/viewport';

type PanelId = keyof WorkspaceLayout;

/**
 * The docked workspace: the 3D viewport, an inspector on the right and a bottom panel (the F1.5
 * console host), separated by keyboard-operable splitters (ADR 0005).
 *
 * Content slots: `[ctlWorkspaceToolbar]` (start of the toolbar), `[ctlViewportOverlay]` (HUD over
 * the viewport), `[ctlInspector]` and `[ctlBottomPanel]` (panel bodies, with placeholders). The
 * `console.toggle` command opens the bottom panel and focuses its `[data-autofocus]` element.
 *
 * With `chrome` off (behind the main menu) only the viewport is shown, as the menu backdrop.
 * The viewport region is a landmark only; its canvas is the one keyboard focus target.
 * The layout is plain JSON (`[(layout)]`); the owner persists it. Reset layout runs the
 * `view.resetLayout` command through the session (logged, no world change) and takes effect when
 * the command reports back, so the palette, keybindings and console reach the same code.
 */
@Component({
  selector: 'ctl-workspace',
  imports: [Viewport, Splitter, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.chrome-hidden]': '!chrome()',
    '[style.--ctl-inspector-size]': 'inspectorTrack()',
    '[style.--ctl-bottom-size]': 'bottomTrack()',
  },
  template: `
    @if (chrome()) {
      <div class="toolbar">
        <ng-content select="[ctlWorkspaceToolbar]" />
        <span class="spacer"></span>
        <button
          ctlButton="ghost"
          type="button"
          aria-controls="ctl-inspector"
          [attr.aria-pressed]="!layout().inspector.collapsed"
          (click)="togglePanel('inspector')"
        >
          Inspector
        </button>
        <button
          ctlButton="ghost"
          type="button"
          aria-controls="ctl-bottom-panel"
          [attr.aria-pressed]="!layout().bottom.collapsed"
          (click)="togglePanel('bottom')"
        >
          Console
        </button>
        <button ctlButton="ghost" type="button" (click)="requestResetLayout()">Reset layout</button>
      </div>
    }
    <section #viewportPane class="viewport-pane" aria-label="3D viewport">
      <ctl-viewport (backendChange)="backendChange.emit($event)" />
      <div class="overlay"><ng-content select="[ctlViewportOverlay]" /></div>
    </section>
    @if (chrome()) {
      <ctl-splitter
        class="v-split"
        orientation="vertical"
        label="Resize inspector"
        controls="ctl-inspector"
        [reverse]="true"
        [min]="inspectorLimits.min"
        [max]="inspectorLimits.max"
        [collapsed]="layout().inspector.collapsed"
        [value]="layout().inspector.size"
        (valueChange)="setSize('inspector', $event)"
        (collapseToggle)="togglePanel('inspector')"
      />
      <section
        id="ctl-inspector"
        class="panel inspector"
        aria-labelledby="ctl-inspector-title"
        [hidden]="layout().inspector.collapsed"
      >
        <h2 id="ctl-inspector-title" class="panel-title">Inspector</h2>
        <ng-content select="[ctlInspector]"><p class="ctl-hint">Nothing selected.</p></ng-content>
      </section>
      <ctl-splitter
        class="h-split"
        orientation="horizontal"
        label="Resize console"
        controls="ctl-bottom-panel"
        [reverse]="true"
        [min]="bottomLimits.min"
        [max]="bottomLimits.max"
        [collapsed]="layout().bottom.collapsed"
        [value]="layout().bottom.size"
        (valueChange)="setSize('bottom', $event)"
        (collapseToggle)="togglePanel('bottom')"
      />
      <section
        #bottomPanel
        id="ctl-bottom-panel"
        class="panel bottom"
        aria-labelledby="ctl-bottom-title"
        [hidden]="layout().bottom.collapsed"
      >
        <h2 id="ctl-bottom-title" class="panel-title">Console</h2>
        <ng-content select="[ctlBottomPanel]">
          <p class="ctl-hint">The developer console will dock here.</p>
        </ng-content>
      </section>
    }
  `,
  styleUrl: './workspace.scss',
})
export class Workspace {
  /** Show the toolbar and docked panels. Off behind the main menu. */
  readonly chrome = input(true);
  readonly layout = model<WorkspaceLayout>(DEFAULT_WORKSPACE_LAYOUT);
  readonly backendChange = output<RenderBackend | 'unavailable'>();
  /** Emitted after Reset layout, so the owner can confirm it to the player. */
  readonly layoutReset = output<void>();

  protected readonly inspectorLimits = INSPECTOR_LIMITS;
  protected readonly bottomLimits = BOTTOM_LIMITS;
  protected readonly inspectorTrack = computed(() => track(this.layout().inspector));
  protected readonly bottomTrack = computed(() => track(this.layout().bottom));
  private readonly viewportPane = viewChild.required<ElementRef<HTMLElement>>('viewportPane');
  private readonly viewport = viewChild(Viewport);
  /** The renderer's view state (mode, hover, selection), for the HUD. Undefined until it starts. */
  readonly viewState = computed<ViewportState | undefined>(() => this.viewport()?.state());

  /** A small PNG of the 3D view, for a save's thumbnail (F1.8b); null before the viewport starts. */
  captureThumbnail(): Promise<Uint8Array | null> {
    return this.viewport()?.captureThumbnail() ?? Promise.resolve(null);
  }

  /** Moves keyboard focus to the viewport canvas (after New sandbox or Resume). */
  focusViewport(): void {
    this.viewportPane().nativeElement.querySelector<HTMLElement>('canvas')?.focus();
  }

  private readonly session = inject(Session);

  constructor() {
    const off = this.session.onCommand('view.resetLayout', () => this.resetLayout());
    const offConsole = this.session.onCommand('console.toggle', () => this.toggleConsole());
    inject(DestroyRef).onDestroy(() => (off(), offConsole()));
  }

  private readonly bottomPanel = viewChild<ElementRef<HTMLElement>>('bottomPanel');
  private readonly injector = inject(Injector);
  /** Where focus was before `console.toggle` moved it into the bottom panel. */
  private consoleOpener: Element | null = null;

  /**
   * The effect of `console.toggle` (F1.5): with focus in the bottom panel, collapse it and put focus
   * back where it was (else on the viewport); otherwise expand it and focus its `[data-autofocus]`
   * element (the console input), else its first tab stop.
   */
  private toggleConsole(): void {
    const panel = this.bottomPanel()?.nativeElement;
    if (!this.chrome() || !panel) return;
    const active = panel.ownerDocument.activeElement;
    if (!this.layout().bottom.collapsed && panel.contains(active)) {
      this.update('bottom', { ...this.layout().bottom, collapsed: true });
      const opener = this.consoleOpener;
      this.consoleOpener = null;
      if (opener === panel.ownerDocument.body || !restoreFocus(opener)) this.focusViewport();
      return;
    }
    this.consoleOpener = active;
    const focusPanel = () =>
      (panel.querySelector<HTMLElement>('[data-autofocus]') ?? focusableElements(panel)[0])?.focus();
    if (!this.layout().bottom.collapsed) {
      focusPanel(); // already shown: no render is coming, so focus now
      return;
    }
    this.update('bottom', { ...this.layout().bottom, collapsed: false });
    afterNextRender(focusPanel, { injector: this.injector }); // once [hidden] is gone
  }

  /** The Reset layout button: runs the `view.resetLayout` command. */
  protected requestResetLayout(): void {
    this.session.exec('view.resetLayout');
  }

  /** Restores the default layout (the effect of `view.resetLayout`). */
  private resetLayout(): void {
    this.layout.set(DEFAULT_WORKSPACE_LAYOUT);
    this.layoutReset.emit();
  }

  protected togglePanel(panel: PanelId): void {
    const current = this.layout()[panel];
    this.update(panel, { ...current, collapsed: !current.collapsed });
  }

  protected setSize(panel: PanelId, size: number): void {
    this.update(panel, { ...this.layout()[panel], size });
  }

  private update(panel: PanelId, value: PanelLayout): void {
    this.layout.set(normaliseLayout({ ...this.layout(), [panel]: value }));
  }
}

function track(panel: PanelLayout): string {
  return panel.collapsed ? '0px' : `${panel.size}px`;
}
