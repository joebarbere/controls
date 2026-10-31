/**
 * The debug overlays (plan F2.6): voltage and current drawn on the leads and terminals from the sim
 * snapshot, plus the netlist inspector's terminal highlight. Renderer-local view state: the world is
 * only read, and the overlays are switched by the `view.overlay` view command, which the workspace
 * applies through {@link SimOverlays.setOverlay}.
 *
 * **What is drawn.** Leads aren't drawn by the scene yet (wire routing is P3), so the overlays draw
 * their own: each world connection between two catalogue terminals is a straight segment in two
 * halves (one per end, so a voltage drop along the lead shows), each terminal a marker. Everything is
 * instanced (one draw per mesh, whatever the plant size), unpickable (a no-op `raycast`, never among
 * the picker's roots) and outside the scene until an overlay or a highlight is on, so turning the
 * overlays off returns the scene to exactly what it was.
 *
 * **Reading.** {@link SimOverlays.attach} subscribes to a {@link SnapshotFeed} (`SimHost` in the game).
 * Each snapshot is read with `NetlistReadout` (once-per-descriptor lookups, an allocation-free read)
 * into display steps (`sim/overlay-steps`, hysteresis included); only changed steps rewrite instance
 * colours and matrices, and only then is a frame requested. The renderer computes no electrical
 * quantity (ADR 0011 §9.2).
 *
 * **Current animation** runs only while the feed is running, the current overlay is on, reduced
 * motion is off and some lead's current bin is above 0; {@link SimOverlays.update} then returns `true`.
 * DC arrows travel in the current's direction; AC markers sway in place (magnitude only).
 */
import {
  ConeGeometry,
  CylinderGeometry,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  OctahedronGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
  Color,
  type BufferGeometry,
  type Material,
  type Scene,
} from 'three/webgpu';
import { BUILTIN_CATALOG, type Catalog } from '@controls/catalog';
import { NOMINAL_BANDS, NetlistReadout, type NetlistReading, type SnapshotView } from '@controls/sim-protocol';
import { mdegToRadians, metresToMm, mm } from '@controls/units';
import type { World } from '@controls/world-model';
import {
  arrowCount,
  arrowFraction,
  arrowSpeedMmPerS,
  OVER_RANGE_BIN,
  scalesByBand,
  STEP_NO_SCALE,
  STEP_UNKNOWN,
  stepColour,
  swayOffsetMm,
  HIGHLIGHT_COLOUR,
  type VoltageScale,
} from '../sim/overlay-scale';
import {
  createOverlaySteps,
  joinOverlayItems,
  resetOverlaySteps,
  updateOverlaySteps,
  type OverlayItems,
  type OverlayJoin,
  type OverlaySteps,
} from '../sim/overlay-steps';

/** The overlays `view.overlay` switches. */
export type OverlayName = 'voltage' | 'current';

/**
 * Where the renderer gets snapshots (ADR 0011 §9.2's `SnapshotSource`; `SimHost` implements it):
 * the listener is called after every new snapshot, with `null` on a source reset.
 */
export interface SnapshotFeed {
  subscribe(listener: (view: SnapshotView | null) => void): () => void;
  /** Whether sim time is advancing: current animates only then. */
  readonly running: boolean;
}

/** A terminal, as the netlist inspector names it (world v2 `TerminalRef`). */
export interface OverlayTerminalRef {
  readonly entity: number;
  readonly terminal: string;
}

/** What the legend needs to show: which overlays are on, and which scales and styles are in view. */
export interface OverlayLegendState {
  readonly voltage: boolean;
  readonly current: boolean;
  /** `NOMINAL_BANDS` names of the voltage scales in use (solved islands with a scale), in band order. */
  readonly bands: readonly string[];
  /** Some drawn item is in a solved island with no voltage scale (band 0, `none`). */
  readonly noScale: boolean;
  /** Some drawn item has no reading (an island that isn't solved, or no snapshot yet). */
  readonly unknown: boolean;
}

/** JSON-plain summary of what the overlays draw, for scene-graph snapshot tests and the e2e hook. */
export interface OverlayGraph {
  readonly voltage: boolean;
  readonly current: boolean;
  readonly reducedMotion: boolean;
  /** Whether the overlay group is in the scene. */
  readonly inScene: boolean;
  readonly terminals: readonly {
    readonly entity: number;
    readonly terminal: string;
    readonly positionMm: readonly [number, number, number];
    /** A voltage bin (0–32), `noScale` or `unknown`. */
    readonly volts: number | 'noScale' | 'unknown';
    readonly highlighted: boolean;
  }[];
  readonly leads: readonly {
    readonly connection: number;
    readonly volts: readonly [number | 'noScale' | 'unknown', number | 'noScale' | 'unknown'];
    /** A current bin (0–32) or `unknown`. */
    readonly amps: number | 'unknown';
    /** `a→b`, `b→a`, or `none` (AC: magnitude only; no current; unknown). */
    readonly direction: 'a→b' | 'b→a' | 'none';
    /** Arrow slots drawn on this lead (0 when the current overlay is off or nothing flows). */
    readonly arrows: number;
  }[];
}

// Game-design sizes (mm): a marker must read at bench distance and never hide the device.
const LEAD_RADIUS_MM = 2.5;
const UNKNOWN_LEAD_RADIUS_MM = 1.2;
const TERMINAL_RADIUS_MM = 6;
const UNKNOWN_TERMINAL_RADIUS_MM = 7;
const HIGHLIGHT_RADIUS_MM = 11;
const ARROW_LENGTH_MM = 14;
const ARROW_RADIUS_MM = 5;
/** AC sway: cycles per second at bin 1, rising to 2 at over range (game-design). */
const SWAY_HZ_MIN = 0.5;
const SWAY_HZ_MAX = 2;

const stepName = (step: number): number | 'noScale' | 'unknown' =>
  step === STEP_UNKNOWN ? 'unknown' : step === STEP_NO_SCALE ? 'noScale' : step;

const UP = new Vector3(0, 1, 0);

interface DrawnLead {
  readonly connection: number;
  readonly a: OverlayTerminalRef;
  readonly b: OverlayTerminalRef;
  /** Scene metres. */
  readonly start: Vector3;
  readonly end: Vector3;
  readonly lengthMm: number;
  /** First arrow slot, and how many. */
  readonly arrowStart: number;
  readonly arrowCount: number;
  /** Arrow orientation from `a` to `b`, and back. */
  readonly forward: Quaternion;
  readonly backward: Quaternion;
}

/** One instanced mesh that grows by doubling (a full re-upload, never `addUpdateRange`). */
class InstancedLayer {
  mesh: InstancedMesh;

  constructor(
    private readonly name: string,
    private readonly geometry: BufferGeometry,
    private readonly material: Material,
    private readonly parent: Group,
  ) {
    this.mesh = this.create(1);
    this.mesh.count = 0;
  }

  /** Makes room for `count` instances (rebuilding the mesh, doubled, if it has too few). */
  ensure(count: number): void {
    const capacity = this.mesh.instanceMatrix.count;
    if (count > capacity) {
      let next = capacity;
      while (next < count) next *= 2;
      const old = this.mesh;
      this.mesh = this.create(next);
      this.mesh.visible = old.visible;
      this.parent.remove(old);
      old.dispose();
    }
    this.mesh.count = count;
  }

  dispose(): void {
    this.parent.remove(this.mesh);
    this.mesh.dispose();
  }

  private create(capacity: number): InstancedMesh {
    const mesh = new InstancedMesh(this.geometry, this.material, capacity);
    mesh.name = this.name;
    mesh.frustumCulled = false; // instances span the room; the base geometry's bounds don't
    mesh.raycast = () => undefined; // never pickable (rendering caveats: overlays)
    const white = new Color(1, 1, 1);
    for (let i = 0; i < capacity; i++) mesh.setColorAt(i, white); // the attribute exists before the first draw
    this.parent.add(mesh);
    return mesh;
  }
}

export class SimOverlays {
  /** Parent of every overlay mesh; in the scene only while an overlay or a highlight is shown. */
  readonly group = new Group();
  private readonly geometries: BufferGeometry[];
  private readonly materials: Material[];
  private readonly leads: InstancedLayer;
  private readonly terminalsKnown: InstancedLayer;
  private readonly terminalsUnknown: InstancedLayer;
  private readonly arrowsDc: InstancedLayer;
  private readonly arrowsAc: InstancedLayer;
  private readonly highlight: InstancedLayer;

  private voltageOn = false;
  private currentOn = false;
  private reducedMotionValue = false;
  private inScene = false;
  private feed: SnapshotFeed | null = null;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  // World side (rebuilt on a world change).
  private entities: World['entities'] | null = null;
  private connections: World['connections'] | null = null;
  private terminals: { ref: OverlayTerminalRef; position: Vector3 }[] = [];
  private drawnLeads: DrawnLead[] = [];
  private items: OverlayItems = { terminals: [], leads: [] };
  private arrowSlots = 0;
  private highlighted: Uint8Array = new Uint8Array(0);
  private highlightRefs: readonly OverlayTerminalRef[] = [];

  // Sim side (rebuilt per descriptor).
  private readout: NetlistReadout | null = null;
  private reading: NetlistReading | null = null;
  private join: OverlayJoin = joinOverlayItems(this.items, null);
  private steps: OverlaySteps = createOverlaySteps(0, 0);
  private readonly scales: readonly (VoltageScale | null)[];
  /** The step update's inputs, kept in one object so a snapshot allocates nothing. */
  private readonly stepInputs: {
    readout: NetlistReadout | null;
    reading: NetlistReading | null;
    join: OverlayJoin;
    scales: readonly (VoltageScale | null)[];
  };
  private readonly bandsUsed = new Uint8Array(256);
  private legend: OverlayLegendState = { voltage: false, current: false, bands: [], noScale: false, unknown: false };
  private readonly legendListeners = new Set<(state: OverlayLegendState) => void>();

  // Animation (per lead) and per-frame scratch: update() allocates nothing.
  private phases = new Float64Array(0);
  /** Per lead: its first slot in the packed DC or AC arrow layer, or −1 (no arrows of that kind). */
  private dcSlot = new Int32Array(0);
  private acSlot = new Int32Array(0);
  private animatedPose = false;
  private readonly m = new Matrix4();
  private readonly v = new Vector3();
  private readonly s = new Vector3();
  private readonly q = new Quaternion();
  private readonly colour = new Color();
  private readonly scale = new Vector3();

  constructor(
    private readonly scene: Scene,
    private readonly onInvalidate: () => void,
    private readonly catalog: Catalog = BUILTIN_CATALOG,
    bands: readonly string[] = NOMINAL_BANDS,
  ) {
    this.group.name = 'overlay:sim';
    this.scales = scalesByBand(bands);
    this.stepInputs = { readout: null, reading: null, join: this.join, scales: this.scales };
    const lead = new CylinderGeometry(1, 1, 1, 6, 1); // unit, along +y; scaled per instance (6 sides: a 2.5 mm lead)
    const sphere = new SphereGeometry(1, 8, 6); // a 6 mm marker needs no more
    const diamond = new OctahedronGeometry(1);
    const cone = new ConeGeometry(1, 1, 6); // apex along +y
    const sway = new OctahedronGeometry(1);
    const ring = new SphereGeometry(1, 10, 6);
    this.geometries = [lead, sphere, diamond, cone, sway, ring];
    const solid = () => new MeshBasicMaterial({ color: 0xffffff });
    const highlightMaterial = new MeshBasicMaterial({
      color: 0xffffff,
      wireframe: true,
      transparent: true,
      opacity: 0.9,
    });
    const materials = [solid(), solid(), solid(), solid(), solid(), highlightMaterial];
    this.materials = materials;
    this.leads = new InstancedLayer('overlay:sim-leads', lead, materials[0], this.group);
    this.terminalsKnown = new InstancedLayer('overlay:sim-terminals', sphere, materials[1], this.group);
    this.terminalsUnknown = new InstancedLayer('overlay:sim-terminals-unknown', diamond, materials[2], this.group);
    this.arrowsDc = new InstancedLayer('overlay:sim-arrows-dc', cone, materials[3], this.group);
    this.arrowsAc = new InstancedLayer('overlay:sim-arrows-ac', sway, materials[4], this.group);
    this.highlight = new InstancedLayer('overlay:sim-highlight', ring, materials[5], this.group);
    this.applyVisibility();
  }

  get voltage(): boolean {
    return this.voltageOn;
  }

  get current(): boolean {
    return this.currentOn;
  }

  get reducedMotion(): boolean {
    return this.reducedMotionValue;
  }

  /** The legend's state now. */
  get legendState(): OverlayLegendState {
    return this.legend;
  }

  /** Called when the legend's state changes (overlays switched, scales or styles in view). */
  onLegendChange(listener: (state: OverlayLegendState) => void): () => void {
    this.legendListeners.add(listener);
    return () => this.legendListeners.delete(listener);
  }

  /** Subscribes to `feed` (or detaches with `null`). The previous subscription is dropped and the readings reset. */
  attach(feed: SnapshotFeed | null): void {
    if (this.disposed || feed === this.feed) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.feed = feed;
    this.onSnapshot(null);
    if (feed) this.unsubscribe = feed.subscribe((view) => this.onSnapshot(view));
  }

  /** Switches an overlay. Returns whether anything changed. View state only. */
  setOverlay(name: OverlayName, on: boolean): boolean {
    if ((name === 'voltage' ? this.voltageOn : this.currentOn) === on) return false;
    if (name === 'voltage') this.voltageOn = on;
    else this.currentOn = on;
    this.refreshSteps(true);
    this.applyVisibility();
    this.publishLegend();
    this.onInvalidate();
    return true;
  }

  /** `prefers-reduced-motion`: current arrows stand still (evenly spaced) instead of moving. */
  setReducedMotion(on: boolean): void {
    if (this.reducedMotionValue === on) return;
    this.reducedMotionValue = on;
    this.restPose();
    this.onInvalidate();
  }

  /**
   * Highlights terminals in 3D (the netlist inspector's selected node; view state only), whatever the
   * overlays show. `[]` or `null` clears it. Returns how many drawn terminals are highlighted (a
   * terminal the world doesn't draw, such as one of an unknown device, is skipped).
   */
  highlightTerminals(terminals: readonly OverlayTerminalRef[] | null): number {
    this.highlightRefs = terminals === null ? [] : terminals.map((t) => ({ entity: t.entity, terminal: t.terminal }));
    const count = this.applyHighlight();
    this.applyVisibility();
    this.onInvalidate();
    return count;
  }

  /** Re-reads the world's devices and leads when they changed (by identity). Never mutates `world`. */
  syncWorld(world: World): void {
    if (world.entities === this.entities && world.connections === this.connections) return;
    this.entities = world.entities;
    this.connections = world.connections;
    this.rebuildItems(world);
    this.join = joinOverlayItems(this.items, this.readout);
    this.steps = createOverlaySteps(this.terminals.length, this.drawnLeads.length);
    this.phases = new Float64Array(this.drawnLeads.length);
    this.writeStaticMatrices();
    this.applyHighlight();
    this.refreshSteps(true);
    this.applyVisibility();
    this.publishLegend();
    this.onInvalidate();
  }

  /**
   * Per-frame animation, run by the controller before each draw. Allocation-free. Returns `true`
   * while current arrows are moving (the sim runs, the current overlay is on, reduced motion is off
   * and some lead carries a current bin above 0).
   */
  update(dtSeconds: number): boolean {
    if (!this.animating()) {
      if (this.animatedPose) this.restPose();
      return false;
    }
    const leads = this.drawnLeads;
    for (let j = 0; j < leads.length; j++) {
      const bin = this.steps.leadAmps[j];
      if (bin === 0 || bin > OVER_RANGE_BIN) continue;
      if (this.steps.leadDirection[j] !== 0) {
        this.phases[j] = (this.phases[j] + dtSeconds * arrowSpeedMmPerS(bin)) % leads[j].lengthMm;
      } else {
        const hz = SWAY_HZ_MIN + ((SWAY_HZ_MAX - SWAY_HZ_MIN) * (bin - 1)) / (OVER_RANGE_BIN - 1);
        this.phases[j] = (this.phases[j] + dtSeconds * hz) % 1;
      }
      this.writeArrows(j);
    }
    this.arrowsDc.mesh.instanceMatrix.needsUpdate = true;
    this.arrowsAc.mesh.instanceMatrix.needsUpdate = true;
    this.animatedPose = true;
    return true;
  }

  /** JSON-plain summary of what is drawn (scene-graph snapshot tests, the e2e hook). */
  describe(): OverlayGraph {
    const s = this.steps;
    return {
      voltage: this.voltageOn,
      current: this.currentOn,
      reducedMotion: this.reducedMotionValue,
      inScene: this.inScene,
      terminals: this.terminals.map((t, i) => ({
        entity: t.ref.entity,
        terminal: t.ref.terminal,
        positionMm: [metresToMm(t.position.x), metresToMm(t.position.y), metresToMm(t.position.z)],
        volts: stepName(s.terminalVolts[i]),
        highlighted: this.highlighted[i] === 1,
      })),
      leads: this.drawnLeads.map((l, j) => ({
        connection: l.connection,
        volts: [stepName(s.leadVoltsA[j]), stepName(s.leadVoltsB[j])],
        amps: s.leadAmps[j] === STEP_UNKNOWN ? 'unknown' : s.leadAmps[j],
        direction: s.leadDirection[j] > 0 ? 'a→b' : s.leadDirection[j] < 0 ? 'b→a' : 'none',
        arrows: this.arrowsShown(j) ? l.arrowCount : 0,
      })),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.feed = null;
    for (const layer of [
      this.leads,
      this.terminalsKnown,
      this.terminalsUnknown,
      this.arrowsDc,
      this.arrowsAc,
      this.highlight,
    ]) {
      layer.dispose();
    }
    this.geometries.forEach((g) => g.dispose());
    this.materials.forEach((m) => m.dispose());
    if (this.inScene) this.scene.remove(this.group);
    this.inScene = false;
    this.legendListeners.clear();
  }

  // --- snapshot side ---------------------------------------------------------------------------

  private onSnapshot(view: SnapshotView | null): void {
    if (this.disposed) return;
    if (view === null) {
      this.reading = null;
      this.readout = null;
      this.join = joinOverlayItems(this.items, null);
    } else {
      if (view.descriptor !== this.readout?.descriptor) {
        // A new generation (or worker): lookups once per descriptor, CPU-side index arrays only. The
        // steps restart from unknown, so hysteresis never carries a bin over from the old numbering
        // or an island's old band.
        this.readout = NetlistReadout.of(view.descriptor);
        this.reading = this.readout.createReading();
        this.join = joinOverlayItems(this.items, this.readout);
        resetOverlaySteps(this.steps);
      }
      this.readout.read(view, this.reading as NetlistReading);
    }
    if (!this.voltageOn && !this.currentOn) return; // read (for when one is switched on), draw nothing
    if (this.refreshSteps(false)) {
      this.publishLegend();
      this.onInvalidate();
    }
  }

  /** Recomputes the steps; rewrites colours and matrices if any changed (or `force`). Returns whether they did. */
  private refreshSteps(force: boolean): boolean {
    const inputs = this.stepInputs;
    inputs.readout = this.readout;
    inputs.reading = this.reading;
    inputs.join = this.join;
    const changed = updateOverlaySteps(this.steps, inputs);
    if (changed || force) this.writeStepped();
    return changed;
  }

  private animating(): boolean {
    if (!this.currentOn || this.reducedMotionValue || this.feed === null || !this.feed.running) return false;
    const amps = this.steps.leadAmps;
    for (let j = 0; j < amps.length; j++) if (amps[j] > 0 && amps[j] <= OVER_RANGE_BIN) return true;
    return false;
  }

  /**
   * Recomputes the legend state and notifies only if it changed. Runs on an overlay switch, a world
   * change or a step change, never on a snapshot whose steps didn't move, so the closure and the
   * `bands` array it builds are not per-snapshot allocations.
   */
  private publishLegend(): void {
    this.bandsUsed.fill(0);
    let noScale = false;
    let unknown = false;
    const s = this.steps;
    const consider = (step: number, node: number) => {
      if (step === STEP_UNKNOWN) unknown = true;
      else if (step === STEP_NO_SCALE) noScale = true;
      else if (node >= 0 && this.readout && this.reading) {
        this.bandsUsed[this.reading.islandBand[this.readout.islandOfNode(node)]] = 1;
      }
    };
    if (this.voltageOn) {
      for (let i = 0; i < s.terminalVolts.length; i++) consider(s.terminalVolts[i], this.join.terminalNode[i]);
      for (let j = 0; j < s.leadVoltsA.length; j++) {
        consider(s.leadVoltsA[j], this.join.leadNodeA[j]);
        consider(s.leadVoltsB[j], this.join.leadNodeB[j]);
      }
    }
    if (this.currentOn) for (let j = 0; j < s.leadAmps.length; j++) if (s.leadAmps[j] === STEP_UNKNOWN) unknown = true;
    const bands: string[] = [];
    this.bandsUsed.forEach((used, band) => {
      const scale = band < this.scales.length ? this.scales[band] : null;
      if (used === 1 && scale) bands.push(scale.band);
    });
    const next: OverlayLegendState = { voltage: this.voltageOn, current: this.currentOn, bands, noScale, unknown };
    const prev = this.legend;
    if (
      prev.voltage === next.voltage &&
      prev.current === next.current &&
      prev.noScale === next.noScale &&
      prev.unknown === next.unknown &&
      prev.bands.join() === next.bands.join()
    ) {
      return;
    }
    this.legend = next;
    this.legendListeners.forEach((l) => l(next));
  }

  // --- world side ------------------------------------------------------------------------------

  /** Terminal world positions (catalogue terminal × entity transform) and the leads between them. */
  private rebuildItems(world: World): void {
    const rotation = new Euler();
    const matrix = new Matrix4();
    const positions = new Map<number, Map<string, Vector3>>();
    this.terminals = [];
    for (const entity of world.entities) {
      const def = this.catalog.device(entity.ref);
      if (def === undefined || def.terminals.length === 0) continue;
      const { positionMm: p, orientationMdeg: o } = entity.transform;
      rotation.set(mdegToRadians(o.pitch), mdegToRadians(o.yaw), mdegToRadians(o.roll), 'YXZ');
      matrix.makeRotationFromEuler(rotation).setPosition(mm(p.x), mm(p.y), mm(p.z));
      const byTerminal = new Map<string, Vector3>();
      positions.set(entity.id, byTerminal);
      for (const t of def.terminals) {
        const position = new Vector3(mm(t.positionMm.x), mm(t.positionMm.y), mm(t.positionMm.z)).applyMatrix4(matrix);
        byTerminal.set(t.id, position);
        this.terminals.push({ ref: { entity: entity.id, terminal: t.id }, position });
      }
    }
    this.drawnLeads = [];
    let arrowStart = 0;
    for (const c of world.connections) {
      const start = positions.get(c.a.entity)?.get(c.a.terminal);
      const end = positions.get(c.b.entity)?.get(c.b.terminal);
      if (start === undefined || end === undefined) continue; // an end on an unknown device: not drawn
      const lengthMm = Math.max(1, start.distanceTo(end) * 1000);
      const direction = new Vector3().subVectors(end, start).normalize();
      const forward = new Quaternion().setFromUnitVectors(UP, direction.lengthSq() > 0 ? direction : UP);
      const backward = new Quaternion().setFromUnitVectors(
        UP,
        direction.lengthSq() > 0 ? direction.clone().negate() : UP,
      );
      const count = arrowCount(lengthMm);
      this.drawnLeads.push({
        connection: c.id,
        a: { entity: c.a.entity, terminal: c.a.terminal },
        b: { entity: c.b.entity, terminal: c.b.terminal },
        start,
        end,
        lengthMm,
        arrowStart,
        arrowCount: count,
        forward,
        backward,
      });
      arrowStart += count;
    }
    this.arrowSlots = arrowStart;
    this.items = {
      terminals: this.terminals.map((t) => t.ref),
      leads: this.drawnLeads.map((l) => ({ connection: l.connection, a: l.a, b: l.b })),
    };
    this.highlighted = new Uint8Array(this.terminals.length);
  }

  /** Instance capacities for this world (each layer then draws only the instances in use). */
  private writeStaticMatrices(): void {
    const terminals = this.terminals.length;
    this.leads.ensure(2 * this.drawnLeads.length);
    this.leads.mesh.count = 2 * this.drawnLeads.length;
    this.terminalsKnown.ensure(terminals);
    this.terminalsUnknown.ensure(terminals);
    this.highlight.ensure(terminals);
    this.arrowsDc.ensure(this.arrowSlots);
    this.arrowsAc.ensure(this.arrowSlots);
    this.dcSlot = new Int32Array(this.drawnLeads.length).fill(-1);
    this.acSlot = new Int32Array(this.drawnLeads.length).fill(-1);
  }

  /** The highlight rings, packed: one instance per highlighted terminal. */
  private applyHighlight(): number {
    const wanted = new Set(this.highlightRefs.map((t) => `${t.entity}\u0000${t.terminal}`));
    let count = 0;
    const mesh = this.highlight.mesh;
    const colour = this.colour.setHex(HIGHLIGHT_COLOUR);
    this.terminals.forEach((t, i) => {
      const on = wanted.has(`${t.ref.entity}\u0000${t.ref.terminal}`);
      this.highlighted[i] = on ? 1 : 0;
      if (!on) return;
      this.m.compose(t.position, this.q.identity(), this.s.setScalar(mm(HIGHLIGHT_RADIUS_MM)));
      mesh.setMatrixAt(count, this.m);
      mesh.setColorAt(count, colour);
      count++;
    });
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    markColours(mesh);
    return count;
  }

  // --- step side -------------------------------------------------------------------------------

  /**
   * Colours and sizes from the steps: leads by voltage (or by current when only current is on),
   * terminals by voltage. The terminal and arrow layers are packed: known and unknown terminals,
   * and DC and AC arrows, each draw only their own instances (no zero-scaled duplicates), so the
   * vertex work follows what is shown.
   */
  private writeStepped(): void {
    const s = this.steps;
    const leadMesh = this.leads.mesh;
    this.drawnLeads.forEach((lead, j) => {
      const mid = this.v.addVectors(lead.start, lead.end).multiplyScalar(0.5);
      for (const half of [0, 1] as const) {
        const step = this.voltageOn ? (half === 0 ? s.leadVoltsA[j] : s.leadVoltsB[j]) : s.leadAmps[j];
        const radius = mm(step === STEP_UNKNOWN ? UNKNOWN_LEAD_RADIUS_MM : LEAD_RADIUS_MM);
        const from = half === 0 ? lead.start : mid;
        const to = half === 0 ? mid : lead.end;
        const length = from.distanceTo(to);
        // Centre of the half, along the lead's unit cylinder (+y).
        const cx = (from.x + to.x) / 2;
        const cy = (from.y + to.y) / 2;
        const cz = (from.z + to.z) / 2;
        this.m.compose(this.s.set(cx, cy, cz), lead.forward, this.scale.set(radius, length, radius));
        leadMesh.setMatrixAt(2 * j + half, this.m);
        leadMesh.setColorAt(2 * j + half, this.colour.setHex(stepColour(step)));
      }
    });
    leadMesh.instanceMatrix.needsUpdate = true;
    markColours(leadMesh);

    const known = this.terminalsKnown.mesh;
    const unknown = this.terminalsUnknown.mesh;
    let k = 0;
    let u = 0;
    this.terminals.forEach((t, i) => {
      const step = s.terminalVolts[i];
      if (step === STEP_UNKNOWN) {
        this.m.compose(t.position, this.q.identity(), this.s.setScalar(mm(UNKNOWN_TERMINAL_RADIUS_MM)));
        unknown.setMatrixAt(u, this.m);
        unknown.setColorAt(u++, this.colour.setHex(stepColour(STEP_UNKNOWN)));
      } else {
        this.m.compose(t.position, this.q.identity(), this.s.setScalar(mm(TERMINAL_RADIUS_MM)));
        known.setMatrixAt(k, this.m);
        known.setColorAt(k++, this.colour.setHex(stepColour(step)));
      }
    });
    known.count = k;
    unknown.count = u;
    known.instanceMatrix.needsUpdate = true;
    unknown.instanceMatrix.needsUpdate = true;
    markColours(known);
    markColours(unknown);

    let dc = 0;
    let ac = 0;
    for (let j = 0; j < this.drawnLeads.length; j++) {
      const lead = this.drawnLeads[j];
      this.dcSlot[j] = -1;
      this.acSlot[j] = -1;
      if (this.arrowsShown(j)) {
        const colour = this.colour.setHex(stepColour(s.leadAmps[j]));
        const layer = s.leadDirection[j] !== 0 ? this.arrowsDc.mesh : this.arrowsAc.mesh;
        const first = s.leadDirection[j] !== 0 ? dc : ac;
        for (let n = 0; n < lead.arrowCount; n++) layer.setColorAt(first + n, colour);
        if (s.leadDirection[j] !== 0) {
          this.dcSlot[j] = dc;
          dc += lead.arrowCount;
        } else {
          this.acSlot[j] = ac;
          ac += lead.arrowCount;
        }
      }
      if (!this.animatedPose) this.phases[j] = 0;
      this.writeArrows(j);
    }
    this.arrowsDc.mesh.count = dc;
    this.arrowsAc.mesh.count = ac;
    this.arrowsDc.mesh.instanceMatrix.needsUpdate = true;
    this.arrowsAc.mesh.instanceMatrix.needsUpdate = true;
    markColours(this.arrowsDc.mesh);
    markColours(this.arrowsAc.mesh);
  }

  private arrowsShown(j: number): boolean {
    const bin = this.steps.leadAmps[j];
    return this.currentOn && bin > 0 && bin <= OVER_RANGE_BIN;
  }

  /** Lead `j`'s arrow matrices at its phase, in its packed slots: DC cones travel, AC diamonds sway. */
  private writeArrows(j: number): void {
    const lead = this.drawnLeads[j];
    const direction = this.steps.leadDirection[j];
    const dcFirst = this.dcSlot[j];
    const acFirst = this.acSlot[j];
    if (dcFirst < 0 && acFirst < 0) return;
    const phase = this.phases[j];
    const r = mm(ARROW_RADIUS_MM);
    for (let k = 0; k < lead.arrowCount; k++) {
      if (dcFirst >= 0) {
        // Travelling a→b is increasing fraction; b→a runs the same slots backwards.
        const f = arrowFraction(k, lead.arrowCount, phase, lead.lengthMm);
        this.v.lerpVectors(lead.start, lead.end, direction > 0 ? f : 1 - f);
        this.m.compose(this.v, direction < 0 ? lead.backward : lead.forward, this.scale.set(r, mm(ARROW_LENGTH_MM), r));
        this.arrowsDc.mesh.setMatrixAt(dcFirst + k, this.m);
      } else {
        const rest = (k + 0.5) / lead.arrowCount;
        this.v.lerpVectors(
          lead.start,
          lead.end,
          rest + swayOffsetMm(phase, lead.lengthMm, lead.arrowCount) / lead.lengthMm,
        );
        this.m.compose(this.v, lead.forward, this.scale.set(r, mm(ARROW_LENGTH_MM / 2), r));
        this.arrowsAc.mesh.setMatrixAt(acFirst + k, this.m);
      }
    }
  }

  /** Arrows back to their evenly spaced rest positions (reduced motion, a paused sim). */
  private restPose(): void {
    this.phases.fill(0);
    for (let j = 0; j < this.drawnLeads.length; j++) this.writeArrows(j);
    this.arrowsDc.mesh.instanceMatrix.needsUpdate = true;
    this.arrowsAc.mesh.instanceMatrix.needsUpdate = true;
    this.animatedPose = false;
  }

  private applyVisibility(): void {
    const anyHighlight = this.highlighted.some((h) => h === 1);
    this.leads.mesh.visible = this.voltageOn || this.currentOn;
    this.terminalsKnown.mesh.visible = this.voltageOn;
    this.terminalsUnknown.mesh.visible = this.voltageOn;
    this.arrowsDc.mesh.visible = this.currentOn;
    this.arrowsAc.mesh.visible = this.currentOn;
    this.highlight.mesh.visible = anyHighlight;
    const wanted = this.voltageOn || this.currentOn || anyHighlight;
    if (wanted && !this.inScene) this.scene.add(this.group);
    else if (!wanted && this.inScene) this.scene.remove(this.group);
    this.inScene = wanted;
  }
}

function markColours(mesh: InstancedMesh): void {
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}
