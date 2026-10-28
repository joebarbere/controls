/**
 * Everything the viewport does except talk to the GPU: scene, camera, walk/work modes, input
 * actions, BVH hover/selection, world sync, the placement ghost and overlays. `ViewportRenderer`
 * wraps it with a `WebGPURenderer` and the animation loop. Keeping the GPU out means disposal,
 * picking and gestures are unit-tested in Node.
 *
 * The controller never mutates the world. It draws world snapshots ({@link syncWorld}) and turns
 * gesture commit points into {@link ViewportIntent}s, which `feature-workspace` executes as Commands
 * (`entity.place`, `entity.move`). Hover, selection, the ghost, mode and camera pose are view state.
 *
 * **Rendering is on demand.** The host draws a frame only when the controller asks through
 * {@link ViewportController.onInvalidate}, or when {@link ViewportController.update} returns `true`
 * (an animation that hasn't settled). Requests funnel through three places, so a new feature rarely
 * has to call {@link ViewportController.invalidate} itself: `markHoverDirty()` (anything that moves
 * the camera, the pointer, the ghost or the scene), `emit()` (any published view-state change) and
 * the input sources (held keys, mouse look, OrbitControls' `change`). Anything else that changes
 * what is drawn must call `invalidate()`, or the screen shows the old frame until the next input.
 */
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Box3, PerspectiveCamera, Sphere, Vector3, type Object3D, type Scene } from 'three/webgpu';
import { metresToMm, mm } from '@controls/units';
import {
  placeOnTargets,
  worldSnapTargets,
  type CatalogRef,
  type Entity,
  type EntityId,
  type OrientationMdeg,
  type Placement,
  type SnapTarget,
  type Vec3Mm,
  type World,
} from '@controls/world-model';
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
import { PlacementGhost } from './overlays/ghost';
import { SelectionHighlight } from './overlays/highlight';
import { findSelectables, Picker } from './picking/picker';
import { SelectionModel, type SelectableInfo } from './picking/selection';
import { buildBaseScene, DEFAULT_ROOM_BOUNDS, describeSceneGraph, disposeScene, type SceneGraphNode } from './scene';
import { FixtureSync } from './world/fixture-sync';
import { WorldSync } from './world/world-sync';

export interface ViewportControllerOptions {
  readonly bindings?: InputBindings;
  readonly walk?: Partial<WalkConfig>;
  /** Walkable area. Defaults to the world's floor fixture, or {@link DEFAULT_ROOM_BOUNDS} without one. */
  readonly room?: RoomBoundsMm;
  /**
   * Scene to draw the world into; the controller takes ownership and disposes it. Defaults to
   * {@link buildBaseScene} (lights only). Selectables already in it stay selectable (tests).
   */
  readonly scene?: Scene;
  /**
   * Focus target for the initial work-mode camera (and {@link ViewportController.resetView}).
   * Defaults to the first backplate in id order (the panel is P1's main work surface), else the
   * first focusable selectable.
   */
  readonly initialFocus?: string;
}

/** The ghost in progress: placing the active tool's prop, or moving an entity. */
export interface PlacementView {
  readonly kind: 'place' | 'move';
  readonly ref: CatalogRef;
  /** The entity being moved (`move` only). */
  readonly entityId: EntityId | null;
  /** Whether committing now would produce a command. */
  readonly valid: boolean;
  /** The snap target under the cursor, if any. */
  readonly targetId: string | null;
  /** What aims the ghost: the mouse pointer, or the screen-centre reticle (keyboard, pointer lock). */
  readonly source: 'pointer' | 'reticle';
}

/** View state published to the UI (HUD, inspector, `when` context keys). */
export interface ViewportState {
  readonly mode: ViewMode;
  readonly pointerLocked: boolean;
  readonly focusId: string | null;
  readonly hovered: SelectableInfo | null;
  readonly selected: SelectableInfo | null;
  readonly placement: PlacementView | null;
}

export type ViewportStateListener = (state: ViewportState) => void;

/**
 * A gesture's commit point, for the workspace to execute as exactly one Command. `place` and `move`
 * carry the exact arguments (`placeOnTargets` from `@controls/world-model`, the same maths scripts
 * use). `cancelPlacement` is Escape while placing: no command, the workspace clears the tool.
 */
export type ViewportIntent =
  | {
      readonly kind: 'place';
      readonly ref: CatalogRef;
      readonly positionMm: Vec3Mm;
      readonly orientationMdeg: OrientationMdeg;
    }
  | { readonly kind: 'move'; readonly id: EntityId; readonly positionMm: Vec3Mm }
  | { readonly kind: 'cancelPlacement' };

export type ViewportIntentListener = (intent: ViewportIntent) => void;

/** A press-and-release within this many CSS pixels is a click, not an orbit drag (game-design). */
export const CLICK_SLOP_PX = 4;

interface Moving {
  readonly id: EntityId;
  /** The snapshot the move started from; a sync that changes it cancels the move. */
  readonly entity: Entity;
  readonly object: Object3D;
  /** Started by dragging (commits on release) rather than by the keyboard (commits on Enter or click). */
  readonly byPointer: boolean;
}

const samePosition = (a: Vec3Mm, b: Vec3Mm): boolean => a.x === b.x && a.y === b.y && a.z === b.z;
const sameRef = (a: CatalogRef | null, b: CatalogRef | null): boolean =>
  a === b || (a !== null && b !== null && a.id === b.id && a.version === b.version);

export class ViewportController {
  readonly scene: Scene;
  readonly camera = new PerspectiveCamera(45, 1, 0.01, 50);
  readonly selection = new SelectionModel();

  private readonly disposer = new Disposer();
  private readonly picker = new Picker();
  /** Picks fixtures only (snap surfaces and what hides them), so props never block the ghost. */
  private readonly surfacePicker = new Picker();
  /** What placement snaps to: `worldSnapTargets(world)` (the same targets scripts use), plus any in a custom scene. */
  private snapTargets: readonly SnapTarget[] = [];
  /** Selectables that came with the scene itself (none in the base scene). */
  private readonly sceneSelectables: ReadonlyArray<{ root: Object3D; info: SelectableInfo }>;
  private readonly fixtures: FixtureSync;
  private readonly world: WorldSync;
  private readonly ghost: PlacementGhost;
  private readonly highlight: SelectionHighlight;
  private readonly orbit: OrbitControls;
  private readonly keyboard: KeyboardInput;
  private readonly look: PointerLockLook;
  private readonly roots = new Map<string, Object3D>();
  private readonly listeners = new Set<ViewportStateListener>();
  private readonly intentListeners = new Set<ViewportIntentListener>();
  private readonly invalidateListeners = new Set<() => void>();
  /** Inside {@link update}: what changes now is drawn by the frame in progress, so no new request. */
  private updating = false;
  private readonly walkConfig: WalkConfig;
  private readonly roomOverride: RoomBoundsMm | null;
  private room: RoomBoundsMm;
  private readonly initialFocus: string | undefined;

  private modeValue: ViewMode = 'work';
  private focusIdValue: string | null = null;
  /** The active tool's prop (placement armed), from the tool belt. */
  private armed: CatalogRef | null = null;
  private moving: Moving | null = null;
  /** A press on an entity that becomes a move once it drags past the click slop. */
  private press: { readonly id: EntityId; readonly pointerId: number } | null = null;
  private ghostResult: Placement | null = null;
  private ghostSource: PlacementView['source'] = 'reticle';

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
    this.roomOverride = options.room ?? null;
    this.room = this.roomOverride ?? DEFAULT_ROOM_BOUNDS;
    this.initialFocus = options.initialFocus;
    this.scene = options.scene ?? buildBaseScene();
    this.camera.rotation.order = 'YXZ'; // yaw then pitch, for walk mode
    // Teardown runs in reverse: scene last, after everything that references it.
    this.disposer.add(() => disposeScene(this.scene));

    this.sceneSelectables = findSelectables(this.scene);
    this.disposer.add(() => this.surfacePicker.dispose());
    this.disposer.add(() => this.picker.dispose());

    // Fixtures (level geometry) share reference-counted fixture recipes. World entities and the ghost
    // share reference-counted prop recipes. All leave the scene (releasing their geometry) before
    // the scene itself is disposed.
    this.fixtures = new FixtureSync(this.scene);
    this.disposer.add(() => this.fixtures.dispose());
    this.refreshSurfaces();
    this.world = new WorldSync(this.scene);
    this.disposer.add(() => this.world.dispose());
    this.ghost = new PlacementGhost(this.scene, this.world.recipes);
    this.disposer.add(() => this.ghost.dispose());

    this.highlight = new SelectionHighlight(this.scene);
    this.disposer.add(() => this.highlight.dispose());
    this.refreshSelectables();
    const offSelection = this.selection.onChange(() => {
      this.refreshHighlight();
      this.emit();
    });
    this.disposer.add(() => {
      offSelection();
      this.selection.dispose();
    });

    // Our pointer listeners go first (and in the capture phase) so a press on an entity can switch
    // orbiting off before OrbitControls sees it: that drag moves the entity instead.
    this.listenPointer();
    this.orbit = new OrbitControls(this.camera, element);
    this.orbit.enableDamping = true;
    // OrbitControls applies drags and wheel steps in its own handlers and reports them as `change`.
    const onOrbitChange = (): void => this.markHoverDirty();
    this.orbit.addEventListener('change', onOrbitChange);
    this.disposer.add(() => {
      this.orbit.removeEventListener('change', onOrbitChange);
      this.orbit.dispose();
    });

    this.keyboard = new KeyboardInput(
      element,
      element.ownerDocument.defaultView,
      (a) => this.onTrigger(a),
      options.bindings ?? DEFAULT_INPUT_BINDINGS,
      () => this.invalidate(), // a held key went down or up: walk mode animates while one is held
    );
    this.disposer.add(() => this.keyboard.dispose());

    this.look = new PointerLockLook(
      element,
      (dx, dy) => {
        this.lookDx += dx;
        this.lookDy += dy;
        this.invalidate();
      },
      () => this.emit(),
    );
    this.disposer.add(() => this.look.dispose());
    this.disposer.add(() => {
      this.listeners.clear();
      this.intentListeners.clear();
      this.invalidateListeners.clear();
    });

    this.focusInitial();
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
      placement: this.placementView(),
    };
  }

  onChange(listener: ViewportStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Gesture commit points (place, move, cancel). The workspace turns them into Commands. */
  onIntent(listener: ViewportIntentListener): () => void {
    this.intentListeners.add(listener);
    return () => this.intentListeners.delete(listener);
  }

  /** Called whenever something visible changed and a frame should be drawn (the host's render loop). */
  onInvalidate(listener: () => void): () => void {
    this.invalidateListeners.add(listener);
    return () => this.invalidateListeners.delete(listener);
  }

  /**
   * Asks the host for a frame. Most changes reach this through `markHoverDirty()` or `emit()`; call
   * it directly for any other change to what is drawn (a new overlay, a material tweak, …).
   * Ignored inside {@link update}: the frame in progress draws that change.
   */
  invalidate(): void {
    if (this.updating) return;
    this.invalidateListeners.forEach((l) => l());
  }

  /**
   * Draws a world snapshot: entities are added, updated or removed by id (`WorldSync`), and the
   * picking BVH and keyboard selection list follow. Never mutates `world`.
   */
  syncWorld(world: World): void {
    const fixturesChanged = this.fixtures.sync(world);
    if (fixturesChanged) {
      this.room = this.roomOverride ?? this.fixtures.room() ?? DEFAULT_ROOM_BOUNDS;
      this.refreshSurfaces();
    }
    const result = this.world.sync(world);
    if (this.moving && this.world.entityOf(this.moving.id) !== this.moving.entity) this.endMove();
    if (result.membershipChanged || fixturesChanged) {
      this.refreshSelectables();
    } else if (result.transformsChanged) {
      this.picker.refit();
      this.refreshHighlight();
    }
    // A level change: if the focus target went away (or there was none yet), frame the initial one.
    if (fixturesChanged && (this.focusIdValue === null || !this.roots.has(this.focusIdValue))) {
      this.focusIdValue = null;
      this.focusInitial();
    }
    this.markHoverDirty();
  }

  /**
   * Back to the starting view (a new session): work mode, no selection, the initial focus target.
   * View state only, so it is not a Command.
   */
  resetView(): void {
    if (this.moving) this.endMove();
    this.selection.select(null);
    this.focusIdValue = null;
    if (this.modeValue !== 'work') this.setMode('work');
    this.focusInitial();
    this.emit();
  }

  /**
   * Arms placement of `ref` (the active tool-belt prop) or disarms it with `null`. While armed, the
   * ghost follows the pointer (or the reticle) and a click or Enter commits one `place` intent.
   */
  setPlacement(ref: CatalogRef | null): void {
    if (sameRef(ref, this.armed)) return;
    if (this.moving) this.endMove();
    this.armed = ref;
    this.ghostResult = null;
    if (!ref) this.ghost.clear();
    this.markHoverDirty();
    this.emit();
  }

  /**
   * Switches between walk and work. Entering walk keeps the current eye position (clamped to the
   * room, at eye height) and view direction; entering work re-focuses the last focus target.
   * The workspace calls this when the `view.mode` command runs, and publishes `mode` as a context key.
   */
  setMode(mode: ViewMode): void {
    if (mode === this.modeValue) return;
    if (this.moving) this.endMove();
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
    this.markHoverDirty();
    this.emit();
  }

  /**
   * Focuses a target in work mode (switching to work if needed): the camera frames it along its
   * working face, and orbit and pan are limited around it. Returns false if `id` can't be focused.
   * The workspace calls this when the `view.focus` command runs.
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

  /** Where an integer-mm world point appears on the canvas, in CSS pixels from its top-left (tests, overlays). */
  projectMm(p: Vec3Mm): { x: number; y: number } {
    this.camera.updateMatrixWorld();
    const v = this.tmpVec.set(mm(p.x), mm(p.y), mm(p.z)).project(this.camera);
    const w = this.element.clientWidth || 1;
    const h = this.element.clientHeight || 1;
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
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
    this.markHoverDirty();
  }

  /**
   * Per-frame update, run by the host before each draw. Allocation-free on the hot path (no hover
   * change, no input). Returns whether another frame is needed straight away: in walk mode while a
   * key is held (movement is applied per frame), and in work mode while orbit damping is still
   * moving the camera. With `false` the host goes idle until the next {@link invalidate}.
   */
  update(dtSeconds: number): boolean {
    this.updating = true;
    try {
      let animating = false;
      if (this.modeValue === 'walk') {
        if (this.lookDx !== 0 || this.lookDy !== 0) {
          applyLook(this.pose, this.lookDx, this.lookDy, this.walkConfig);
          this.lookDx = 0;
          this.lookDy = 0;
          this.markHoverDirty();
        }
        moveIntent(this.keyboard.held, this.intent);
        if (this.intent.forward !== 0 || this.intent.strafe !== 0) this.markHoverDirty();
        stepWalk(this.pose, this.intent, dtSeconds, this.room, this.walkConfig);
        this.applyPose();
        animating = this.keyboard.held.size > 0;
      } else if (this.orbit.update(dtSeconds)) {
        this.markHoverDirty();
        animating = true; // damping: keep going until OrbitControls reports no change
      }
      if (this.hoverDirty) {
        this.hoverDirty = false;
        this.updateHover();
        this.updateGhost();
      }
      return animating;
    } finally {
      this.updating = false;
    }
  }

  /** JSON-plain scene summary for snapshot tests. */
  sceneGraph(): SceneGraphNode {
    return describeSceneGraph(this.scene);
  }

  /** Number of geometry BVHs held (0 after dispose). */
  get bvhCount(): number {
    return this.picker.bvhCount + this.surfacePicker.bvhCount;
  }

  /** Number of world entities drawn. */
  get entityCount(): number {
    return this.world.size;
  }

  /** Number of live shared prop recipes (geometry + material pairs); 0 once no prop is drawn. */
  get recipeCount(): number {
    return this.world.recipes.size;
  }

  /** Number of fixtures drawn (level geometry). */
  get fixtureCount(): number {
    return this.fixtures.size;
  }

  /** Number of live shared fixture recipes; 0 after dispose or on a world without fixtures. */
  get fixtureRecipeCount(): number {
    return this.fixtures.recipes.size;
  }

  /** The walkable area in use (the floor fixture's, or the default). */
  get roomBounds(): RoomBoundsMm {
    return this.room;
  }

  dispose(): void {
    this.disposer.dispose();
  }

  // --- gestures ------------------------------------------------------------------------------

  /** The prop the ghost shows, or `null` when no gesture is active. */
  private gestureRef(): CatalogRef | null {
    return this.moving?.entity.ref ?? this.armed;
  }

  private placementView(): PlacementView | null {
    const ref = this.gestureRef();
    if (!ref) return null;
    const r = this.ghostResult;
    return {
      kind: this.moving ? 'move' : 'place',
      ref,
      entityId: this.moving?.id ?? null,
      valid: r?.ok === true,
      targetId: r?.targetId ?? null,
      source: this.ghostSource,
    };
  }

  /** The cursor that aims a gesture: the pointer over the canvas, else the screen-centre reticle. */
  private cursorNdc(): { x: number; y: number; source: PlacementView['source'] } {
    const lockedWalk = this.modeValue === 'walk' && this.look.isLocked;
    if (this.pointer.inside && !lockedWalk) return { x: this.pointer.ndcX, y: this.pointer.ndcY, source: 'pointer' };
    return { x: 0, y: 0, source: 'reticle' };
  }

  /** Where the gesture's prop would go now. Pure maths in `@controls/world-model`. */
  private placementNow(ref: CatalogRef): Placement {
    const c = this.cursorNdc();
    this.ghostSource = c.source;
    this.camera.updateMatrixWorld();
    const hit = this.surfacePicker.pick(c.x, c.y, this.camera);
    if (!hit) return { ok: false, reason: 'no-target', targetId: null };
    const cursor = { x: metresToMm(hit.point.x), y: metresToMm(hit.point.y), z: metresToMm(hit.point.z) };
    const options = this.moving ? { orientationMdeg: this.moving.entity.transform.orientationMdeg } : {};
    return placeOnTargets(ref, cursor, this.snapTargets, options);
  }

  private updateGhost(): void {
    const ref = this.gestureRef();
    if (!ref) return;
    const before = this.placementView();
    const r = this.placementNow(ref);
    this.ghostResult = r;
    if (r.ok) this.ghost.show(ref, r.positionMm, r.orientationMdeg);
    else this.ghost.hide();
    const after = this.placementView();
    if (before?.valid !== after?.valid || before?.targetId !== after?.targetId || before?.source !== after?.source) {
      this.emit();
    }
  }

  /**
   * Commits the active gesture at the cursor: at most one intent (`place`, or `move` if the position
   * changed). Returns whether a gesture was active (the key or click is then consumed).
   */
  private commit(): boolean {
    const ref = this.gestureRef();
    if (!ref) return false;
    const r = this.placementNow(ref);
    const moving = this.moving;
    if (moving) {
      this.endMove();
      if (r.ok && !samePosition(r.positionMm, moving.entity.transform.positionMm)) {
        this.emitIntent({ kind: 'move', id: moving.id, positionMm: r.positionMm });
      }
    } else if (r.ok) {
      this.emitIntent({ kind: 'place', ref, positionMm: r.positionMm, orientationMdeg: r.orientationMdeg });
    }
    this.markHoverDirty();
    return true;
  }

  private startMove(id: EntityId, byPointer: boolean): boolean {
    const entity = this.world.entityOf(id);
    const object = this.world.objectOf(id);
    if (!entity || !object) return false;
    this.moving = { id, entity, object, byPointer };
    object.visible = false; // the ghost stands in for it until the move commits or cancels
    this.ghostResult = null;
    this.markHoverDirty();
    this.emit();
    return true;
  }

  /** Ends a move without a command: the entity reappears where the world has it. */
  private endMove(): void {
    const moving = this.moving;
    if (!moving) return;
    moving.object.visible = true;
    this.moving = null;
    this.ghostResult = null;
    if (!this.armed) this.ghost.clear();
    this.markHoverDirty();
    this.emit();
  }

  private emitIntent(intent: ViewportIntent): void {
    [...this.intentListeners].forEach((l) => l(intent));
  }

  // --- internals -----------------------------------------------------------------------------

  /** Rebuilds the snap targets and the placement picker from the fixtures (and any scene selectables). */
  private refreshSurfaces(): void {
    const sceneTargets = this.sceneSelectables.flatMap((f) => (f.info.snapTarget ? [f.info.snapTarget] : []));
    this.snapTargets = [...sceneTargets, ...worldSnapTargets(this.fixtures.worldFixtures())];
    // Snap surfaces and the fixtures that hide them (a hit on the backboard is on no target).
    this.surfacePicker.setRoots([
      ...this.sceneSelectables.filter((f) => f.info.snapTarget).map((f) => f.root),
      ...this.fixtures.surfaceRoots(),
    ]);
  }

  /** Frames the initial focus target (see `initialFocus`), if any; walk mode keeps it for later. */
  private focusInitial(): void {
    const all = this.selection.all;
    const id = this.initialFocus ?? (all.find((s) => s.kind === 'backplate') ?? all.find((s) => s.focusNormal))?.id;
    if (!id) return;
    if (this.modeValue === 'work') this.focus(id);
    else if (this.selection.get(id)?.focusNormal) this.focusIdValue = id;
  }

  /** Rebuilds the selectable list and the picking BVH from the scene, the fixtures and the world entities. */
  private refreshSelectables(): void {
    const all = [...this.sceneSelectables, ...this.fixtures.selectables(), ...this.world.selectables()];
    this.roots.clear();
    all.forEach(({ root, info }) => this.roots.set(info.id, root));
    this.selection.setSelectables(all.map((a) => a.info));
    this.picker.setRoots(all.map((a) => a.root));
    this.refreshHighlight();
  }

  private refreshHighlight(): void {
    const s = this.selection;
    this.highlight.setHover(s.hovered ? (this.roots.get(s.hovered.id) ?? null) : null);
    this.highlight.setSelection(s.selected ? (this.roots.get(s.selected.id) ?? null) : null);
  }

  private applyFocus(id: string): void {
    const root = this.roots.get(id);
    const normal = this.selection.get(id)?.focusNormal;
    if (!root || !normal) return;
    this.tmpBox.setFromObject(root).getBoundingSphere(this.tmpSphere);
    const c = this.tmpSphere.center;
    const elevation = ((this.selection.get(id)?.focusElevationDeg ?? 0) * Math.PI) / 180;
    const orbit = workOrbitFor(
      { id, center: { x: c.x, y: c.y, z: c.z }, radius: this.tmpSphere.radius, normal, elevation },
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
    this.markHoverDirty();
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

  private onTrigger(action: TriggeredAction): boolean {
    switch (action) {
      case 'selectNext':
        this.selectNext();
        return true;
      case 'selectPrevious':
        this.selectPrevious();
        return true;
      case 'clearSelection':
        // Escape, innermost first: cancel a move, cancel placement, clear the selection. With
        // nothing to cancel it isn't consumed, so the shell can still open the menu.
        if (this.moving) {
          this.endMove();
          return true;
        }
        if (this.armed) {
          this.setPlacement(null);
          this.emitIntent({ kind: 'cancelPlacement' });
          return true;
        }
        if (!this.selection.selected) return false;
        this.select(null);
        return true;
      case 'commitPlacement':
        return this.commit();
      case 'moveSelection': {
        const id = this.selection.selected?.entityId;
        if (this.armed || this.moving || id === undefined) return false;
        return this.startMove(id, false);
      }
    }
  }

  private listenPointer(): void {
    const el = this.element;
    const capture = { capture: true };
    const toNdc = (e: PointerEvent): void => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      this.pointer.inside = true;
      this.pointer.ndcX = (e.offsetX / w) * 2 - 1;
      this.pointer.ndcY = -(e.offsetY / h) * 2 + 1;
    };
    const dragged = (e: PointerEvent): boolean =>
      Math.hypot(e.offsetX - this.pointer.downX, e.offsetY - this.pointer.downY) > CLICK_SLOP_PX;
    this.disposer.listen<PointerEvent>(
      el,
      'pointermove',
      (e) => {
        toNdc(e);
        this.markHoverDirty();
        if (this.press && !this.moving && this.pointer.down && dragged(e)) {
          if (this.startMove(this.press.id, true)) el.setPointerCapture?.(this.press.pointerId);
        }
      },
      capture,
    );
    this.disposer.listen<PointerEvent>(el, 'pointerleave', () => {
      this.pointer.inside = false;
      this.markHoverDirty();
    });
    this.disposer.listen<PointerEvent>(
      el,
      'pointerdown',
      (e) => {
        if (e.button !== 0) return;
        this.pointer.down = true;
        this.pointer.downX = e.offsetX;
        this.pointer.downY = e.offsetY;
        el.focus?.({ preventScroll: true }); // keyboard actions need the viewport focused
        if (this.modeValue !== 'work' || this.armed || this.moving) return;
        toNdc(e);
        const id = this.pickAt(this.pointer.ndcX, this.pointer.ndcY)?.entityId;
        if (id === undefined) return;
        // A press on an entity: a drag moves it rather than orbiting.
        this.press = { id, pointerId: e.pointerId };
        this.orbit.enabled = false;
      },
      capture,
    );
    this.disposer.listen<PointerEvent>(
      el,
      'pointerup',
      (e) => {
        if (e.button !== 0 || !this.pointer.down) return;
        this.pointer.down = false;
        const press = this.press;
        if (press) {
          this.press = null;
          this.orbit.enabled = this.modeValue === 'work';
          if (el.hasPointerCapture?.(press.pointerId)) el.releasePointerCapture?.(press.pointerId);
        }
        toNdc(e);
        if (this.moving?.byPointer) {
          this.commit(); // releasing a drag drops the entity: one move, never one per frame
          return;
        }
        if (dragged(e)) return; // an orbit drag, not a click
        if (this.modeValue === 'walk' && !this.look.isLocked) {
          this.look.request();
          return;
        }
        if (this.gestureRef()) {
          this.commit(); // a click places the active prop (or drops a keyboard move)
          return;
        }
        const locked = this.modeValue === 'walk';
        const hit = locked ? this.pickAt(0, 0) : this.pickAt(this.pointer.ndcX, this.pointer.ndcY);
        this.selection.select(hit?.id ?? null);
      },
      capture,
    );
  }

  /** Re-pick hover and re-aim the ghost on the next frame, and ask for that frame. */
  private markHoverDirty(): void {
    this.hoverDirty = true;
    this.invalidate();
  }

  /** Publishes view state. Every published change is visible (highlight, ghost, mode), so it also asks for a frame. */
  private emit(): void {
    this.invalidate();
    if (this.listeners.size === 0) return;
    const s = this.state;
    this.listeners.forEach((l) => l(s));
  }
}
