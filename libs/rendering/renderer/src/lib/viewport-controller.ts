/**
 * Everything the viewport does except talk to the GPU: scene, camera, walk/work modes, input
 * actions, BVH hover/selection and overlays. `ViewportRenderer` wraps it with a `WebGPURenderer`
 * and the animation loop. Keeping the GPU out means disposal and picking are unit-tested in Node.
 *
 * The controller never mutates the world. Placement, moves and deletes will be emitted as
 * Commands by `feature-workspace` (TODO(F1.2)); hover, selection, mode and camera pose are view state.
 */
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Box3, PerspectiveCamera, Sphere, Vector3, type Object3D, type Scene } from 'three/webgpu';
import {
  applyLook,
  clampToRoom,
  DEFAULT_WALK_CONFIG,
  stepWalk,
  workOrbitFor,
  yawPitchFromDirection,
  type RoomBoundsMm,
  type ViewMode,
  type WalkConfig,
  type WalkPose,
} from './cameras/camera-math';
import { PointerLockLook } from './cameras/pointer-lock-look';
import { Disposer } from './disposer';
import {
  DEFAULT_INPUT_BINDINGS,
  moveIntent,
  type InputBindings,
  type MoveIntent,
  type TriggeredAction,
} from './input/input-actions';
import { KeyboardInput } from './input/keyboard-input';
import { SelectionHighlight } from './overlays/highlight';
import {
  buildPanelScene,
  describeSceneGraph,
  disposeScene,
  PANEL_ROOM_BOUNDS,
  type SceneGraphNode,
} from './panel-scene';
import { findSelectables, Picker } from './picking/picker';
import { SelectionModel, type SelectableInfo } from './picking/selection';

export interface ViewportControllerOptions {
  readonly bindings?: InputBindings;
  readonly walk?: Partial<WalkConfig>;
  readonly room?: RoomBoundsMm;
  /** Scene to show; the controller takes ownership and disposes it. Defaults to the demo panel. */
  readonly scene?: Scene;
  /** Focus target for the initial work-mode camera. Defaults to the first focusable selectable. */
  readonly initialFocus?: string;
}

/** View state published to the UI (HUD, inspector, `when` context keys from F1.2). */
export interface ViewportState {
  readonly mode: ViewMode;
  readonly pointerLocked: boolean;
  readonly focusId: string | null;
  readonly hovered: SelectableInfo | null;
  readonly selected: SelectableInfo | null;
}

export type ViewportStateListener = (state: ViewportState) => void;

/** A press-and-release within this many CSS pixels is a click, not an orbit drag (game-design). */
export const CLICK_SLOP_PX = 4;

export class ViewportController {
  readonly scene: Scene;
  readonly camera = new PerspectiveCamera(45, 1, 0.01, 50);
  readonly selection = new SelectionModel();

  private readonly disposer = new Disposer();
  private readonly picker = new Picker();
  private readonly highlight: SelectionHighlight;
  private readonly orbit: OrbitControls;
  private readonly keyboard: KeyboardInput;
  private readonly look: PointerLockLook;
  private readonly roots = new Map<string, Object3D>();
  private readonly listeners = new Set<ViewportStateListener>();
  private readonly walkConfig: WalkConfig;
  private readonly room: RoomBoundsMm;

  private modeValue: ViewMode = 'work';
  private focusIdValue: string | null = null;

  // Per-frame scratch (no allocation in update()).
  private readonly pose: WalkPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  private readonly intent: MoveIntent = { forward: 0, strafe: 0, sprint: false };
  private readonly pointer = { inside: false, ndcX: 0, ndcY: 0, downX: 0, downY: 0, down: false };
  private hoverDirty = false;
  private lookDx = 0;
  private lookDy = 0;
  private readonly tmpBox = new Box3();
  private readonly tmpSphere = new Sphere();
  private readonly tmpVec = new Vector3();

  constructor(
    private readonly element: HTMLElement,
    options: ViewportControllerOptions = {},
  ) {
    this.walkConfig = { ...DEFAULT_WALK_CONFIG, ...options.walk };
    this.room = options.room ?? PANEL_ROOM_BOUNDS;
    this.scene = options.scene ?? buildPanelScene();
    this.camera.rotation.order = 'YXZ'; // yaw then pitch, for walk mode
    // Teardown runs in reverse: scene last, after everything that references it.
    this.disposer.add(() => disposeScene(this.scene));

    const found = findSelectables(this.scene);
    found.forEach(({ root, info }) => this.roots.set(info.id, root));
    this.selection.setSelectables(found.map((f) => f.info));
    this.picker.setRoots(found.map((f) => f.root));
    this.disposer.add(() => this.picker.dispose());

    this.highlight = new SelectionHighlight(this.scene);
    this.disposer.add(() => this.highlight.dispose());
    const offSelection = this.selection.onChange((s) => {
      this.highlight.setHover(s.hovered ? (this.roots.get(s.hovered.id) ?? null) : null);
      this.highlight.setSelection(s.selected ? (this.roots.get(s.selected.id) ?? null) : null);
      this.emit();
    });
    this.disposer.add(() => {
      offSelection();
      this.selection.dispose();
    });

    this.orbit = new OrbitControls(this.camera, element);
    this.orbit.enableDamping = true;
    this.disposer.add(() => this.orbit.dispose());

    this.keyboard = new KeyboardInput(
      element,
      element.ownerDocument.defaultView,
      (a) => this.onTrigger(a),
      options.bindings ?? DEFAULT_INPUT_BINDINGS,
    );
    this.disposer.add(() => this.keyboard.dispose());

    this.look = new PointerLockLook(
      element,
      (dx, dy) => {
        this.lookDx += dx;
        this.lookDy += dy;
      },
      () => this.emit(),
    );
    this.disposer.add(() => this.look.dispose());

    this.listenPointer();
    this.disposer.add(() => this.listeners.clear());

    const initial = options.initialFocus ?? this.selection.all.find((s) => s.focusNormal)?.id;
    if (initial) this.focus(initial);
  }

  get mode(): ViewMode {
    return this.modeValue;
  }

  get state(): ViewportState {
    return {
      mode: this.modeValue,
      pointerLocked: this.look.isLocked,
      focusId: this.focusIdValue,
      hovered: this.selection.hovered,
      selected: this.selection.selected,
    };
  }

  onChange(listener: ViewportStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Switches between walk and work. Entering walk keeps the current eye position (clamped to the
   * room, at eye height) and view direction; entering work re-focuses the last focus target.
   * TODO(F1.2): exposed as the `view.mode walk|work` Command; mode becomes a `when` context key.
   */
  setMode(mode: ViewMode): void {
    if (mode === this.modeValue) return;
    this.modeValue = mode;
    if (mode === 'walk') {
      this.orbit.enabled = false;
      this.camera.updateMatrixWorld();
      const dir = this.camera.getWorldDirection(this.tmpVec);
      const { yaw, pitch } = yawPitchFromDirection(dir);
      this.pose.x = this.camera.position.x;
      this.pose.z = this.camera.position.z;
      this.pose.yaw = yaw;
      this.pose.pitch = pitch;
      clampToRoom(this.pose, this.room, this.walkConfig);
      this.applyPose();
    } else {
      this.look.release();
      this.orbit.enabled = true;
      if (this.focusIdValue) this.applyFocus(this.focusIdValue);
    }
    this.hoverDirty = true;
    this.emit();
  }

  /**
   * Focuses a target in work mode (switching to work if needed): the camera frames it along its
   * working face, and orbit and pan are limited around it. Returns false if `id` can't be focused.
   * TODO(F1.2): exposed as the `view.focus --target <id>` Command.
   */
  focus(id: string): boolean {
    if (!this.selection.get(id)?.focusNormal || !this.roots.has(id)) return false;
    this.focusIdValue = id;
    if (this.modeValue !== 'work') {
      this.setMode('work'); // re-focuses via applyFocus
    } else {
      this.applyFocus(id);
      this.emit();
    }
    return true;
  }

  select(id: string | null): boolean {
    return this.selection.select(id);
  }

  selectNext(): SelectableInfo | null {
    return this.selection.cycle(1);
  }

  selectPrevious(): SelectableInfo | null {
    return this.selection.cycle(-1);
  }

  /** Nearest selectable under NDC (−1…1, +y up), by BVH raycast. */
  pickAt(ndcX: number, ndcY: number): SelectableInfo | null {
    this.camera.updateMatrixWorld();
    return this.picker.pick(ndcX, ndcY, this.camera)?.info ?? null;
  }

  setBindings(bindings: InputBindings): void {
    this.keyboard.setBindings(bindings);
  }

  /** Requests pointer lock (walk mode). Must run inside a user gesture. */
  requestPointerLock(): void {
    if (this.modeValue === 'walk') this.look.request();
  }

  resize(widthPx: number, heightPx: number): void {
    if (widthPx <= 0 || heightPx <= 0) return;
    this.camera.aspect = widthPx / heightPx;
    this.camera.updateProjectionMatrix();
  }

  /** Per-frame update. Allocation-free on the hot path (no hover change, no input). */
  update(dtSeconds: number): void {
    if (this.modeValue === 'walk') {
      if (this.lookDx !== 0 || this.lookDy !== 0) {
        applyLook(this.pose, this.lookDx, this.lookDy, this.walkConfig);
        this.lookDx = 0;
        this.lookDy = 0;
        this.hoverDirty = true;
      }
      moveIntent(this.keyboard.held, this.intent);
      if (this.intent.forward !== 0 || this.intent.strafe !== 0) this.hoverDirty = true;
      stepWalk(this.pose, this.intent, dtSeconds, this.room, this.walkConfig);
      this.applyPose();
    } else if (this.orbit.update(dtSeconds)) {
      this.hoverDirty = true;
    }
    if (this.hoverDirty) {
      this.hoverDirty = false;
      this.updateHover();
    }
  }

  /** JSON-plain scene summary for snapshot tests. */
  sceneGraph(): SceneGraphNode {
    return describeSceneGraph(this.scene);
  }

  /** Number of geometry BVHs held (0 after dispose). */
  get bvhCount(): number {
    return this.picker.bvhCount;
  }

  dispose(): void {
    this.disposer.dispose();
  }

  private applyFocus(id: string): void {
    const root = this.roots.get(id);
    const normal = this.selection.get(id)?.focusNormal;
    if (!root || !normal) return;
    this.tmpBox.setFromObject(root).getBoundingSphere(this.tmpSphere);
    const c = this.tmpSphere.center;
    const orbit = workOrbitFor(
      { id, center: { x: c.x, y: c.y, z: c.z }, radius: this.tmpSphere.radius, normal },
      this.camera.fov,
      this.camera.aspect,
    );
    const o = this.orbit;
    o.target.set(orbit.target.x, orbit.target.y, orbit.target.z);
    o.cursor.copy(o.target);
    o.maxTargetRadius = orbit.maxTargetRadius;
    o.minDistance = orbit.minDistance;
    o.maxDistance = orbit.maxDistance;
    o.minPolarAngle = orbit.minPolarAngle;
    o.maxPolarAngle = orbit.maxPolarAngle;
    o.minAzimuthAngle = orbit.minAzimuthAngle;
    o.maxAzimuthAngle = orbit.maxAzimuthAngle;
    this.camera.position.set(orbit.position.x, orbit.position.y, orbit.position.z);
    // Damping would otherwise carry momentum from the previous target into the new one.
    o.enableDamping = false;
    o.update();
    o.enableDamping = true;
    this.hoverDirty = true;
  }

  private applyPose(): void {
    this.camera.position.set(this.pose.x, this.pose.y, this.pose.z);
    this.camera.rotation.set(this.pose.pitch, this.pose.yaw, 0);
  }

  private updateHover(): void {
    let hit: SelectableInfo | null = null;
    if (this.modeValue === 'walk' && this.look.isLocked) hit = this.pickAt(0, 0);
    else if (this.pointer.inside) hit = this.pickAt(this.pointer.ndcX, this.pointer.ndcY);
    this.selection.hover(hit?.id ?? null);
  }

  private onTrigger(action: TriggeredAction): void {
    switch (action) {
      case 'selectNext':
        this.selectNext();
        break;
      case 'selectPrevious':
        this.selectPrevious();
        break;
      case 'clearSelection':
        this.select(null);
        break;
      case 'focusSelection': {
        const s = this.selection.selected;
        if (s) this.focus(s.id);
        break;
      }
      case 'toggleMode':
        this.setMode(this.modeValue === 'walk' ? 'work' : 'walk');
        break;
    }
  }

  private listenPointer(): void {
    const el = this.element;
    const toNdc = (e: PointerEvent): void => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      this.pointer.ndcX = (e.offsetX / w) * 2 - 1;
      this.pointer.ndcY = -(e.offsetY / h) * 2 + 1;
    };
    this.disposer.listen<PointerEvent>(el, 'pointermove', (e) => {
      this.pointer.inside = true;
      toNdc(e);
      this.hoverDirty = true;
    });
    this.disposer.listen<PointerEvent>(el, 'pointerleave', () => {
      this.pointer.inside = false;
      this.hoverDirty = true;
    });
    this.disposer.listen<PointerEvent>(el, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      this.pointer.down = true;
      this.pointer.downX = e.offsetX;
      this.pointer.downY = e.offsetY;
      el.focus?.({ preventScroll: true }); // keyboard actions need the viewport focused
    });
    this.disposer.listen<PointerEvent>(el, 'pointerup', (e) => {
      if (e.button !== 0 || !this.pointer.down) return;
      this.pointer.down = false;
      const moved = Math.hypot(e.offsetX - this.pointer.downX, e.offsetY - this.pointer.downY);
      if (moved > CLICK_SLOP_PX) return; // an orbit drag, not a click
      if (this.modeValue === 'walk' && !this.look.isLocked) {
        this.look.request();
        return;
      }
      toNdc(e);
      const locked = this.modeValue === 'walk';
      const hit = locked ? this.pickAt(0, 0) : this.pickAt(this.pointer.ndcX, this.pointer.ndcY);
      this.selection.select(hit?.id ?? null);
    });
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const s = this.state;
    this.listeners.forEach((l) => l(s));
  }
}
