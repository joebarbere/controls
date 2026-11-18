import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  type EffectRef,
  ElementRef,
  inject,
  Injector,
  input,
  model,
  output,
  type Signal,
  signal,
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
import { NetlistInspector } from './netlist/netlist-inspector';
import { Viewport } from './viewport/viewport';

type PanelId = keyof WorkspaceLayout;

/**
 * The docked workspace: the 3D viewport, an inspector on the right and a bottom panel (the F1.5
 * console host), separated by keyboard-operable splitters (ADR 0005).
 *
 * Content slots: `[ctlWorkspaceToolbar]` (start of the toolbar), `[ctlViewportOverlay]` (HUD over
 * the viewport, top left), `[ctlViewportBottom]` (the tool belt, bottom centre), `[ctlInspector]` and `[ctlBottomPanel]` (panel bodies, with placeholders). The
 * `console.toggle` command opens the bottom panel and focuses its `[data-autofocus]` element;
 * `view.netlistInspector` (F2.6) shows the netlist inspector in the side panel the same way, and
 * passes the node it has selected to the renderer's terminal highlight (view state only).
 *
 * With `chrome` off (behind the main menu) only the viewport is shown, as the menu backdrop.
 * The viewport region is a landmark only; its canvas is the one keyboard focus target.
 * The layout is plain JSON (`[(layout)]`); the owner persists it. Reset layout runs the
 * `view.resetLayout` command through the session (logged, no world change) and takes effect when
 * the command reports back, so the palette, keybindings and console reach the same code.
 */
@Component({
  selector: 'ctl-workspace',
  imports: [Viewport, Splitter, Button, NetlistInspector],
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
      <!-- Lazy (D19): the renderer and three.js are most of the bundle; the menu paints without them. -->
      @defer (on immediate) {
        <ctl-viewport #viewport (backendChange)="backendChange.emit($event)" />
      } @placeholder {
        <div data-testid="viewport-placeholder"></div>
      }
      <div class="overlay"><ng-content select="[ctlViewportOverlay]" /></div>
      <div class="overlay-bottom"><ng-content select="[ctlViewportBottom]" /></div>
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
        #inspectorPanel
        id="ctl-inspector"
        class="panel inspector"
        aria-labelledby="ctl-inspector-title"
        [hidden]="layout().inspector.collapsed"
      >
        <h2 id="ctl-inspector-title" class="panel-title">Inspector</h2>
        @if (netlistOpen()) {
          <!-- Lazy (D19): loaded the first time the inspector opens; focus waits for it (afterLoaded). -->
          @defer (on immediate) {
            <ctl-netlist-inspector #netlist />
          }
        } @else {
          <ng-content select="[ctlInspector]"
            ><p class="ctl-hint" data-testid="inspector-placeholder">
              Device properties aren't shown here yet. To see the circuit, run
              <code>view.netlistInspector</code> in the console, or Toggle netlist inspector in the command palette.
            </p></ng-content
          >
        }
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
  private readonly viewport = viewChild<Viewport>('viewport');
  /** The renderer's view state (mode, hover, selection), for the HUD. Undefined until it starts. */
  readonly viewState = computed<ViewportState | undefined>(() => this.viewport()?.state());

  /** A small PNG of the 3D view, for a save's thumbnail (F1.8b); null before the viewport starts. */
  captureThumbnail(): Promise<Uint8Array | null> {
    return this.viewport()?.captureThumbnail() ?? Promise.resolve(null);
  }

  /**
   * Moves keyboard focus to the viewport canvas (after New sandbox or Resume). The viewport is a lazy
   * `@defer` block (D19): asked before its chunk has loaded, focus moves once it renders, unless focus
   * has gone somewhere else by then.
   */
  focusViewport(): void {
    const pane = this.viewportPane().nativeElement;
    const canvas = () => pane.querySelector<HTMLElement>('canvas');
    if (canvas()) {
      this.cancelPendingFocus();
      canvas()?.focus();
      return;
    }
    const doc = pane.ownerDocument;
    const before = doc.activeElement;
    this.afterLoaded(this.viewport, () => {
      const active = doc.activeElement;
      if (active === before || active === null || active === doc.body) canvas()?.focus();
    });
  }

  private readonly session = inject(Session);

  constructor() {
    const off = this.session.onCommand('view.resetLayout', () => this.resetLayout());
    const offConsole = this.session.onCommand('console.toggle', () => this.toggleConsole());
    const offNetlist = this.session.onCommand('view.netlistInspector', () => this.toggleNetlist());
    inject(DestroyRef).onDestroy(() => (off(), offConsole(), offNetlist()));
    // Pushing the inspector's selected node into the framework-free renderer is an imperative side
    // effect (like the viewport's own effects); closing the inspector clears it.
    effect(() => this.viewport()?.highlightTerminals(this.netlist()?.highlighted() ?? null));
  }

  /** Whether the side panel shows the netlist inspector (UI state, toggled by `view.netlistInspector`). */
  protected readonly netlistOpen = signal(false);
  private readonly netlist = viewChild<NetlistInspector>('netlist');
  private readonly inspectorPanel = viewChild<ElementRef<HTMLElement>>('inspectorPanel');
  /** Where focus was before `view.netlistInspector` moved it into the side panel. */
  private netlistOpener: Element | null = null;

  /**
   * The effect of `view.netlistInspector` (F2.6), like `console.toggle`: with focus in the open
   * inspector, close it and put focus back where it was (else on the viewport); otherwise show it,
   * expanding the side panel if needed, and focus its tree.
   */
  private toggleNetlist(): void {
    const panel = this.inspectorPanel()?.nativeElement;
    if (!this.chrome() || !panel) return;
    const active = panel.ownerDocument.activeElement;
    if (this.netlistOpen() && !this.layout().inspector.collapsed && panel.contains(active)) {
      this.netlistOpen.set(false);
      const opener = this.netlistOpener;
      this.netlistOpener = null;
      if (opener === panel.ownerDocument.body || !restoreFocus(opener)) this.focusViewport();
      return;
    }
    if (!panel.contains(active)) this.netlistOpener = active;
    const focusPanel = () =>
      (panel.querySelector<HTMLElement>('[data-autofocus]') ?? focusableElements(panel)[0])?.focus();
    if (this.netlistOpen() && !this.layout().inspector.collapsed) {
      focusPanel(); // already shown: no render is coming, so focus now
      return;
    }
    this.netlistOpen.set(true);
    if (this.layout().inspector.collapsed) this.update('inspector', { ...this.layout().inspector, collapsed: false });
    // Once it has rendered: the inspector is a lazy `@defer` block, so the first time that is after its
    // chunk loads (D19). Closed again before then, or focus moved on meanwhile (the player tabbed
    // away), nothing is focused: a late chunk never takes focus back.
    const doc = panel.ownerDocument;
    const before = doc.activeElement;
    this.afterLoaded(this.netlist, () => {
      const now = doc.activeElement;
      if (this.netlistOpen() && (now === before || now === null || now === doc.body)) focusPanel();
    });
  }

  /** The focus request still waiting for a lazy block to render; a newer request replaces it. */
  private pendingFocus: EffectRef | null = null;

  /**
   * Runs `run` after the render in which `query` (a lazy `@defer` component) is present: on the next
   * render if it already is, else once its chunk has loaded and it has rendered (plan P4 D19).
   */
  private afterLoaded(query: Signal<unknown>, run: () => void): void {
    this.cancelPendingFocus();
    const ref = effect(
      () => {
        if (query() === undefined) return;
        ref.destroy();
        if (this.pendingFocus === ref) this.pendingFocus = null;
        afterNextRender(run, { injector: this.injector });
      },
      { injector: this.injector },
    );
    this.pendingFocus = ref;
  }

  private cancelPendingFocus(): void {
    this.pendingFocus?.destroy();
    this.pendingFocus = null;
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
