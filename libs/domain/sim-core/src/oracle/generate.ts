import { deriveStream, type Sfc32 } from '@controls/world-model';
import {
  type OracleCircuit,
  type OracleDomain,
  type OracleElement,
  type OracleElementKind,
  type OracleValue,
  PHASOR_ANGLES,
} from './circuit';

/*
 * The seeded random-circuit generator (plan F2.7, ADR 0012). Each circuit is a pure function of the
 * corpus seed, its domain and its index, drawn from `deriveStream(seed, 'oracle:<domain>:<index>')`
 * (the project's sfc32, ADR 0007): no `Math.random`, no clock, integer arithmetic only. The decks
 * checked in under `libs/domain/sim-core/oracle/` are regenerated from it byte for byte by the
 * staleness test, so **any change here changes the corpus**: regenerate it (`pnpm sim oracle regen`).
 *
 * Shape: 2–30 nodes (node 0 the reference). A random spanning tree first, so every node has a path to
 * the reference through finite impedances (resistors and sources' internal resistance in DC; any
 * element in AC), so no circuit is singular. Then up to `nodeCount` extra elements between random
 * node pairs, which make loops and parallel elements. Every circuit has at least one source. The
 * element order and the node labels are shuffled, so neither says which elements form the tree.
 */

/** E12 mantissas: decimal values with two significant digits, as component values are sold. */
const E12 = [10, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82] as const;

/** A value range: an E12 mantissa times 10^exponent, the exponent in [min, max]. */
interface ValueRange {
  readonly minExponent: number;
  readonly maxExponent: number;
}

/**
 * The value ranges (ADR 0012). Wide enough to exercise scaling, narrow enough that `gmin` (1e-12 S)
 * through the largest resistance moves a result by well under the 1e-6 target if sim-core and the
 * deck disagree about it. Numerical test choices, not device data.
 */
export const ORACLE_RANGES = {
  /** 0.10 Ω … 82 kΩ. */
  resistanceOhm: { minExponent: -2, maxExponent: 3 },
  /** 1.0 V … 820 V (DC EMF, or AC RMS magnitude). */
  emfV: { minExponent: -1, maxExponent: 1 },
  /** 10 mΩ … 8.2 Ω behind each voltage source. */
  internalResistanceOhm: { minExponent: -3, maxExponent: -1 },
  /** 1.0 mA … 8.2 A. */
  currentA: { minExponent: -4, maxExponent: -1 },
  /** 0.10 mH … 0.82 H: about 0.04 Ω … 310 Ω of reactance at 60 Hz. */
  inductanceH: { minExponent: -5, maxExponent: -2 },
  /** 1.0 µF … 8.2 mF: about 0.32 Ω … 2.7 kΩ of reactance at 60 Hz. */
  capacitanceF: { minExponent: -7, maxExponent: -4 },
} as const satisfies Record<string, ValueRange>;

export const ORACLE_MIN_NODES = 2;
export const ORACLE_MAX_NODES = 30;

/** Integer weights of each kind, for the spanning tree and for the extra elements. */
type Weights = readonly (readonly [OracleElementKind, number])[];

const TREE_WEIGHTS: Readonly<Record<OracleDomain, Weights>> = {
  dc: [
    ['resistor', 4],
    ['vsource', 1],
  ],
  ac: [
    ['resistor', 7],
    ['inductor', 5],
    ['capacitor', 4],
    ['vsource', 4],
  ],
};

const EXTRA_WEIGHTS: Readonly<Record<OracleDomain, Weights>> = {
  dc: [
    ['resistor', 11],
    ['vsource', 3],
    ['isource', 6],
  ],
  ac: [
    ['resistor', 6],
    ['inductor', 5],
    ['capacitor', 5],
    ['vsource', 4],
  ],
};

/**
 * Swaps node labels so that node 0, SPICE's ground, is the node sim-core takes as the island's
 * reference (F2.2): the negative end (`a`) of the first voltage source in branch order, or else the
 * smallest node, which is already 0. Then both solvers stamp gmin to the same node and report every
 * voltage against it.
 */
function referencedToGround(elements: readonly OracleElement[]): OracleElement[] {
  const first = elements.find((element) => element.kind === 'vsource');
  const r = first === undefined ? 0 : first.a;
  const relabel = (n: number) => (n === r ? 0 : n === 0 ? r : n);
  return elements.map((element) => ({ ...element, a: relabel(element.a), b: relabel(element.b) }));
}

/** Passive kinds, for closing a loop across a source. */
const PASSIVE_WEIGHTS: Readonly<Record<OracleDomain, Weights>> = {
  dc: [['resistor', 1]],
  ac: [
    ['resistor', 1],
    ['inductor', 1],
    ['capacitor', 1],
  ],
};

/**
 * Whether current other than gmin's flows: a current source always drives its current, and a voltage
 * source does when another path joins its ends. Current sources don't count as a path (they fix their
 * current whatever the voltage).
 */
export function isExcited(elements: readonly OracleElement[], nodeCount: number): boolean {
  if (elements.some((element) => element.kind === 'isource')) return true;
  return elements.some((source, k) => {
    if (source.kind !== 'vsource') return false;
    const parent = Array.from({ length: nodeCount }, (_, n) => n);
    const find = (n: number): number => {
      while (parent[n] !== n) n = parent[n] = parent[parent[n]];
      return n;
    };
    elements.forEach((element, j) => {
      if (j !== k && element.kind !== 'isource') parent[find(element.a)] = find(element.b);
    });
    return find(source.a) === find(source.b);
  });
}

function pick(rng: Sfc32, weights: Weights): OracleElementKind {
  let total = 0;
  for (const [, weight] of weights) total += weight;
  let r = rng.nextInt(0, total - 1);
  let i = 0;
  while (r >= weights[i][1]) r -= weights[i++][1];
  return weights[i][0];
}

function drawValue(rng: Sfc32, range: ValueRange): OracleValue {
  return {
    mantissa: E12[rng.nextInt(0, E12.length - 1)],
    exponent: rng.nextInt(range.minExponent, range.maxExponent),
  };
}

function drawElement(rng: Sfc32, domain: OracleDomain, kind: OracleElementKind, a: number, b: number): OracleElement {
  switch (kind) {
    case 'resistor':
      return { kind, a, b, resistanceOhm: drawValue(rng, ORACLE_RANGES.resistanceOhm) };
    case 'vsource':
      return {
        kind,
        a,
        b,
        emfV: drawValue(rng, ORACLE_RANGES.emfV),
        angleDeg: domain === 'ac' ? PHASOR_ANGLES[rng.nextInt(0, PHASOR_ANGLES.length - 1)] : 0,
        internalResistanceOhm: drawValue(rng, ORACLE_RANGES.internalResistanceOhm),
      };
    case 'isource':
      return { kind, a, b, currentA: drawValue(rng, ORACLE_RANGES.currentA) };
    case 'inductor':
      return { kind, a, b, inductanceH: drawValue(rng, ORACLE_RANGES.inductanceH) };
    case 'capacitor':
      return { kind, a, b, capacitanceF: drawValue(rng, ORACLE_RANGES.capacitanceF) };
  }
}

/** Fisher–Yates, in place, from the circuit's own stream. */
function shuffle<T>(rng: Sfc32, items: T[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.nextInt(0, i);
    const t = items[i];
    items[i] = items[j];
    items[j] = t;
  }
}

/** A circuit's file stem: `dc-0042`. */
export function oracleCircuitName(domain: OracleDomain, index: number): string {
  return `${domain}-${String(index).padStart(4, '0')}`;
}

/** The stream key a circuit is drawn from. Part of the corpus: changing it changes every deck. */
export function oracleStreamKey(domain: OracleDomain, index: number): string {
  return `oracle:${domain}:${index}`;
}

/** Generates circuit `index` of the `domain` corpus drawn from `seed`. Pure and deterministic. */
export function generateOracleCircuit(domain: OracleDomain, seed: number, index: number): OracleCircuit {
  const rng = deriveStream(seed, oracleStreamKey(domain, index));
  const nodeCount = rng.nextInt(ORACLE_MIN_NODES, ORACLE_MAX_NODES);
  // Node labels: 0 stays the reference; 1 … n − 1 are shuffled so the tree's shape isn't in the labels.
  const label = Array.from({ length: nodeCount }, (_, i) => i);
  const tail = label.slice(1);
  shuffle(rng, tail);
  for (let i = 1; i < nodeCount; i++) label[i] = tail[i - 1];

  const elements: OracleElement[] = [];
  /** Adds an element between nodes `a` and `b` (labels), in a random orientation. */
  const connect = (kind: OracleElementKind, a: number, b: number) => {
    // Which end is `a` is part of what the solver must get right.
    const [x, y] = rng.nextInt(0, 1) === 0 ? [a, b] : [b, a];
    elements.push(drawElement(rng, domain, kind, x, y));
  };
  /** Two distinct random nodes (labels). */
  const pair = (): [number, number] => {
    const x = rng.nextInt(0, nodeCount - 1);
    let y = rng.nextInt(0, nodeCount - 2);
    if (y >= x) y++;
    return [label[x], label[y]];
  };
  for (let k = 1; k < nodeCount; k++) connect(pick(rng, TREE_WEIGHTS[domain]), label[rng.nextInt(0, k - 1)], label[k]);
  const extras = rng.nextInt(0, nodeCount);
  for (let e = 0; e < extras; e++) connect(pick(rng, EXTRA_WEIGHTS[domain]), ...pair());
  // Every circuit is excited: a tree (or a source on no loop) carries only gmin current, which is
  // rounding noise, not a test. Close a loop across a source with a passive element if none is.
  if (!elements.some((element) => element.kind === 'vsource' || element.kind === 'isource')) {
    connect('vsource', ...pair());
  }
  if (!isExcited(elements, nodeCount)) {
    const source = elements.find((element) => element.kind === 'vsource') as OracleElement;
    connect(pick(rng, PASSIVE_WEIGHTS[domain]), source.a, source.b);
  }
  shuffle(rng, elements);
  return {
    name: oracleCircuitName(domain, index),
    domain,
    seed,
    index,
    nodeCount,
    elements: referencedToGround(elements),
  };
}
