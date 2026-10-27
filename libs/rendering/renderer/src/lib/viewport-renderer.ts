import { PerspectiveCamera, WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildPanelScene, disposeScene } from './panel-scene';

export type RenderBackend = 'webgpu' | 'webgl2';

export interface ViewportOptions {
  /** Skip WebGPU even when available (CI determinism, driver workarounds). */
  readonly forceWebGL?: boolean;
}

/**
 * Owns the Three.js renderer, scene, camera and animation loop for one canvas.
 * Framework-free: the Angular viewport component only hands over a canvas and sizes.
 * P0 content is a static sub-panel (backplate + two DIN rails) to prove the pipeline.
 */
export class ViewportRenderer {
  private renderer?: WebGPURenderer;
  private controls?: OrbitControls;
  private readonly scene = buildPanelScene();
  private readonly camera = new PerspectiveCamera(45, 1, 0.01, 50);
  private backendName?: RenderBackend;

  async init(canvas: HTMLCanvasElement, options: ViewportOptions = {}): Promise<RenderBackend> {
    const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL: options.forceWebGL ?? false });
    await renderer.init();
    this.renderer = renderer;
    // WebGPURenderer silently falls back to its WebGL2 backend when WebGPU is unavailable.
    this.backendName = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';

    this.camera.position.set(0.25, 0.1, 0.9);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.update();

    renderer.setAnimationLoop(() => {
      this.controls?.update();
      renderer.render(this.scene, this.camera);
    });
    return this.backendName;
  }

  get backend(): RenderBackend | undefined {
    return this.backendName;
  }

  resize(widthPx: number, heightPx: number, devicePixelRatio: number): void {
    if (!this.renderer || widthPx === 0 || heightPx === 0) return;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(widthPx, heightPx, false);
    this.camera.aspect = widthPx / heightPx;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.renderer?.setAnimationLoop(null);
    this.controls?.dispose();
    disposeScene(this.scene);
    this.renderer?.dispose();
    this.renderer = undefined;
  }
}
