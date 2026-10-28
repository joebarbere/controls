import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  isDevMode,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  type ContextValue,
  MODE_KEY,
  SELECTION_ENTITY_ID_KEY,
  SELECTION_FOCUSABLE_KEY,
  SELECTION_ID_KEY,
  SELECTION_KIND_KEY,
  VIEW_FOCUS_SELECTION_BINDING,
  VIEW_MODE_WALK_BINDING,
  type ViewFocusArgs,
  type ViewModeArgs,
  VIEWPORT_FOCUSED_KEY,
} from '@controls/commands';
import { KeybindingService, Session } from '@controls/feature-session';
import {
  inputBindingsFrom,
  ViewportRenderer,
  type RenderBackend,
  type ViewportState,
  type ViewportStats,
} from '@controls/renderer';

export type ViewportStatus = 'loading' | 'ready' | 'error';

/** Window property for the E2E test hook (`?e2e=1` only). Drives the renderer API, never the world. */
const TEST_HOOK = '__controlsViewport';

/**
 * Hosts one canvas for the framework-free {@link ViewportRenderer}. The renderer runs its own
 * animation loop and input handling; with zoneless change detection nothing here re-renders per
 * frame. Only view state (mode, hover, selection) and twice-a-second dev stats reach signals.
 * Mode and selection are shown by the shell HUD (`ctl-hud`, fed from `state`); the frame-time dev
 * HUD and the walk-mode crosshair stay here.
 *
 * **View commands:** `view.mode` and `view.focus` (keys, palette, console, scripts) take effect
 * here, through `Session.onCommand`. The renderer's mode and selection are published as the `when`
 * context keys `mode`, `selection.id`, `selection.kind`, `selection.focusable` and
 * `selection.entityId`, which the V, F and Delete bindings read.
 *
 * Input actions (WASD, selection cycling, …) come from the {@link KeybindingService}, so the
 * player's rebinding reaches the renderer and the canvas label names the current keys. While the
 * canvas has focus the `viewport.focused` context key is true (input actions are active).
 */
@Component({
  selector: 'ctl-viewport',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <canvas
      #canvas
      tabindex="0"
      [attr.aria-label]="label()"
      (focus)="session.setContext(viewportFocusedKey, true)"
      (blur)="session.setContext(viewportFocusedKey, null)"
    ></canvas>
    @if (state()?.mode === 'walk') {
      <div class="crosshair" aria-hidden="true"></div>
    }
    @if (showHud && stats(); as st) {
      <div class="dev-hud" data-testid="dev-hud" aria-hidden="true">
        {{ st.avgMs.toFixed(1) }} ms · worst {{ st.worstMs.toFixed(1) }} · {{ st.fps.toFixed(0) }} fps ·
        {{ st.drawCalls }} draws · {{ st.geometries }} geo · {{ st.bvhs }} bvh
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
    }
    canvas {
      display: block;
      width: 100%;
      height: 100%;
      outline: none;
    }
    canvas:focus-visible {
      outline: 2px solid var(--ctl-focus, #7fb8ff);
      outline-offset: -2px;
    }
    .dev-hud {
      position: absolute;
      left: 0.75rem;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      background: rgb(0 0 0 / 55%);
      color: #e8eaed;
      font:
        12px/1.4 ui-monospace,
        monospace;
      pointer-events: none;
    }
    .dev-hud {
      bottom: 0.75rem;
    }
    .crosshair {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 6px;
      height: 6px;
      margin: -3px 0 0 -3px;
      border-radius: 50%;
      background: rgb(255 255 255 / 80%);
      pointer-events: none;
    }
  `,
  host: {
    '[attr.data-status]': 'status()',
    '[attr.data-backend]': 'backend() ?? null',
    '[attr.data-mode]': 'state()?.mode ?? null',
    '[attr.data-focus]': 'state()?.focusId ?? null',
    '[attr.data-selected]': 'state()?.selected?.id ?? null',
    '[attr.data-selection-kind]': 'selectionKind()',
    '[attr.data-hovered]': 'state()?.hovered?.id ?? null',
  },
})
export class Viewport {
  readonly status = signal<ViewportStatus>('loading');
  readonly backend = signal<RenderBackend | undefined>(undefined);
  readonly state = signal<ViewportState | undefined>(undefined);
  readonly stats = signal<ViewportStats | undefined>(undefined);
  /** `selection.kind` for the HUD and (from F1.2) the `when` context. */
  readonly selectionKind = computed(() => this.state()?.selected?.kind ?? null);
  readonly backendChange = output<RenderBackend | 'unavailable'>();

  private readonly params = new URLSearchParams(window.location.search);
  /** Frame-time dev HUD: dev builds, or `?hud` in any build. */
  protected readonly showHud = isDevMode() || this.params.has('hud');
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly renderer = new ViewportRenderer();
  protected readonly session = inject(Session);
  protected readonly viewportFocusedKey = VIEWPORT_FOCUSED_KEY;
  private readonly keys = inject(KeybindingService);
  private readonly bindings = computed(() => inputBindingsFrom(this.keys.inputBindings()));
  /** The canvas's accessible name, naming the current keys of each input action and view binding. */
  protected readonly label = computed(() => {
    const binding = (id: string) => {
      const chords = this.keys.chordsOf(id);
      return chords.length > 0 ? this.keys.label(chords[0]) : 'unbound';
    };
    const key = (action: string) => binding(`input.${action}`);
    const walk = ['moveForward', 'moveLeft', 'moveBack', 'moveRight'].map(key).join(' ');
    return (
      `3D workspace. Click to select. ${key('selectPrevious')} and ${key('selectNext')} cycle selection, ` +
      `${binding(VIEW_FOCUS_SELECTION_BINDING)} focuses it, ${binding(VIEW_MODE_WALK_BINDING)} toggles walk and work mode, ${walk} walk.`
    );
  });
  /** Context keys last published, so unchanged values aren't re-set on every hover change. */
  private readonly published = new Map<string, ContextValue>();

  constructor() {
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => {
      this.session.setContext(VIEWPORT_FOCUSED_KEY, null);
      this.publishContext(undefined);
    });
    const offMode = this.session.onCommand('view.mode', (e) =>
      this.renderer.setMode((e.command.args as ViewModeArgs).mode),
    );
    const offFocus = this.session.onCommand('view.focus', (e) =>
      this.renderer.focus((e.command.args as ViewFocusArgs).target),
    );
    destroyRef.onDestroy(() => {
      offMode();
      offFocus();
    });
    // Pushing bindings into the framework-free renderer is an imperative side effect.
    effect(() => this.renderer.setBindings(this.bindings()));
    afterNextRender(() => {
      const canvas = this.canvas().nativeElement;
      const observer = new ResizeObserver(() => this.resize());
      observer.observe(this.host.nativeElement);
      const exposeHook = this.params.get('e2e') === '1';
      destroyRef.onDestroy(() => {
        observer.disconnect();
        if (exposeHook) delete (window as unknown as Record<string, unknown>)[TEST_HOOK];
        this.renderer.dispose();
      });
      this.renderer
        .init(canvas, {
          // `?renderer=webgl2` pins the fallback backend so CI keeps it tested (docs/caveats/electron.md).
          forceWebGL: this.params.get('renderer') === 'webgl2',
          bindings: this.bindings(),
          onStats: this.showHud || exposeHook ? (s) => this.stats.set(s) : undefined,
        })
        .then((backend) => {
          this.renderer.setBindings(this.bindings()); // in case they changed while starting up
          this.state.set(this.renderer.state);
          this.publishContext(this.renderer.state);
          this.renderer.onChange((s) => {
            this.state.set(s);
            this.publishContext(s);
          });
          if (exposeHook) (window as unknown as Record<string, unknown>)[TEST_HOOK] = this.renderer;
          this.backend.set(backend);
          this.status.set('ready');
          this.backendChange.emit(backend);
          this.resize();
        })
        .catch((error: unknown) => {
          console.error('3D viewport failed to start', error);
          this.status.set('error');
          this.backendChange.emit('unavailable');
        });
    });
  }

  /** Publishes the view state as `when` context keys (`undefined` clears them). */
  private publishContext(s: ViewportState | undefined): void {
    const selected = s?.selected ?? null;
    const next: ReadonlyArray<readonly [string, ContextValue]> = [
      [MODE_KEY, s?.mode ?? null],
      [SELECTION_ID_KEY, selected?.id ?? null],
      [SELECTION_KIND_KEY, selected?.kind ?? null],
      [SELECTION_FOCUSABLE_KEY, selected?.focusNormal ? true : null],
      [SELECTION_ENTITY_ID_KEY, selected?.entityId ?? null],
    ];
    for (const [key, value] of next) {
      if ((this.published.get(key) ?? null) === value) continue;
      this.published.set(key, value);
      this.session.setContext(key, value);
    }
  }

  private resize(): void {
    const { clientWidth, clientHeight } = this.host.nativeElement;
    this.renderer.resize(clientWidth, clientHeight, window.devicePixelRatio || 1);
  }
}
