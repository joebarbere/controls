import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ViewportRenderer, type RenderBackend } from '@controls/renderer';

export type ViewportStatus = 'loading' | 'ready' | 'error';

/**
 * Hosts one canvas for the framework-free {@link ViewportRenderer}. The renderer runs its own
 * animation loop; with zoneless change detection nothing here re-renders per frame.
 */
@Component({
  selector: 'ctl-viewport',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<canvas #canvas aria-label="3D workspace"></canvas>`,
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
  `,
  host: { '[attr.data-status]': 'status()', '[attr.data-backend]': 'backend() ?? null' },
})
export class Viewport {
  readonly status = signal<ViewportStatus>('loading');
  readonly backend = signal<RenderBackend | undefined>(undefined);
  readonly backendChange = output<RenderBackend | 'unavailable'>();

  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly renderer = new ViewportRenderer();

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const canvas = this.canvas().nativeElement;
      const observer = new ResizeObserver(() => this.resize());
      observer.observe(this.host.nativeElement);
      destroyRef.onDestroy(() => {
        observer.disconnect();
        this.renderer.dispose();
      });
      this.renderer
        .init(canvas, {
          // `?renderer=webgl2` pins the fallback backend so CI keeps it tested (docs/caveats/electron.md).
          forceWebGL: new URLSearchParams(window.location.search).get('renderer') === 'webgl2',
        })
        .then((backend) => {
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
