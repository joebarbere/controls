import { WebGPURenderer } from 'three/webgpu';
import { metresToMm } from '@controls/units';
import type { ViewMode } from './cameras/camera-math';
import type { InputBindings } from './input/input-actions';
import type { SelectableInfo } from './picking/selection';
import type { SceneGraphNode } from './scene';
import type { CatalogRef, Vec3Mm, World } from '@controls/world-model';
import { FrameTimer, type FrameTiming } from './stats/frame-timer';
import {
  ViewportController,
  type ViewportControllerOptions,
  type ViewportIntentListener,
  type ViewportState,
  type ViewportStateListener,
} from './viewport-controller';

export type RenderBackend = 'webgpu' | 'webgl2';

export interface ViewportOptions extends ViewportControllerOptions {
  /** Skip WebGPU even when available (CI determinism, driver workarounds). */
  readonly forceWebGL?: boolean;
  /** Called about twice a second with frame time and renderer counters (dev HUD). */
  readonly onStats?: (stats: ViewportStats) => void;
}

/** Dev-HUD numbers: frame timing plus the renderer's draw and memory counters. */
export interface ViewportStats extends FrameTiming {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  readonly bvhs: number;
  /** World entities drawn. */
  readonly entities: number;
  /** Shared prop recipes alive (geometry + material pairs); back to 0 when no prop is drawn. */
  readonly recipes: number;
  /** Level fixtures drawn (floor, walls, bench, backplate, rails). */
  readonly fixtures: number;
}

const STATS_INTERVAL_MS = 500;

/**
 * Owns the `WebGPURenderer` (which falls back to WebGL2 by itself) and the animation loop for one
 * canvas. Everything else (scene, cameras, picking, selection) is the GPU-free
 * {@link ViewportController}. Framework-free: Angular hands over a canvas and sizes.
 */
export class ViewportRenderer {
  private renderer?: WebGPURenderer;
  private controller?: ViewportController;
  private backendName?: RenderBackend;
  private readonly timer = new FrameTimer();
  private lastStatsMs = -1;
  private lastFrameMs = -1;
  // Kept until the controller exists (WebGPU init is async), then applied.
  private world: World | null = null;
  private placement: CatalogRef | null = null;
  private readonly intentListeners = new Set<ViewportIntentListener>();

  async init(canvas: HTMLCanvasElement, options: ViewportOptions = {}): Promise<RenderBackend> {
    const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL: options.forceWebGL ?? false });
    this.renderer = renderer;
    await renderer.init();
    if (this.renderer !== renderer) {
      // dispose() ran while init was pending (viewport closed during start-up).
      renderer.dispose();
      throw new Error('viewport disposed during init');
    }
    // WebGPURenderer silently falls back to its WebGL2 backend when WebGPU is unavailable.
    this.backendName = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
    const controller = new ViewportController(canvas, options);
    this.controller = controller;
    if (this.world) controller.syncWorld(this.world);
    controller.setPlacement(this.placement);
    controller.onIntent((intent) => this.intentListeners.forEach((l) => l(intent)));
    const onStats = options.onStats;

    renderer.setAnimationLoop((timeMs: number) => {
      const dt = this.lastFrameMs < 0 ? 0 : (timeMs - this.lastFrameMs) / 1000;
      this.lastFrameMs = timeMs;
      this.timer.tick(timeMs);
      controller.update(dt);
      renderer.render(controller.scene, controller.camera);
      if (onStats && timeMs - this.lastStatsMs >= STATS_INTERVAL_MS) {
        this.lastStatsMs = timeMs;
        onStats(this.stats());
      }
    });
    return this.backendName;
  }

  get backend(): RenderBackend | undefined {
    return this.backendName;
  }

  get state(): ViewportState | undefined {
    return this.controller?.state;
  }

  onChange(listener: ViewportStateListener): () => void {
    return this.controller?.onChange(listener) ?? (() => undefined);
  }

  /** Gesture commit points (place, move, cancel placement); may subscribe before `init` resolves. */
  onIntent(listener: ViewportIntentListener): () => void {
    this.intentListeners.add(listener);
    return () => this.intentListeners.delete(listener);
  }

  /** Draws a world snapshot (entities by id). Read-only: the renderer never mutates the world. */
  syncWorld(world: World): void {
    this.world = world;
    this.controller?.syncWorld(world);
  }

  /** Arms placement of the active tool's prop, or disarms it (`null`). */
  setPlacement(ref: CatalogRef | null): void {
    this.placement = ref;
    this.controller?.setPlacement(ref);
  }

  /** Canvas CSS-pixel position of an integer-mm world point (tests aim the mouse with it). */
  projectMm(p: Vec3Mm): { x: number; y: number } | undefined {
    return this.controller?.projectMm(p);
  }

  /** Back to the starting view (work mode, initial focus, nothing selected): a new session. */
  resetView(): void {
    this.controller?.resetView();
  }

  setMode(mode: ViewMode): void {
    this.controller?.setMode(mode);
  }

  focus(id: string): boolean {
    return this.controller?.focus(id) ?? false;
  }

  select(id: string | null): boolean {
    return this.controller?.select(id) ?? false;
  }

  selectNext(): SelectableInfo | null {
    return this.controller?.selectNext() ?? null;
  }

  selectPrevious(): SelectableInfo | null {
    return this.controller?.selectPrevious() ?? null;
  }

  /** Selectables in keyboard-cycling order. */
  selectables(): readonly SelectableInfo[] {
    return this.controller?.selection.all ?? [];
  }

  /** BVH pick at normalised device coordinates (−1…1, +y up). */
  pickAt(ndcX: number, ndcY: number): SelectableInfo | null {
    return this.controller?.pickAt(ndcX, ndcY) ?? null;
  }

  setBindings(bindings: InputBindings): void {
    this.controller?.setBindings(bindings);
  }

  /** Camera eye position in integer mm (view state, for tests and the dev HUD). */
  cameraPositionMm(): Vec3Mm | undefined {
    const p = this.controller?.camera.position;
    return p && { x: metresToMm(p.x), y: metresToMm(p.y), z: metresToMm(p.z) };
  }

  sceneGraph(): SceneGraphNode | undefined {
    return this.controller?.sceneGraph();
  }

  stats(): ViewportStats {
    const info = this.renderer?.info;
    return {
      ...this.timer.sample(),
      drawCalls: info?.render.drawCalls ?? 0,
      triangles: info?.render.triangles ?? 0,
      geometries: info?.memory.geometries ?? 0,
      textures: info?.memory.textures ?? 0,
      bvhs: this.controller?.bvhCount ?? 0,
      entities: this.controller?.entityCount ?? 0,
      recipes: this.controller?.recipeCount ?? 0,
      fixtures: this.controller?.fixtureCount ?? 0,
    };
  }

  /**
   * A small PNG of what the viewport shows (save thumbnails, F1.8b), scaled to fit `maxWidthPx` ×
   * `maxHeightPx`. The drawing buffer isn't preserved between frames, so this renders a frame and
   * copies it onto a 2D canvas in the same task, then encodes that. Null before `init`, for an empty
   * canvas, or when the browser can't encode.
   */
  async captureThumbnail(maxWidthPx = 320, maxHeightPx = 180): Promise<Uint8Array | null> {
    const renderer = this.renderer;
    const controller = this.controller;
    const source = renderer?.domElement;
    if (!renderer || !controller || !source || source.width === 0 || source.height === 0) return null;
    const scale = Math.min(1, maxWidthPx / source.width, maxHeightPx / source.height);
    const canvas = source.ownerDocument.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    renderer.render(controller.scene, controller.camera);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }

  resize(widthPx: number, heightPx: number, devicePixelRatio: number): void {
    if (!this.renderer || widthPx === 0 || heightPx === 0) return;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(widthPx, heightPx, false);
    this.controller?.resize(widthPx, heightPx);
  }

  dispose(): void {
    this.renderer?.setAnimationLoop(null);
    this.controller?.dispose();
    this.controller = undefined;
    this.renderer?.dispose();
    this.renderer = undefined;
    this.intentListeners.clear();
  }
}
