import { WebGPURenderer } from 'three/webgpu';
import { metresToMm } from '@controls/units';
import type { ViewMode } from './cameras/camera-math';
import type { InputBindings } from './input/input-actions';
import type { SelectableInfo } from './picking/selection';
import type { SceneGraphNode } from './scene';
import type { CatalogRef, Vec3Mm, World } from '@controls/world-model';
import { Disposer } from './disposer';
import type {
  OverlayGraph,
  OverlayLegendState,
  OverlayName,
  OverlayTerminalRef,
  SnapshotFeed,
} from './overlays/sim-overlays';
import { RenderLoop, windowFrameClock } from './loop/render-loop';
import type { FrameTiming } from './stats/frame-timer';
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
  /**
   * Called about twice a second while frames are drawn, and once more after the viewport goes idle
   * (`idle: true`), with frame cost and renderer counters (dev HUD).
   */
  readonly onStats?: (stats: ViewportStats) => void;
}

/** Dev-HUD numbers: frame timing plus the renderer's draw and memory counters. */
export interface ViewportStats extends FrameTiming {
  /** Draw calls of the last frame drawn. */
  readonly drawCalls: number;
  /** Triangles of the last frame drawn. */
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

const IDLE_TIMING: FrameTiming = { avgMs: 0, worstMs: 0, lastMs: 0, fps: 0, windowFrames: 0, idle: true, frames: 0 };

/**
 * Owns the `WebGPURenderer` (which falls back to WebGL2 by itself) and the {@link RenderLoop} for
 * one canvas. Everything else (scene, cameras, picking, selection) is the GPU-free
 * {@link ViewportController}. Framework-free: Angular hands over a canvas and sizes.
 *
 * **On-demand rendering:** a frame is drawn only when the controller invalidates (input, world or
 * selection changes, hover, mode, focus, the ghost), on a resize, on WebGL context restore or when
 * the page becomes visible again, or while an animation runs (a held walk key, orbit damping).
 * Otherwise no animation frame is requested at all. Use {@link requestRender} for anything else.
 */
export class ViewportRenderer {
  private renderer?: WebGPURenderer;
  private controller?: ViewportController;
  private loop?: RenderLoop;
  private backendName?: RenderBackend;
  private readonly disposer = new Disposer();
  /** Draw counters of the last frame (copied out: `info.render` is reset before each draw). */
  private lastDrawCalls = 0;
  private lastTriangles = 0;
  // Kept until the controller exists (WebGPU init is async), then applied.
  private world: World | null = null;
  private placement: CatalogRef | null = null;
  private readonly intentListeners = new Set<ViewportIntentListener>();
  /** Overlay view state (F2.6), kept until the controller exists, like the world. */
  private readonly overlayState = {
    voltage: false,
    current: false,
    reducedMotion: false,
    feed: null as SnapshotFeed | null,
    highlight: null as readonly OverlayTerminalRef[] | null,
  };
  private readonly legendListeners = new Set<(state: OverlayLegendState) => void>();

  async init(canvas: HTMLCanvasElement, options: ViewportOptions = {}): Promise<RenderBackend> {
    const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL: options.forceWebGL ?? false });
    this.renderer = renderer;
    await renderer.init();
    if (this.renderer !== renderer) {
      // dispose() ran while init was pending (viewport closed during start-up).
      renderer.dispose();
      throw new Error('viewport disposed during init');
    }
    stopInternalAnimationLoop(renderer);
    // WebGPURenderer silently falls back to its WebGL2 backend when WebGPU is unavailable.
    this.backendName = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
    const doc = canvas.ownerDocument;
    const view = doc.defaultView;
    if (!view) throw new Error('viewport canvas is not in a window');
    const controller = new ViewportController(canvas, options);
    this.controller = controller;
    const onStats = options.onStats;
    const loop = new RenderLoop({
      clock: windowFrameClock(view),
      update: (dt) => controller.update(dt),
      draw: () => {
        renderer.info.reset();
        renderer.render(controller.scene, controller.camera);
        this.lastDrawCalls = renderer.info.render.drawCalls;
        this.lastTriangles = renderer.info.render.triangles;
      },
      onStats: onStats && (() => onStats(this.stats())),
    });
    this.loop = loop;
    this.disposer.add(() => loop.dispose());
    this.disposer.add(controller.onInvalidate(() => loop.requestRender()));
    // The canvas can lose its content with the context (GPU process restart) or while hidden.
    this.disposer.listen(canvas, 'webglcontextrestored', () => loop.requestRender());
    this.disposer.listen(doc, 'visibilitychange', () => {
      if (doc.visibilityState === 'visible') loop.requestRender();
    });
    if (this.world) controller.syncWorld(this.world);
    controller.setPlacement(this.placement);
    this.applyOverlayState(controller);
    controller.onIntent((intent) => this.intentListeners.forEach((l) => l(intent)));
    loop.requestRender(); // the first frame
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

  /**
   * Where the overlays read sim snapshots (`SimHost`, ADR 0011 §9.2); `null` detaches. The
   * subscription is the renderer's and ends with {@link dispose}.
   */
  attachSnapshots(feed: SnapshotFeed | null): void {
    this.overlayState.feed = feed;
    this.controller?.overlays.attach(feed);
  }

  /** Switches a debug overlay (the `view.overlay` view command). View state only. */
  setOverlay(name: OverlayName, on: boolean): void {
    this.overlayState[name] = on;
    this.controller?.overlays.setOverlay(name, on);
  }

  /** Whether an overlay is on. */
  overlay(name: OverlayName): boolean {
    return this.overlayState[name];
  }

  /** `prefers-reduced-motion`: current arrows are static. */
  setReducedMotion(on: boolean): void {
    this.overlayState.reducedMotion = on;
    this.controller?.overlays.setReducedMotion(on);
  }

  /**
   * Highlights terminals in 3D (the netlist inspector's selected node: view state only); `null` or
   * `[]` clears. Returns how many drawn terminals are highlighted (0 before `init`).
   */
  highlightTerminals(terminals: readonly OverlayTerminalRef[] | null): number {
    this.overlayState.highlight = terminals;
    return this.controller?.overlays.highlightTerminals(terminals) ?? 0;
  }

  /** The overlay legend's state; listeners may subscribe before `init` resolves. */
  get overlayLegend(): OverlayLegendState {
    return (
      this.controller?.overlays.legendState ?? {
        voltage: this.overlayState.voltage,
        current: this.overlayState.current,
        bands: [],
        noScale: false,
        unknown: false,
      }
    );
  }

  onOverlayLegend(listener: (state: OverlayLegendState) => void): () => void {
    this.legendListeners.add(listener);
    return () => this.legendListeners.delete(listener);
  }

  /** What the overlays draw (tests and the `?e2e=1` hook), or `undefined` before `init`. */
  overlayGraph(): OverlayGraph | undefined {
    return this.controller?.overlays.describe();
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

  /**
   * Asks for a frame. The controller already does this for input, world, selection, hover, mode,
   * camera and ghost changes; call it for anything else that changes what is drawn. Cheap and
   * idempotent: requests before the next frame coalesce.
   */
  requestRender(): void {
    this.loop?.requestRender();
  }

  /** Frames drawn since init (tests: an idle viewport draws none). */
  get framesDrawn(): number {
    return this.loop?.frames ?? 0;
  }

  /**
   * Resolves after `count` more frames have been drawn, requesting them if nothing else does. E2E
   * waits on this rather than on animation frames, which no longer imply a render.
   */
  afterFrames(count = 1): Promise<void> {
    return this.loop?.afterFrames(count) ?? Promise.resolve();
  }

  /** Resolves once no frame is scheduled: everything requested so far has been drawn. */
  whenIdle(): Promise<void> {
    return this.loop?.whenIdle() ?? Promise.resolve();
  }

  sceneGraph(): SceneGraphNode | undefined {
    return this.controller?.sceneGraph();
  }

  /** Frame timing since the last call (a new window starts) plus the renderer's counters. */
  stats(): ViewportStats {
    const info = this.renderer?.info;
    return {
      ...(this.loop?.sampleTiming() ?? IDLE_TIMING),
      drawCalls: this.lastDrawCalls,
      triangles: this.lastTriangles,
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
   * `maxHeightPx`. The drawing buffer isn't preserved between frames, so this draws a frame now
   * (`RenderLoop.renderNow`, idle or not) and copies it onto a 2D canvas in the same task, then
   * encodes that. Null before `init`, for an empty canvas, or when the browser can't encode.
   */
  async captureThumbnail(maxWidthPx = 320, maxHeightPx = 180): Promise<Uint8Array | null> {
    const loop = this.loop;
    const source = this.renderer?.domElement;
    if (!loop || !source || source.width === 0 || source.height === 0) return null;
    const scale = Math.min(1, maxWidthPx / source.width, maxHeightPx / source.height);
    const canvas = source.ownerDocument.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    loop.renderNow();
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }

  resize(widthPx: number, heightPx: number, devicePixelRatio: number): void {
    if (!this.renderer || widthPx === 0 || heightPx === 0) return;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(widthPx, heightPx, false);
    this.controller?.resize(widthPx, heightPx);
    // Resizing clears the canvas. Draw in this task (the host's ResizeObserver runs before paint),
    // or a blank frame could be composited before the next animation frame.
    this.loop?.renderNow();
  }

  dispose(): void {
    this.disposer.dispose();
    this.loop = undefined;
    this.controller?.dispose();
    this.controller = undefined;
    this.renderer?.dispose();
    this.renderer = undefined;
    this.intentListeners.clear();
    this.legendListeners.clear();
  }

  private applyOverlayState(controller: ViewportController): void {
    const o = this.overlayState;
    const overlays = controller.overlays;
    this.disposer.add(overlays.onLegendChange((s) => this.legendListeners.forEach((l) => l(s))));
    overlays.setReducedMotion(o.reducedMotion);
    overlays.attach(o.feed);
    overlays.setOverlay('voltage', o.voltage);
    overlays.setOverlay('current', o.current);
    if (o.highlight) overlays.highlightTerminals(o.highlight);
  }
}

/**
 * three r186's `Renderer.init()` starts its own `requestAnimationFrame` loop (it resets `info` and
 * ticks the node frame every vsync) whether or not `setAnimationLoop` is used. We draw on demand
 * through {@link RenderLoop}, so stop it, or the page wakes every frame for nothing. `_animation` is
 * private: if a release renames it this does nothing, and the cost is only that idle wake-up
 * (drawing stays on demand). See docs/caveats/rendering.md.
 */
function stopInternalAnimationLoop(renderer: WebGPURenderer): void {
  const animation = (renderer as unknown as { _animation?: { stop?: () => void } })._animation;
  if (typeof animation?.stop === 'function') animation.stop();
}
