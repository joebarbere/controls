import { AcBranchValues } from '../lib/mna/ac-values';
import { type PhasorAngle, phasorUnit } from '../lib/mna/phasor';
import type { Netlist } from '../lib/netlist/types';
import type { AcCircuit } from './ac';
import { syntheticNetlist, type SyntheticBranch } from './mna';

/*
 * Synthetic phasor circuits for the AC solver's specs (F2.2 part 2), small and large, all at the NEC
 * 60 Hz unless a spec says otherwise. Specs only; excluded from the lib build.
 *
 * Elements: resistors from 0.1 mΩ (busbar scale) to 100 kΩ, inductors from 1 µH to 1 H (0.38 mΩ to
 * 377 Ω of reactance), capacitors from 1 nF to 10 mF (2.65 MΩ to 0.27 Ω), and phasor voltage sources
 * up to 480 V RMS at the exact angles (0°, 180°, ±120°) or at any complex value, a sixth of them
 * ideal (zero series resistance). Every element conducts, so an island is connected through finite
 * admittances; L–C pairs near resonance occur, held by gmin and the resistors around them.
 *
 * `wellConditioned` restricts a circuit to where comparing two solvers' *values* means something
 * (the plan's F2.2 floor policy): a resistive spanning tree of 1 Ω–10 kΩ (and sources behind at least
 * 0.1 Ω), with extra R, L and C of 1 Ω–10 kΩ of impedance. A resistive tree keeps Re(Y) definite, which
 * bounds ‖M⁻¹‖ however the reactances cancel, so the forward error stays small.
 */

const R_DECADES = [1e-4, 1e-3, 1e-2, 1e-1, 1, 10, 100, 1e3, 1e4];
const L_DECADES = [1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 1e-1];
const C_DECADES = [1e-9, 1e-8, 1e-7, 1e-6, 1e-5, 1e-4, 1e-3];
/** At 60 Hz: L of 2.65 mH–26.5 H and C of 0.265 µF–2.65 mF give 1 Ω–10 kΩ of reactance (with mantissas to ×10). */
const WELL_R_DECADES = [1, 10, 100, 1e3];
const WELL_L_DECADES = [2.65e-3, 2.65e-2, 2.65e-1, 2.65];
const WELL_C_DECADES = [2.65e-7, 2.65e-6, 2.65e-5, 2.65e-4];

/**
 * The smallest series resistance a non-ideal generated source gets: the plan's F2.2 rule that
 * generators keep resistances down to 1e-4 Ω (busbar scale), and no lower. A 1 µΩ source made the
 * floor policy's source term (16 ε t / R) dwarf every real current (PR #51 review).
 */
export const MIN_SOURCE_OHMS = 1e-4;

export const AC_ANGLES: readonly PhasorAngle[] = [0, 180, 120, -120];

/** One element drawn by integers: the kind and value come from `kind`, `mantissa` and `decade`. */
export interface AcElementDraw {
  /** 0–2 resistor, 3–4 inductor, 5–6 capacitor, 7–10 vsource. */
  readonly kind: number;
  readonly mantissa: number;
  readonly decade: number;
  /** A source's magnitude in 0.1 V (signed), and its second part for a free complex EMF. */
  readonly sourceRe: number;
  readonly sourceIm: number;
  /** 0–3: the exact angles; 4: the free complex EMF `sourceRe + j·sourceIm`. */
  readonly angle: number;
  /** A source is ideal when 0. */
  readonly ideal: number;
}

type Stamp =
  | { readonly kind: 'r'; readonly ohms: number }
  | { readonly kind: 'l'; readonly henries: number }
  | { readonly kind: 'c'; readonly farads: number }
  | { readonly kind: 'v'; readonly re: number; readonly im: number; readonly ohms: number; readonly henries: number };

const scaled = (mantissa: number, decades: readonly number[], decade: number) =>
  (1 + (mantissa % 9000) / 1000) * decades[decade % decades.length];

/**
 * The stamp an element draw names. `tree` forces a conducting tree element of a well-conditioned
 * circuit to a resistor or a source (no reactive tree).
 */
export function drawStamp(e: AcElementDraw, wellConditioned: boolean, tree: boolean, sourceInductance = false): Stamp {
  let kind = e.kind % 11;
  if (wellConditioned && tree && kind >= 3 && kind <= 6) kind = 0;
  if (kind <= 2) return { kind: 'r', ohms: scaled(e.mantissa, wellConditioned ? WELL_R_DECADES : R_DECADES, e.decade) };
  if (kind <= 4) {
    return { kind: 'l', henries: scaled(e.mantissa, wellConditioned ? WELL_L_DECADES : L_DECADES, e.decade) };
  }
  if (kind <= 6) {
    return { kind: 'c', farads: scaled(e.mantissa, wellConditioned ? WELL_C_DECADES : C_DECADES, e.decade) };
  }
  const magnitude = e.sourceRe / 10;
  const angle = e.angle % 5;
  const [re, im] =
    angle === 4
      ? [e.sourceRe / 10, e.sourceIm / 10]
      : ((u) => [magnitude * u.re, magnitude * u.im])(phasorUnit(AC_ANGLES[angle]));
  const ohms = wellConditioned
    ? 0.1 + (e.mantissa % 1000) / 100
    : e.ideal % 6 === 0
      ? 0
      : Math.max(MIN_SOURCE_OHMS, scaled(e.mantissa, R_DECADES, e.decade) / 100);
  // A non-ideal source's series inductance (F2.4's source reactance), only when the draw asks for it,
  // so the circuits (and pins) of draws without it are unchanged: 1 µH … 0.1 H, about 4e-4 … 40 Ω at 60 Hz.
  const henries =
    sourceInductance && ohms > 0 ? scaled(e.mantissa + Math.abs(e.sourceIm), L_DECADES, e.decade + e.angle) : 0;
  return { kind: 'v', re, im, ohms, henries };
}

/** Writes `stamps` into new AC values for `netlist`. */
export function stampValues(netlist: Netlist, stamps: readonly Stamp[]): AcBranchValues {
  const values = new AcBranchValues(netlist.branches.length);
  stamps.forEach((stamp, b) => {
    if (stamp.kind === 'r') values.resistor(b, stamp.ohms);
    else if (stamp.kind === 'l') values.inductor(b, stamp.henries);
    else if (stamp.kind === 'c') values.capacitor(b, stamp.farads);
    else values.vsource(b, stamp.re, stamp.im, stamp.ohms, stamp.henries);
  });
  return values;
}

/** A circuit drawn from integers: `nodes` nodes in up to `islands` groups, each a tree plus extras. */
export interface AcCircuitDraw {
  readonly nodes: number;
  readonly islands: number;
  /** One per node (index 0 unused): its parent pick and the tree element to it. */
  readonly tree: readonly (readonly [number, AcElementDraw])[];
  /** Extra elements from `x % nodes`: to any node when `y % 4 === 0` (merging islands), else within its group. */
  readonly extra: readonly (readonly [number, number, AcElementDraw])[];
  readonly wellConditioned?: boolean;
  /** Non-ideal sources get a series inductance too (F2.4); off by default. */
  readonly sourceInductance?: boolean;
}

/** Builds the circuit a draw names, at `frequencyHz`. Islands without a source are `empty` (not AC-solved). */
export function buildAcCircuit(draw: AcCircuitDraw, frequencyHz = 60): AcCircuit {
  const n = draw.nodes;
  const well = draw.wellConditioned === true;
  const withL = draw.sourceInductance === true;
  const groups = Math.min(draw.islands, n);
  const groupStart = (g: number) => Math.floor((g * n) / groups);
  const groupOf = (node: number) => {
    let g = groups - 1;
    while (groupStart(g) > node) g--;
    return g;
  };
  const edges: SyntheticBranch[] = [];
  const stamps: Stamp[] = [];
  const push = (a: number, b: number, stamp: Stamp) => {
    edges.push({ a, b, kind: stamp.kind === 'v' ? 'vsource' : 'resistor' });
    stamps.push(stamp);
  };
  for (let node = 1; node < n; node++) {
    const start = groupStart(groupOf(node));
    if (node === start) continue;
    const [pick, e] = draw.tree[node % draw.tree.length];
    const other = start + (pick % (node - start));
    const stamp = drawStamp(e, well, true, withL);
    if (pick % 2 === 0) push(other, node, stamp);
    else push(node, other, stamp);
  }
  for (const [x, y, e] of draw.extra) {
    const a = x % n;
    // A quarter of the extras join any two nodes (merging islands); the rest stay in a's group, so
    // multi-island circuits survive the loops.
    if (y % 4 === 0) {
      push(a, Math.floor(y / 4) % n, drawStamp(e, well, false, withL));
    } else {
      const group = groupOf(a);
      const start = groupStart(group);
      const size = (group + 1 < groups ? groupStart(group + 1) : n) - start;
      push(a, start + (y % size), drawStamp(e, well, false, withL));
    }
  }
  const netlist = syntheticNetlist(n, edges, 'ac');
  return { netlist, values: stampValues(netlist, stamps), frequencyHz };
}

/** Large circuits: as `largeCircuit` (DC), a deterministic xorshift draw from a few integers. */
export interface LargeAcCircuitSpec {
  readonly nodes: number;
  readonly islands: number;
  readonly seed: number;
  /** Extra loop-closing elements per 100 nodes (0–30). */
  readonly meshPercent: number;
  readonly wellConditioned: boolean;
}

/** xorshift32: integer-only, the same sequence in every runtime. */
class Xorshift {
  private state: number;
  constructor(seed: number) {
    this.state = seed | 0 || 0x9e3779b9;
  }
  below(n: number): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x;
    return (x >>> 0) % n;
  }
}

/**
 * A plant-like phasor circuit of tens to hundreds of nodes: per island a source at the root of a
 * feeder tree (half chains, half fan-out) of mostly series impedances, closed into loops by extra
 * R, L, C and sources.
 */
export function largeAcCircuit(spec: LargeAcCircuitSpec): AcCircuit {
  const rng = new Xorshift(spec.seed);
  const n = Math.max(2, spec.nodes);
  const groups = Math.max(1, Math.min(spec.islands, Math.floor(n / 2)));
  const start = (g: number) => Math.floor((g * n) / groups);
  const well = spec.wellConditioned;
  const element = (kind: number): AcElementDraw => ({
    kind,
    mantissa: rng.below(9000),
    decade: rng.below(9),
    sourceRe: rng.below(9601) - 4800,
    sourceIm: rng.below(9601) - 4800,
    angle: rng.below(5),
    ideal: rng.below(6),
  });
  const edges: SyntheticBranch[] = [];
  const stamps: Stamp[] = [];
  const push = (a: number, b: number, stamp: Stamp) => {
    edges.push({ a, b, kind: stamp.kind === 'v' ? 'vsource' : 'resistor' });
    stamps.push(stamp);
  };
  for (let g = 0; g < groups; g++) {
    const first = start(g);
    const end = g + 1 < groups ? start(g + 1) : n;
    for (let node = first + 1; node < end; node++) {
      const parent = rng.below(2) === 0 ? node - 1 : first + rng.below(node - first);
      const roll = rng.below(20);
      const kind = roll < 2 || node === first + 1 ? 10 : rng.below(7);
      const stamp = drawStamp(element(kind), well, true);
      if (rng.below(2) === 0) push(parent, node, stamp);
      else push(node, parent, stamp);
    }
    const size = end - first;
    const extra = Math.floor((size * spec.meshPercent) / 100);
    for (let e = 0; e < extra; e++) {
      const a = first + rng.below(size);
      const b = rng.below(25) === 0 ? a : first + rng.below(size);
      push(a, b, drawStamp(element(rng.below(11)), well, false));
    }
  }
  const netlist = syntheticNetlist(n, edges, 'ac');
  return { netlist, values: stampValues(netlist, stamps), frequencyHz: 60 };
}
