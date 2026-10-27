import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  isDevMode,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ViewportRenderer, type RenderBackend, type ViewportState, type ViewportStats } from '@controls/renderer';

export type ViewportStatus = 'loading' | 'ready' | 'error';

/** Window property for the E2E test hook (`?e2e=1` only). Drives the renderer API, never the world. */
const TEST_HOOK = '__controlsViewport';

/**
 * Hosts one canvas for the framework-free {@link ViewportRenderer}. The renderer runs its own
 * animation loop and input handling; with zoneless change detection nothing here re-renders per
 * frame. Only view state (mode, hover, selection) and twice-a-second dev stats reach signals.
 * Mode and selection are shown by the shell HUD (`ctl-hud`, fed from `state`); the frame-time dev
 * HUD and the walk-mode crosshair stay here. TODO(F1.2): mode/focus go through Commands.
 */
@Component({
  selector: 'ctl-viewport',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <canvas
      #canvas
      tabindex="0"
      aria-label="3D workspace. Click to select. [ and ] cycle selection, F focuses it, V toggles walk and work mode, WASD walks."
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

  constructor() {
    const destroyRef = inject(DestroyRef);
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
          onStats: this.showHud || exposeHook ? (s) => this.stats.set(s) : undefined,
        })
        .then((backend) => {
          this.state.set(this.renderer.state);
          this.renderer.onChange((s) => this.state.set(s));
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

  private resize(): void {
    const { clientWidth, clientHeight } = this.host.nativeElement;
    this.renderer.resize(clientWidth, clientHeight, window.devicePixelRatio || 1);
  }
}
