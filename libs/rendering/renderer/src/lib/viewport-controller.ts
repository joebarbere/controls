/**
 * Everything the viewport does except talk to the GPU: scene, camera, walk/work modes, input
 * actions, BVH hover/selection, world sync, the placement ghost and overlays. `ViewportRenderer`
 * wraps it with a `WebGPURenderer` and the animation loop. Keeping the GPU out means disposal,
 * picking and gestures are unit-tested in Node.
 *
 * The controller never mutates the world. It draws world snapshots ({@link syncWorld}) and turns
 * gesture commit points into {@link ViewportIntent}s, which `feature-workspace` executes as Commands
 * (`entity.place`, `entity.move`). Hover, selection, the ghost, mode and camera pose are view state.
 * Where the ghost goes is `placeInWorld` (`@controls/world-model`): props and catalogue devices, onto
 * fixtures or onto the mounts of drawn enclosures (F3.5), with the commands' own checks, so a valid
 * ghost always commits and an invalid one says why (`PlacementView.reason`).
 *
 * **Routing (F3.2 part 3).** The UI holds the routing gesture ({@link RoutingSession}: the spool, the
 * first terminal, the waypoints so far) and gives it to {@link ViewportController.setRouting}; the
 * controller only draws it and reports picks as {@link RoutingEvent}s (a terminal, a waypoint, a
 * cancel), never a world change. Terminals are picked in screen space (`picking/screen-terminals`,
 * occlusion-filtered with the BVH picker), wires through their own BVH (`WireRenderer.pick`), the
 * preview rope and the proposal come from `proposeRoute` and `snapWaypoint` (`@controls/world-model`),
 * so the UI logs exactly the `wire.add` the preview showed.
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
import { Box3, PerspectiveCamera, Raycaster, Sphere, Vector2, Vector3, type Object3D, type Scene } from 'three/webgpu';
import { metresToMm, mm } from '@controls/units';
import { BUILTIN_CATALOG, type Catalog } from '@controls/catalog';
import {
  placeInWorld,
  proposeRoute,
  snapWaypoint,
  terminalPlace,
  worldSnapTargets,
  type CatalogRef,
  type ConductorColour,
  type Entity,
  type EntityId,
  type InEntry,
  type MountedOn,
  type OrientationMdeg,
  type PlacementWorld,
  type PositionMm,
  type RouteProposal,
  type RouteTerminal,
  type SnapTarget,
  type SnapWaypointOptions,
  type Vec3Mm,
  type World,
  type Waypoint,
  type WorldPlacement,
  type WorldPlacementFailure,
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
import { SimOverlays } from './overlays/sim-overlays';
import { WireRenderer, type WireGraph, type WirePick, type WirePreview, type WireRef } from './wires/wire-renderer';
import { findSelectables, Picker, type PickHit } from './picking/picker';
import { RoutingMarkers, type RoutingMarker } from './overlays/routing-markers';
import { TERMINAL_TARGET_MIN_PX, type ScreenTerminalPick } from './picking/screen-terminals';
import { cycleTerminal, deviceFocusFrame } from './picking/terminal-order';
import { TerminalPicker, type TerminalRef } from './picking/terminal-picker';
import { SelectionModel, type SelectableInfo } from './picking/selection';
import { PropRecipes } from './geometry/props';
import { buildBaseScene, DEFAULT_ROOM_BOUNDS, describeSceneGraph, disposeScene, type SceneGraphNode } from './scene';
import { BENCH_FOCUS_ELEVATION_DEG, FixtureSync } from './world/fixture-sync';
import type { DrawnLamp } from './sim/lamp-display';
import { entitySelectableId, WorldSync, type LampOutputs } from './world/world-sync';

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
  /** The catalogue refs draw and place against (default the built-in one; tests pass their own). */
  readonly catalog?: Catalog;
}

/** The ghost in progress: placing the active tool's prop, or moving an entity. */
export interface PlacementView {
  readonly kind: 'place' | 'move';
  readonly ref: CatalogRef;
  /** The entity being moved (`move` only). */
  readonly entityId: EntityId | null;
  /** Whether committing now would produce a command. */
  readonly valid: boolean;
  /**
   * Why it isn't valid: a snap failure (`no-target`, `too-large`, …) or the refusal the command would
   * give (`mount-full`, `overlaps`, `occupied`, …); `null` while valid or before the first aim.
   */
  readonly reason: WorldPlacementFailure | null;
  /** The enclosure mount it would go on (`entity.place`'s `mountedOn`), or `null`. */
  readonly mountedOn: MountedOn | null;
  /** The enclosure entry a conduit connector would go in (`entity.place`'s `inEntry`), or `null`. */
  readonly inEntry: InEntry | null;
  /** The snap target under the cursor, if any. */
  readonly targetId: string | null;
  /** What aims the ghost: the mouse pointer, or the screen-centre reticle (keyboard, pointer lock). */
  readonly source: 'pointer' | 'reticle';
}

/**
 * The routing gesture as the UI holds it (F3.2 part 3). The controller draws it (markers, the preview
 * rope, the proposal) and reports picks as {@link RoutingEvent}s; the UI updates the session and, once
 * both ends are picked, logs exactly one `wire.add` with the proposal's arguments.
 */
export interface RoutingSession {
  /** The conductor on the spool (the active tool-belt slot). */
  readonly ref: CatalogRef;
  readonly colour: ConductorColour | null;
  /** The route's first terminal (and how it will land), or `null` before the first pick. */
  readonly from: RouteTerminal | null;
  /** The waypoints picked so far, in order (from `waypoint` events; Backspace drops the last). */
  readonly waypoints: readonly Waypoint[];
  /** How the second end will land (default `'auto'`): the proposal ends at that method's entry point. */
  readonly termination?: RouteTerminal['termination'];
  /** Auto-route through ducts while no waypoint is picked (default `true`). */
  readonly auto?: boolean;
  /** What a waypoint click may snap to (default ducts, conduit and staples; bores need a bit). */
  readonly snap?: SnapWaypointOptions;
  /**
   * What the gesture's ends are (F3.2 part 4): `terminals` (the default, a conductor's route) or
   * `entries` (a cable's, between enclosure entries). With `entries` no terminal is hovered, picked or
   * previewed: a click on an entity reports an `entity` event (the UI resolves the entry), a click
   * elsewhere a waypoint once the route has started, and Enter an `enter` event.
   */
  readonly ends?: 'terminals' | 'entries';
  /**
   * Where the route starts when its first end isn't a terminal (a cable's first entry, F3.2 part 4),
   * else absent: the preview rope and waypoint picks start here while `from` is `null`.
   */
  readonly startMm?: PositionMm | null;
  /** A point the keyboard holds (a cable's entry, cycled by the UI), drawn with the focus marker. */
  readonly keyPointMm?: PositionMm | null;
  /**
   * `entries` only (F3.4 part 2): whether a click on `entity` at `atMm` is the gesture's. When given and
   * it returns `false` (or the click hits no entity), the click is not the gesture's: it selects as it
   * would with no routing session (a tool in hand still lets the player pick devices). Absent: every
   * entity click is the gesture's (a cable spool).
   */
  readonly claimsClick?: (entity: EntityId, atMm: PositionMm) => boolean;
}

/**
 * A routing pick, for the UI to fold into its {@link RoutingSession}. None of them is a command.
 * - `terminal`: a click (or Enter on the keyboard's terminal) picked `end`. With a first terminal in
 *   the session, `proposal` is the route to it (`proposeRoute` with the session's waypoints), else
 *   `null`.
 * - `waypoint`: a click off any terminal, after the first, put a waypoint here (`snapWaypoint`).
 * - `cancel`: Escape while routing (the UI steps back or ends the gesture).
 * - `entity` (`ends: 'entries'` only): a click on an entity, at `atMm` on its surface; `waypoint` is
 *   what a waypoint click there would add (a duct is an entity), or `null`. The UI decides.
 * - `enter` (`ends: 'entries'` only): Enter, for the UI's keyboard entry.
 */
export type RoutingEvent =
  | {
      readonly kind: 'terminal';
      readonly end: TerminalRef;
      readonly source: 'pointer' | 'keyboard';
      readonly proposal: RouteProposal | null;
    }
  | { readonly kind: 'waypoint'; readonly waypoint: Waypoint }
  | { readonly kind: 'cancel' }
  | {
      readonly kind: 'entity';
      readonly entity: EntityId;
      readonly atMm: PositionMm;
      readonly waypoint: Waypoint | null;
    }
  | { readonly kind: 'enter' };

export type RoutingEventListener = (event: RoutingEvent) => void;

/** The terminal under the cursor (while routing, or with terminal picking on). */
export interface TerminalHoverView {
  /** What a click picks: the nearest visible terminal within `min(16 px, pitch / 2)`, or `null`. */
  readonly hit: TerminalRef | null;
  /** The nearest visible terminal within 16 px, picked or not (too crowded at this zoom), or `null`. */
  readonly near: TerminalRef | null;
  /** `near`'s distance to its nearest visible neighbour in CSS px; `null` when ample (≥ 48 px). */
  readonly pitchPx: number | null;
  /** The device a zoom would frame: `near`'s, else the hovered device with terminals, else `null`. */
  readonly device: EntityId | null;
  /** That device's terminal-group pitch in CSS px; `null` when ample or off screen. */
  readonly groupPitchPx: number | null;
  /** Whether to offer the one-key zoom (`view.focus` on `device`): its group pitch is under 24 px. */
  readonly zoomSuggested: boolean;
}

/** What the routing gesture shows now. */
export interface RoutingView {
  /** The session's first terminal, or `null` before the first pick. */
  readonly from: TerminalRef | null;
  /** The terminal the proposal ends at (the pointer's pick, else the keyboard's terminal), or `null`. */
  readonly target: TerminalRef | null;
  /** The route to `target` (`proposeRoute`): what a pick there would hand the UI. */
  readonly proposal: RouteProposal | null;
  /** Where a click now would put the next waypoint (`snapWaypoint` at the cursor), or `null`. */
  readonly next: Waypoint | null;
}

/** View state published to the UI (HUD, inspector, `when` context keys). */
export interface ViewportState {
  readonly mode: ViewMode;
  readonly pointerLocked: boolean;
  readonly focusId: string | null;
  readonly hovered: SelectableInfo | null;
  readonly selected: SelectableInfo | null;
  readonly placement: PlacementView | null;
  /** The terminal under the cursor while routing (or with terminal picking on), else `null`. */
  readonly terminal: TerminalHoverView | null;
  /** The keyboard's terminal (Tab / Shift+Tab on a device; Enter picks it while routing), or `null`. */
  readonly keyTerminal: TerminalRef | null;
  /** The routing gesture's view, or `null` when not routing. */
  readonly routing: RoutingView | null;
  /** The wire under the cursor (a conductor or cable), or `null`. */
  readonly hoveredWire: WireRef | null;
  /** The selected wire (exclusive with `selected`), or `null`. */
  readonly selectedWire: WireRef | null;
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
      /** The enclosure mount it snapped to (F3.5), or `null` (a fixture). */
      readonly mountedOn: MountedOn | null;
      /**
       * The enclosure entry a conduit connector snapped into (ADR 0015 F3.4 part 2 note 4), or `null`;
       * pass it to `entity.place` as `inEntry`. Always present.
       */
      readonly inEntry: InEntry | null;
    }
  | { readonly kind: 'move'; readonly id: EntityId; readonly positionMm: Vec3Mm }
  | { readonly kind: 'cancelPlacement' };

export type ViewportIntentListener = (intent: ViewportIntent) => void;

/** A press-and-release within this many CSS pixels is a click, not an orbit drag (game-design). */
export const CLICK_SLOP_PX = 4;

/**
 * Occlusion tolerance for terminal picking (game-design): a terminal is visible when the BVH picker's
 * first hit on the ray through it is its own device, nothing, or something no more than this much in
 * front of it (metres). Entry points sit on or just inside a body face.
 */
export const TERMINAL_OCCLUSION_TOLERANCE_M = 0.003;
/**
 * How far in front of a terminal's entry point its own device may first be hit and the terminal still
 * count as visible (game-design, metres). A ray to an entry on a block's top face often grazes the
 * device's own clamp or front face first: measured on the routing panel seen head-on from 1.2 m, up to
 * 11.3 mm before the entry (2.5 mm for the upper row). Bounded at 15 mm, so a terminal on the far side
 * of its own body (about 44 mm through a 4 mm² block) isn't pickable through it.
 */
export const TERMINAL_OWN_DEVICE_TOLERANCE_M = 0.015;
/** A wire beats the device behind it unless the device is this much nearer along the ray (mm). */
const WIRE_OCCLUSION_TOLERANCE_MM = 2;

const sameTerminal = (a: TerminalRef | null, b: TerminalRef | null): boolean =>
  a === b || (a !== null && b !== null && a.entity === b.entity && a.terminal === b.terminal);
const sameWire = (a: WireRef | null, b: WireRef | null): boolean =>
  a === b || (a !== null && b !== null && a.kind === b.kind && a.id === b.id);
const terminalKey = (t: TerminalRef | null): string => (t ? `${t.entity}:${t.terminal}` : '-');
const finiteOrNull = (v: number): number | null => (Number.isFinite(v) ? v : null);

interface Moving {
  readonly id: EntityId;
  /** The snapshot the move started from; a sync that changes it cancels the move. */
  readonly entity: Entity;
  readonly object: Object3D;
  /** Started by dragging (commits on release) rather than by the keyboard (commits on Enter or click). */
  readonly byPointer: boolean;
}

/** Placement in a scene with no world yet (a custom scene in tests): no entities, no mounts. */
const NO_WORLD: PlacementWorld = { entities: [], connections: [], cables: [] };

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
  /** The debug overlays (F2.6: voltage, current) and the netlist inspector's terminal highlight. */
  readonly overlays: SimOverlays;
  /** Routed conductors and cables from the domain bake, and the live preview rope (F3.2 part 2). */
  private readonly wires: WireRenderer;
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
  private readonly catalog: Catalog;
  /** The world last drawn: placement checks against it. */
  private worldValue: PlacementWorld = NO_WORLD;

  private modeValue: ViewMode = 'work';
  private focusIdValue: string | null = null;
  /** The active tool's prop (placement armed), from the tool belt. */
  private armed: CatalogRef | null = null;
  private moving: Moving | null = null;
  /** A press on an entity that becomes a move once it drags past the click slop. */
  private press: { readonly id: EntityId; readonly pointerId: number } | null = null;
  private ghostResult: WorldPlacement | null = null;
  private ghostSource: PlacementView['source'] = 'reticle';

  // Routing and terminal and wire picking (F3.2 part 3): view state only.
  private readonly terminals: TerminalPicker;
  private readonly markers: RoutingMarkers;
  /** The full world last drawn (routing reads connections and ducts); `null` before the first sync. */
  private fullWorld: World | null = null;
  private routingSession: RoutingSession | null = null;
  private terminalPickingOn = false;
  private terminalView: TerminalHoverView | null = null;
  private keyTerminalValue: TerminalRef | null = null;
  private routingView: RoutingView | null = null;
  private proposalCache: {
    world: World;
    session: RoutingSession;
    target: TerminalRef;
    proposal: RouteProposal;
  } | null = null;
  private previewPoints: readonly PositionMm[] = [];
  private hoveredWireValue: WireRef | null = null;
  private selectedWireValue: WireRef | null = null;
  private readonly routingListeners = new Set<RoutingEventListener>();
  /** Per terminal, this hover pass: 0 not asked, 1 visible, −1 hidden. */
  private visibleMemo = new Int8Array(0);
  private readonly raycaster = new Raycaster();
  private readonly rayNdc = new Vector2();
  private readonly rayOriginMm = new Vector3();
  private readonly terminalVisible = (i: number): boolean => {
    const memo = this.visibleMemo[i];
    if (memo !== 0) return memo > 0;
    const visible = this.terminalUnoccluded(i);
    this.visibleMemo[i] = visible ? 1 : -1;
    return visible;
  };

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
    this.catalog = options.catalog ?? BUILTIN_CATALOG;
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
    this.world = new WorldSync(this.scene, new PropRecipes(this.catalog));
    this.disposer.add(() => this.world.dispose());
    this.ghost = new PlacementGhost(this.scene, this.world.recipes);
    this.disposer.add(() => this.ghost.dispose());

    // Wires own their geometry, materials and instance buffers, and leave the scene before it is disposed.
    this.wires = new WireRenderer(this.scene, this.catalog, () => this.invalidate());
    this.disposer.add(() => this.wires.dispose());
    this.terminals = new TerminalPicker(this.catalog);
    // The routing markers own a mesh, its geometry and a material; they leave the scene before it goes.
    this.markers = new RoutingMarkers(this.scene);
    this.disposer.add(() => this.markers.dispose());

    this.highlight = new SelectionHighlight(this.scene);
    this.disposer.add(() => this.highlight.dispose());
    this.overlays = new SimOverlays(this.scene, () => this.invalidate());
    this.overlays.setConductorTint(this.wires); // D15: the overlays recolour conductor instances
    this.disposer.add(() => this.overlays.dispose());
    this.refreshSelectables();
    const offSelection = this.selection.onChange(() => {
      // Selecting an entity deselects a wire (one selection at a time).
      if (this.selection.selected && this.selectedWireValue) this.setSelectedWire(null);
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
      this.routingListeners.clear();
      this.routingSession = null;
      this.fullWorld = null;
      this.proposalCache = null;
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
      terminal: this.terminalView,
      keyTerminal: this.keyTerminalValue,
      routing: this.routingView,
      hoveredWire: this.hoveredWireValue,
      selectedWire: this.selectedWireValue,
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

  /** Routing picks (a terminal, a waypoint, a cancel) while a {@link RoutingSession} is set. */
  onRouting(listener: RoutingEventListener): () => void {
    this.routingListeners.add(listener);
    return () => this.routingListeners.delete(listener);
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
    this.worldValue = world;
    this.fullWorld = world;
    this.wires.sync(world); // before the overlays, whose tint reads the drawn conductors
    if (this.terminals.sync(world) && this.keyTerminalValue && this.terminals.indexOf(this.keyTerminalValue) < 0) {
      this.keyTerminalValue = null;
      this.emit();
    }
    this.dropUndrawnWires();
    this.overlays.syncWorld(world);
    if (this.moving && this.world.entityOf(this.moving.id) !== this.moving.entity) this.endMove();
    if (result.membershipChanged || fixturesChanged) {
      this.refreshSelectables();
      this.refreshSurfaces(); // enclosures are placement surfaces too
    } else if (result.transformsChanged) {
      this.picker.refit();
      this.surfacePicker.refit();
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
   * Lamp sim outputs by entity id (`{ lightOutputRel, status }`, decoded by the host from each lamp's
   * device record). The renderer computes no electrical quantity: it maps `lightOutputRel` through the
   * display curve (`sim/display-curve`) and draws by the validity rule (`sim/lamp-display`): a lamp
   * that is not `solved` is never drawn as an off lamp (`unsolved`, `singular` or missing: unknown;
   * `unsettled`: lit, marked unsettled). Calls {@link invalidate} only when some lamp's drawn level or
   * status changed. The map is kept (not copied) and read again for lamps added later, so a host may
   * reuse one map and mutate it, as long as it calls this after each change.
   */
  setLampOutputs(outputs: LampOutputs): void {
    if (this.world.setLampOutputs(outputs)) this.invalidate();
  }

  /** What lamp entity `id` is drawn as, or `undefined` when no lamp `id` is drawn. */
  lampOf(id: EntityId): DrawnLamp | undefined {
    return this.world.lampOf(id);
  }

  /**
   * Back to the starting view (a new session): work mode, no selection, the initial focus target.
   * View state only, so it is not a Command.
   */
  resetView(): void {
    if (this.moving) this.endMove();
    this.selection.select(null);
    this.keyTerminalValue = null;
    this.setSelectedWire(null);
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
      if (this.overlays.update(dtSeconds)) animating = true; // current arrows while the sim runs
      if (this.wires.update()) animating = true; // the preview rope, until it settles
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

  /**
   * Shows the live preview rope of a wire being routed through `preview.pointsMm`, or hides it
   * (`null`). View state only (F3.2 part 3's gesture drives it): the rope is never committed.
   */
  setWirePreview(preview: WirePreview | null): void {
    this.wires.setPreview(preview);
  }

  /** What the wire renderer draws (scene-graph tests, the e2e hook). */
  wireGraph(): WireGraph {
    return this.wires.describe();
  }

  // --- routing, terminals and wires (F3.2 part 3) ------------------------------------------------

  /**
   * Starts, updates or ends (`null`) the routing gesture. While it is set, hover picks terminals and
   * a click or Enter reports a {@link RoutingEvent} instead of selecting; with a first terminal the
   * preview rope follows the proposal or the cursor. View state only. The UI calls this again with
   * the new session after each event it accepts.
   */
  setRouting(session: RoutingSession | null): void {
    if (session === this.routingSession) return;
    if (session && this.moving) this.endMove();
    this.routingSession = session;
    // A cable's gesture (entries) picks no terminal: a keyboard terminal left by a conductor's gesture
    // (a belt slot switched mid-route) would keep its focus marker, so it goes too.
    if (session?.ends === 'entries' && !this.terminalPickingOn) this.keyTerminalValue = null;
    if (!session) {
      // The keyboard terminal belongs to the gesture: ending it (Escape, another slot, the palette's
      // routing.cancel) drops it and its marker, unless terminal picking stays on for another tool.
      if (!this.terminalPickingOn) this.keyTerminalValue = null;
      this.routingView = null;
      this.setPreviewPoints([], null);
    }
    this.markHoverDirty();
    this.emit();
  }

  /** The routing gesture set by {@link setRouting}, or `null`. */
  get routing(): RoutingSession | null {
    return this.routingSession;
  }

  /**
   * Terminal hover outside routing (a tool that acts on a terminal, F3.3): the hovered terminal is
   * published in {@link ViewportState.terminal} and marked. Routing turns it on by itself.
   */
  setTerminalPicking(on: boolean): void {
    if (on === this.terminalPickingOn) return;
    this.terminalPickingOn = on;
    this.markHoverDirty();
  }

  /** `entity`'s wireable terminals in Tab order (`terminalCycleOrder`: reading order on the device). */
  terminalCycleOrder(entity: EntityId): readonly string[] {
    return this.terminals.cycleOrder(entity);
  }

  /**
   * Tab (`1`) or Shift+Tab (`−1`): the keyboard's terminal moves through the terminals of the device
   * in hand — the selected entity, else the focused one, else the keyboard terminal's own, else the
   * hovered terminal's — wrapping. Returns the new keyboard terminal, or `null` when there is no such
   * device (or it has no wireable terminal). The UI binds the keys.
   */
  cycleTerminal(step: 1 | -1): TerminalRef | null {
    const entity = this.terminalDevice();
    if (entity === null) return null;
    const order = this.terminals.cycleOrder(entity);
    const current = this.keyTerminalValue?.entity === entity ? this.keyTerminalValue.terminal : null;
    const next = cycleTerminal(order, current, step);
    this.setKeyTerminal(next === null ? null : { entity, terminal: next });
    return this.keyTerminalValue;
  }

  /** Sets (or clears) the keyboard's terminal. Returns false for a terminal that isn't wireable. */
  setKeyTerminal(ref: TerminalRef | null): boolean {
    if (ref !== null && this.terminals.indexOf(ref) < 0) return false;
    if (sameTerminal(ref, this.keyTerminalValue)) return true;
    this.keyTerminalValue = ref && { entity: ref.entity, terminal: ref.terminal };
    this.markHoverDirty();
    this.emit();
    return true;
  }

  /**
   * Enter while routing: reports the keyboard's terminal as a `terminal` pick (with the proposal to
   * it). Returns whether a pick was reported.
   */
  pickKeyTerminal(): boolean {
    const end = this.keyTerminalValue;
    if (!this.routingSession || !end) return false;
    this.emitRouting({ kind: 'terminal', end, source: 'keyboard', proposal: this.proposalTo(end) });
    return true;
  }

  /**
   * The terminal pick at canvas CSS px (`x`, `y`) with the current camera, occlusion-filtered (tests,
   * the e2e hook). Doesn't change hover.
   */
  terminalAt(x: number, y: number): TerminalHoverView {
    this.camera.updateMatrixWorld();
    this.projectTerminals();
    return this.terminalViewOf(this.terminals.pick(x, y, this.terminalVisible), null);
  }

  /**
   * `entity`'s terminal-group pitch on screen now, CSS px: the least distance from one of its
   * terminals to any other on-screen terminal. `null` when ample (≥ 48 px) or off screen. Under
   * {@link TERMINAL_TARGET_MIN_PX} the UI offers the zoom (`view.focus` on the device).
   */
  terminalPitchPx(entity: EntityId): number | null {
    this.camera.updateMatrixWorld();
    this.projectTerminals();
    return finiteOrNull(this.terminals.groupPitch(entity));
  }

  /** Where terminal `ref`'s entry point is on the canvas (CSS px), or `null` if it isn't wireable. */
  projectTerminal(ref: TerminalRef): { x: number; y: number } | null {
    const i = this.terminals.indexOf(ref);
    return i < 0 ? null : this.projectMm(this.terminals.pointMm(i));
  }

  /** The wire under NDC (−1…1, +y up) by the wire BVH, or `null`. Doesn't change hover. */
  pickWireAt(ndcX: number, ndcY: number): WireRef | null {
    this.camera.updateMatrixWorld();
    return this.wireAt(ndcX, ndcY)?.wire ?? null;
  }

  /**
   * What the hover rule gives NDC to (tests, the `?e2e=1` hook): the wire when it is nearer than the
   * entity the BVH picker hits (within the occlusion tolerance), else that entity's id, else nothing;
   * the same `pickTarget` a pointer move uses.
   */
  hoverTargetAt(ndcX: number, ndcY: number): { readonly entity: EntityId | null; readonly wire: WireRef | null } {
    this.camera.updateMatrixWorld();
    const target = this.pickTarget(ndcX, ndcY);
    return { entity: target.entity?.entityId ?? null, wire: target.wire };
  }

  /** Selects a drawn wire (clearing the entity selection), or clears it. Returns false for a wire not drawn. */
  selectWire(wire: WireRef | null): boolean {
    if (wire !== null && !this.wires.drawn(wire)) return false;
    if (wire !== null) this.selection.select(null);
    this.setSelectedWire(wire);
    return true;
  }

  /** The routing markers drawn now (tests, the e2e hook). */
  routingMarkers(): readonly RoutingMarker[] {
    return this.markers.shown;
  }

  /** Live routing-marker GPU resources (mesh, geometry, material); 0 when none is shown. */
  get routingResourceCount(): number {
    return this.markers.resourceCount;
  }

  /** Live wire GPU resources (geometry, meshes, materials); 0 when no wire is drawn. */
  get wireResourceCount(): number {
    return this.wires.resourceCount;
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

  /** Which of the four turns a conduit part being placed takes (`turnPlacement`, R); view state. */
  private placementTurn = 0;

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
      reason: r && !r.ok ? r.reason : null,
      mountedOn: r?.ok ? r.mountedOn : null,
      inEntry: r?.ok ? r.inEntry : null,
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

  /**
   * Where the gesture's prop or device would go now: the surface under the cursor (a fixture or a
   * drawn enclosure) turned into integer mm, then `placeInWorld` (pure maths in `@controls/world-model`,
   * the same scripts call) against the world last drawn.
   */
  private placementNow(ref: CatalogRef): WorldPlacement {
    const c = this.cursorNdc();
    this.ghostSource = c.source;
    this.camera.updateMatrixWorld();
    const hit = this.surfacePicker.pick(c.x, c.y, this.camera);
    if (!hit) return { ok: false, reason: 'no-target', targetId: null };
    const cursor = { x: metresToMm(hit.point.x), y: metresToMm(hit.point.y), z: metresToMm(hit.point.z) };
    return placeInWorld(this.worldValue, ref, cursor, this.snapTargets, {
      catalog: this.catalog,
      moving: this.moving?.id ?? null,
      turn: this.placementTurn,
    });
  }

  private updateGhost(): void {
    const ref = this.gestureRef();
    if (!ref) return;
    const before = this.placementView();
    const r = this.placementNow(ref);
    this.ghostResult = r;
    if (r.ok) this.ghost.show(ref, r.positionMm, r.orientationMdeg, this.moving?.entity.state ?? null);
    else this.ghost.hide();
    const after = this.placementView();
    if (
      before?.valid !== after?.valid ||
      before?.reason !== after?.reason ||
      before?.targetId !== after?.targetId ||
      before?.source !== after?.source
    ) {
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
      this.emitIntent({
        kind: 'place',
        ref,
        positionMm: r.positionMm,
        orientationMdeg: r.orientationMdeg,
        mountedOn: r.mountedOn,
        inEntry: r.inEntry,
      });
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

  /**
   * Rebuilds the snap targets and the placement picker from the fixtures (and any scene selectables)
   * and the drawn enclosures, whose mounts are targets too (`placeInWorld` finds them in the world).
   */
  private refreshSurfaces(): void {
    const sceneTargets = this.sceneSelectables.flatMap((f) => (f.info.snapTarget ? [f.info.snapTarget] : []));
    this.snapTargets = [...sceneTargets, ...worldSnapTargets(this.fixtures.worldFixtures())];
    // Snap surfaces and what hides them (a hit on the backboard, or on a box's side, is on no target).
    // `world` is undefined while the constructor builds the first surfaces.
    this.surfacePicker.setRoots([
      ...this.sceneSelectables.filter((f) => f.info.snapTarget).map((f) => f.root),
      ...this.fixtures.surfaceRoots(),
      ...((this.world as WorldSync | undefined)?.surfaceRoots() ?? []),
    ]);
  }

  /** Frames the initial focus target (see `initialFocus`), if any; walk mode keeps it for later. */
  private focusInitial(): void {
    const all = this.selection.all;
    const id =
      this.initialFocus ??
      (all.find((s) => s.kind === 'backplate') ?? all.find((s) => s.focusNormal && s.entityId === undefined))?.id;
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
    const info = this.selection.get(id);
    // A device is framed from its current orientation (it may have turned since it was drawn).
    const entity = info?.entityId === undefined ? undefined : this.world.entityOf(info.entityId);
    const frame = entity ? deviceFocusFrame(entity.transform.orientationMdeg, BENCH_FOCUS_ELEVATION_DEG) : null;
    const normal = frame?.normal ?? info?.focusNormal;
    if (!root || !normal) return;
    this.tmpBox.setFromObject(root).getBoundingSphere(this.tmpSphere);
    const c = this.tmpSphere.center;
    const elevation = ((frame ? frame.elevationDeg : (info?.focusElevationDeg ?? 0)) * Math.PI) / 180;
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

  /** Where hover looks: the screen centre in locked walk mode, the pointer over the canvas, or nowhere. */
  private hoverNdc(): { x: number; y: number } | null {
    if (this.modeValue === 'walk' && this.look.isLocked) return { x: 0, y: 0 };
    return this.pointer.inside ? { x: this.pointer.ndcX, y: this.pointer.ndcY } : null;
  }

  private updateHover(): void {
    this.camera.updateMatrixWorld();
    const c = this.hoverNdc();
    const target = c ? this.pickTarget(c.x, c.y) : null;
    this.selection.hover(target?.entity?.id ?? null);
    this.setHoveredWire(target?.wire ?? null);
    const before = `${this.terminalViewKey()}|${this.routingViewKey()}`;
    if (this.terminalRouting() || this.terminalPickingOn) {
      this.projectTerminals();
      const pick = c ? this.terminals.pick(...this.ndcToPx(c.x, c.y), this.terminalVisible) : null;
      this.terminalView = this.terminalViewOf(pick, this.selection.hovered?.entityId ?? null);
    } else {
      this.terminalView = null;
    }
    if (this.routingSession) this.updateRoutingView(c);
    else this.routingView = null;
    this.updateMarkers();
    if (`${this.terminalViewKey()}|${this.routingViewKey()}` !== before) this.emit();
  }

  /**
   * What a click at NDC would land on: a wire (the wire BVH) when it is nearer than the entity the
   * BVH picker hits (within a tolerance), else that entity. While routing or placing, wires aren't
   * picked (the gesture owns the click).
   */
  private pickTarget(ndcX: number, ndcY: number): { entity: SelectableInfo | null; wire: WireRef | null } {
    const hit: PickHit | null = this.picker.pick(ndcX, ndcY, this.camera);
    const entity = hit?.info ?? null;
    const distanceMm = hit ? hit.distance * 1000 : Infinity;
    const gesture = this.routingSession !== null || this.gestureRef() !== null;
    const wire = gesture ? null : this.wireAt(ndcX, ndcY);
    if (wire && wire.depthMm <= distanceMm + WIRE_OCCLUSION_TOLERANCE_MM) return { entity: null, wire: wire.wire };
    return { entity, wire: null };
  }

  /** The wire BVH's answer along the camera ray through NDC (camera matrices already current). */
  private wireAt(ndcX: number, ndcY: number): WirePick | null {
    this.rayNdc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.rayNdc, this.camera);
    const ray = this.raycaster.ray;
    const o = this.rayOriginMm.copy(ray.origin).multiplyScalar(1000);
    const pxAngle = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / (this.element.clientHeight || 1);
    return this.wires.pick(o, ray.direction, pxAngle);
  }

  /** NDC → canvas CSS px from the top left. */
  private ndcToPx(x: number, y: number): [number, number] {
    const w = this.element.clientWidth || 1;
    const h = this.element.clientHeight || 1;
    return [((x + 1) / 2) * w, ((1 - y) / 2) * h];
  }

  /** Projects every terminal with the current camera and clears the occlusion memo. */
  private projectTerminals(): void {
    this.terminals.project(this.camera, this.element.clientWidth || 1, this.element.clientHeight || 1);
    const n = this.terminals.count;
    if (this.visibleMemo.length < n) this.visibleMemo = new Int8Array(Math.max(n, 2 * this.visibleMemo.length));
    else this.visibleMemo.fill(0, 0, n);
  }

  /**
   * Occlusion (ADR 0017 §9): the BVH picker's first hit on the ray through terminal `i` must be its
   * own device no more than {@link TERMINAL_OWN_DEVICE_TOLERANCE_M} in front of it, nothing, or
   * anything else no more than {@link TERMINAL_OCCLUSION_TOLERANCE_M} in front of it.
   */
  private terminalUnoccluded(i: number): boolean {
    const s = this.terminals.screen;
    const w = this.element.clientWidth || 1;
    const h = this.element.clientHeight || 1;
    const hit = this.picker.pick((s.x(i) / w) * 2 - 1, 1 - (s.y(i) / h) * 2, this.camera);
    if (!hit) return true;
    const own = hit.info.entityId === this.terminals.ref(i).entity;
    const tolerance = own ? TERMINAL_OWN_DEVICE_TOLERANCE_M : TERMINAL_OCCLUSION_TOLERANCE_M;
    return hit.distance >= this.terminals.depthM(i, this.camera.position) - tolerance;
  }

  private terminalViewOf(pick: ScreenTerminalPick | null, hoveredEntity: EntityId | null): TerminalHoverView {
    const hit = pick && pick.hit >= 0 ? this.terminals.ref(pick.hit) : null;
    const near = pick && pick.near >= 0 ? this.terminals.ref(pick.near) : null;
    const device = near?.entity ?? (hoveredEntity !== null && this.terminals.has(hoveredEntity) ? hoveredEntity : null);
    const groupPitch = device === null ? Infinity : this.terminals.groupPitch(device);
    return {
      hit,
      near,
      pitchPx: near && pick ? finiteOrNull(pick.pitchPx) : null,
      device,
      groupPitchPx: finiteOrNull(groupPitch),
      // Not for the device already framed: zooming again wouldn't help (a tiny canvas, a dense device).
      zoomSuggested:
        groupPitch < TERMINAL_TARGET_MIN_PX && device !== null && this.focusIdValue !== entitySelectableId(device),
    };
  }

  /** The device Tab cycles: selected, else focused, else the keyboard terminal's, else the hovered terminal's. */
  private terminalDevice(): EntityId | null {
    const candidates = [
      this.selection.selected?.entityId,
      this.focusIdValue === null ? undefined : this.selection.get(this.focusIdValue)?.entityId,
      this.keyTerminalValue?.entity,
      this.terminalView?.near?.entity,
    ];
    for (const id of candidates) if (id !== undefined && this.terminals.has(id)) return id;
    return null;
  }

  /** Whether a routing session picks terminals (a conductor's route; not a cable's entries). */
  private terminalRouting(): boolean {
    return this.routingSession !== null && this.routingSession.ends !== 'entries';
  }

  /** The proposal for a route from the session's first terminal to `target` (cached), or `null`. */
  private proposalTo(target: TerminalRef): RouteProposal | null {
    const session = this.routingSession;
    const world = this.fullWorld;
    if (!session?.from || !world) return null;
    if (session.from.entity === target.entity && session.from.terminal === target.terminal) return null;
    const cache = this.proposalCache;
    if (cache && cache.world === world && cache.session === session && sameTerminal(cache.target, target)) {
      return cache.proposal;
    }
    const b: RouteTerminal = {
      entity: target.entity,
      terminal: target.terminal,
      termination: session.termination ?? 'auto',
    };
    const proposal = proposeRoute(world, this.catalog, session.from, b, session.waypoints, { auto: session.auto });
    this.proposalCache = { world, session, target, proposal };
    return proposal;
  }

  /** The routing view and preview rope for the cursor at `c` (NDC) or none. */
  private updateRoutingView(c: { x: number; y: number } | null): void {
    const session = this.routingSession;
    const world = this.fullWorld;
    if (!session || !world) return;
    const from = session.from && terminalPlace(world, this.catalog, session.from);
    const startMm = session.from === null ? (session.startMm ?? null) : null;
    if (startMm !== null) {
      // A route from a point (a cable's first entry): waypoints and the rope to the cursor only.
      const waypoints = session.waypoints.map((w) => w.positionMm);
      const next = c ? this.waypointAt(c.x, c.y, session) : null;
      this.routingView = { from: null, target: null, proposal: null, next };
      this.setPreviewPoints([startMm, ...waypoints, ...(next ? [next.positionMm] : [])], session);
      return;
    }
    if (!session.from || !from || !from.ok) {
      const ref = session.from && { entity: session.from.entity, terminal: session.from.terminal };
      this.routingView = { from: ref, target: null, proposal: null, next: null };
      this.setPreviewPoints([], session);
      return;
    }
    const fromRef = { entity: session.from.entity, terminal: session.from.terminal };
    // The pointer's pick, else the keyboard's terminal; never the first terminal itself.
    const other = (t: TerminalRef | null | undefined): TerminalRef | null =>
      t && !sameTerminal(t, fromRef) ? t : null;
    const target = other(this.terminalView?.hit) ?? other(this.keyTerminalValue);
    const waypoints = session.waypoints.map((w) => w.positionMm);
    if (target) {
      const proposal = this.proposalTo(target);
      const end = terminalPlace(world, this.catalog, {
        ...target,
        termination: session.termination ?? 'auto',
      });
      const points = proposal?.ok ? proposal.points : [from.point, ...waypoints, ...(end.ok ? [end.point] : [])];
      this.routingView = { from: fromRef, target, proposal, next: null };
      this.setPreviewPoints(points, session);
      return;
    }
    const next = c ? this.waypointAt(c.x, c.y, session) : null;
    this.routingView = { from: fromRef, target: null, proposal: null, next };
    this.setPreviewPoints([from.point, ...waypoints, ...(next ? [next.positionMm] : [])], session);
  }

  /** The waypoint a click at NDC would add: the surface under it snapped by `snapWaypoint`, or `null`. */
  private waypointAt(ndcX: number, ndcY: number, session: RoutingSession): Waypoint | null {
    const world = this.fullWorld;
    if (!world) return null;
    const hit = this.surfacePicker.pick(ndcX, ndcY, this.camera);
    if (!hit) return null;
    const cursor = { x: metresToMm(hit.point.x), y: metresToMm(hit.point.y), z: metresToMm(hit.point.z) };
    return snapWaypoint(world, this.catalog, cursor, session.snap);
  }

  /** Re-pins the preview rope when its points changed (fewer than two: hidden). */
  private setPreviewPoints(points: readonly PositionMm[], session: RoutingSession | null): void {
    const same =
      points.length === this.previewPoints.length &&
      points.every(
        (p, i) => p.x === this.previewPoints[i].x && p.y === this.previewPoints[i].y && p.z === this.previewPoints[i].z,
      );
    if (same) return;
    this.previewPoints = points;
    this.wires.setPreview(
      points.length >= 2 && session ? { pointsMm: points, ref: session.ref, colour: session.colour } : null,
    );
  }

  /** The routing and terminal markers for what hover and the session show now. */
  private updateMarkers(): void {
    const list: RoutingMarker[] = [];
    const session = this.routingSession;
    const world = this.fullWorld;
    if (session && world) {
      const from = session.from && terminalPlace(world, this.catalog, session.from);
      if (from && from.ok) list.push({ kind: 'from', atMm: from.point });
      else if (session.from === null && session.startMm) list.push({ kind: 'from', atMm: session.startMm });
      for (const w of session.waypoints) list.push({ kind: 'waypoint', atMm: w.positionMm });
      const next = this.routingView?.next;
      if (next) list.push({ kind: 'next', atMm: next.positionMm });
    }
    if (session?.keyPointMm) list.push({ kind: 'focus', atMm: session.keyPointMm });
    if (this.terminalRouting() || this.terminalPickingOn) {
      const view = this.terminalView;
      const shown = view?.hit ?? view?.near ?? null;
      const i = shown ? this.terminals.indexOf(shown) : -1;
      if (i >= 0) list.push({ kind: view?.hit ? 'pick' : 'near', atMm: this.terminals.pointMm(i) });
    }
    const key = this.keyTerminalValue ? this.terminals.indexOf(this.keyTerminalValue) : -1;
    if (key >= 0) list.push({ kind: 'focus', atMm: this.terminals.pointMm(key) });
    this.markers.set(list, this.camera, this.element.clientHeight || 1);
  }

  private setHoveredWire(wire: WireRef | null): void {
    if (sameWire(wire, this.hoveredWireValue)) return;
    this.hoveredWireValue = wire;
    this.wires.setHighlight(this.hoveredWireValue, this.selectedWireValue);
    this.emit();
  }

  private setSelectedWire(wire: WireRef | null): void {
    if (sameWire(wire, this.selectedWireValue)) return;
    this.selectedWireValue = wire;
    this.wires.setHighlight(this.hoveredWireValue, this.selectedWireValue);
    this.emit();
  }

  /** After a sync: forget hovered or selected wires that are no longer drawn. */
  private dropUndrawnWires(): void {
    if (this.hoveredWireValue && !this.wires.drawn(this.hoveredWireValue)) this.setHoveredWire(null);
    if (this.selectedWireValue && !this.wires.drawn(this.selectedWireValue)) this.setSelectedWire(null);
  }

  private emitRouting(event: RoutingEvent): void {
    [...this.routingListeners].forEach((l) => l(event));
  }

  private terminalViewKey(): string {
    const v = this.terminalView;
    if (!v) return '-';
    return `${terminalKey(v.hit)} ${terminalKey(v.near)} ${v.pitchPx} ${v.device} ${v.groupPitchPx} ${v.zoomSuggested}`;
  }

  private routingViewKey(): string {
    const v = this.routingView;
    if (!v) return '-';
    const next = v.next ? `${v.next.kind} ${v.next.positionMm.x},${v.next.positionMm.y},${v.next.positionMm.z}` : '-';
    const proposal = v.proposal ? (v.proposal.ok ? `ok ${v.proposal.lengthMm}` : v.proposal.code) : '-';
    return `${terminalKey(v.from)} ${terminalKey(v.target)} ${proposal} ${next}`;
  }

  /**
   * A click while routing: a terminal pick, else (after the first terminal) a waypoint, else nothing.
   * `false` when the click isn't the gesture's (`claimsClick` said no): the caller selects instead.
   */
  private routingClick(): boolean {
    this.updateHover(); // the pointer moved to the click: answer for where it is now
    this.hoverDirty = false;
    const session = this.routingSession;
    const hit = this.terminalView?.hit ?? null;
    if (!session) return true;
    if (session.ends === 'entries') {
      const c = this.hoverNdc();
      const body = c ? this.picker.pick(c.x, c.y, this.camera) : null;
      const next = this.routingView?.next ?? null;
      const entity = body?.info.entityId;
      if (body && entity !== undefined && entity !== null) {
        const p = body.point;
        const atMm = { x: metresToMm(p.x), y: metresToMm(p.y), z: metresToMm(p.z) };
        if (session.claimsClick && !session.claimsClick(entity, atMm)) return false;
        this.emitRouting({ kind: 'entity', entity, atMm, waypoint: next });
        return true;
      }
      if (session.claimsClick) return false;
      if (session.startMm && next) this.emitRouting({ kind: 'waypoint', waypoint: next });
      return true;
    }
    if (hit) {
      this.emitRouting({ kind: 'terminal', end: hit, source: 'pointer', proposal: this.proposalTo(hit) });
      return true;
    }
    const next = this.routingView?.next ?? null;
    if (session.from && next) this.emitRouting({ kind: 'waypoint', waypoint: next });
    return true;
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
        if (this.routingSession) {
          this.keyTerminalValue = null;
          this.markHoverDirty();
          this.emitRouting({ kind: 'cancel' });
          return true;
        }
        if (this.armed) {
          this.setPlacement(null);
          this.emitIntent({ kind: 'cancelPlacement' });
          return true;
        }
        if (this.selectedWireValue) {
          this.setSelectedWire(null);
          return true;
        }
        if (!this.selection.selected) return false;
        this.select(null);
        return true;
      case 'commitPlacement':
        if (this.routingSession?.ends === 'entries') {
          this.emitRouting({ kind: 'enter' });
          return true;
        }
        if (this.routingSession) return this.pickKeyTerminal();
        return this.commit();
      case 'moveSelection': {
        const id = this.selection.selected?.entityId;
        if (this.armed || this.moving || id === undefined) return false;
        return this.startMove(id, false);
      }
      case 'turnPlacement':
        // Only while placing: the next of the four turns a conduit part snapped to an end can take.
        if (!this.armed || this.moving) return false;
        this.placementTurn = (this.placementTurn + 1) % 4;
        this.markHoverDirty();
        return true;
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
        if (this.modeValue !== 'work' || this.armed || this.moving || this.routingSession) return;
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
        // A terminal or a waypoint for the UI's routing gesture; a click it doesn't claim selects.
        if (this.routingSession && this.routingClick()) return;
        if (this.gestureRef()) {
          this.commit(); // a click places the active prop (or drops a keyboard move)
          return;
        }
        const locked = this.modeValue === 'walk';
        this.camera.updateMatrixWorld();
        const target = locked ? this.pickTarget(0, 0) : this.pickTarget(this.pointer.ndcX, this.pointer.ndcY);
        if (target.wire) {
          this.selectWire(target.wire);
          return;
        }
        this.selection.select(target.entity?.id ?? null);
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
