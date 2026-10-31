import { GMIN_S } from '../lib/constants';
import { AcBranchValues } from '../lib/mna/ac-values';
import { DcBranchValues } from '../lib/mna/values';
import { computeTopologyHash } from '../lib/netlist/hash';
import type { Netlist, NetlistBranch, NetlistNode, SourceDomain } from '../lib/netlist/types';
import {
  type OracleCircuit,
  type OracleDomain,
  type OracleElement,
  type OracleElementKind,
  ORACLE_FREQUENCY_HZ,
  phasorUnit,
  valueNumber,
} from './circuit';

/*
 * The sim-core side of an oracle circuit (plan F2.7): the circuit in F2.1's netlist vocabulary, the
 * input the F2.2 solvers are compared on. It mirrors `NetlistBranch` (index, kind, source, a, b, sorted
 * `values`) and the canonical numbering: node 0 is the reference and the circuit's smallest node, so it
 * is the node F2.2 picks as the island's reference; branch k is deck element k.
 *
 * `resistor` and `vsource` are F2.1's `ElementKind`s; `isource`, `inductor` and `capacitor` are oracle
 * kinds. F2.1's `ElementKind` is deliberately not widened (ADR 0012, test-engineer review).
 *
 * `oracleDcInput` adapts a DC circuit to the solver's real input, an F2.1 `Netlist` plus F2.2's
 * `DcBranchValues`: `resistor` and `vsource` map to themselves, and an `isource` becomes a `resistor`
 * element stamped `DC_STAMP_ISOURCE`, so `islandReferenceNode` (which looks only at `vsource`
 * elements) can never pick a current source's end.
 *
 * `oracleAcInput` adapts an AC circuit to the phasor solver's input (F2.2 part 2), a `Netlist` plus
 * `AcBranchValues` at the circuit's 60 Hz: `resistor`, `inductor` and `capacitor` are all `resistor`
 * elements stamped `resistor`, `inductor` or `capacitor` (inductance and capacitance are AC stamp
 * modes, not element kinds), and a `vsource` is a `vsource` element with its phasor EMF from the exact
 * angle constants.
 */

export interface OracleNetlistBranch {
  readonly index: number;
  readonly kind: OracleElementKind;
  /** For a source element, what it supplies; `null` for passive elements (as in `NetlistBranch`). */
  readonly source: SourceDomain | null;
  readonly a: number;
  readonly b: number;
  /**
   * The element's values, keys sorted: `resistanceOhm`; a DC `vsource`'s `emfV`, an AC one's phasor
   * `emfRe` and `emfIm` (from the exact angle constants), and `internalResistanceOhm`; `currentA`;
   * `inductanceH`; `capacitanceF`.
   */
  readonly values: Readonly<Record<string, number>>;
}

export interface OracleNetlist {
  readonly domain: OracleDomain;
  /** The analysis frequency: 60 Hz for `ac`, `null` for `dc`. */
  readonly frequencyHz: number | null;
  /** Nodes, including the reference node 0. */
  readonly nodeCount: number;
  /** The `gmin` the deck stamps from every non-reference node to ground. */
  readonly gminS: number;
  readonly branches: readonly OracleNetlistBranch[];
}

function branchOf(domain: OracleDomain, index: number, element: OracleElement): OracleNetlistBranch {
  const { kind, a, b } = element;
  const passive = (values: Record<string, number>): OracleNetlistBranch => ({
    index,
    kind,
    source: null,
    a,
    b,
    values,
  });
  switch (element.kind) {
    case 'resistor':
      return passive({ resistanceOhm: valueNumber(element.resistanceOhm) });
    case 'inductor':
      return passive({ inductanceH: valueNumber(element.inductanceH) });
    case 'capacitor':
      return passive({ capacitanceF: valueNumber(element.capacitanceF) });
    case 'isource':
      return { index, kind, source: domain, a, b, values: { currentA: valueNumber(element.currentA) } };
    case 'vsource': {
      const emf = valueNumber(element.emfV);
      const internalResistanceOhm = valueNumber(element.internalResistanceOhm);
      if (domain === 'dc') return { index, kind, source: domain, a, b, values: { emfV: emf, internalResistanceOhm } };
      const unit = phasorUnit(element.angleDeg);
      return {
        index,
        kind,
        source: domain,
        a,
        b,
        values: { emfIm: emf * unit.im, emfRe: emf * unit.re, internalResistanceOhm },
      };
    }
  }
}

/** The sim-core netlist of `circuit`. Pure: the same circuit gives a deeply equal netlist. */
export function oracleNetlist(circuit: OracleCircuit): OracleNetlist {
  return {
    domain: circuit.domain,
    frequencyHz: circuit.domain === 'ac' ? ORACLE_FREQUENCY_HZ : null,
    nodeCount: circuit.nodeCount,
    gminS: GMIN_S.value,
    branches: circuit.elements.map((element, index) => branchOf(circuit.domain, index, element)),
  };
}

/** The model kind each adapted branch carries (ASCII, as the topology encoding requires). */
const ADAPTED_MODEL = 'oracle.element';

/** The adapted netlist's nodes: node `n` has the single member terminal `(n + 1, 'n')`, all in island 0. */
function adaptedNodes(circuit: OracleCircuit): NetlistNode[] {
  return Array.from({ length: circuit.nodeCount }, (_, index) => ({
    index,
    island: 0,
    members: [{ entity: index + 1, terminal: 'n' }],
  }));
}

/** The adapted netlist: one island of `kind` holding every node and branch, with its real `topologyHash`. */
function adaptedNetlist(nodes: NetlistNode[], branches: NetlistBranch[], kind: 'dc' | 'ac'): Netlist {
  return {
    nodes,
    branches,
    islands: [
      {
        index: 0,
        kind,
        nodes: nodes.map((node) => node.index),
        branches: branches.map((branch) => branch.index),
      },
    ],
    devices: [],
    topologyHash: computeTopologyHash(nodes, branches),
    diagnostics: [],
  };
}

/** Branch `index` of the adapted netlist, before its kind and source: connection `index + 1`. */
function adaptedBranch(index: number, element: OracleElement) {
  return {
    index,
    element: { kind: 'connection', connection: index + 1 } as const,
    model: ADAPTED_MODEL,
    a: element.a,
    b: element.b,
    island: 0,
    values: {},
  };
}

/**
 * A DC oracle circuit as the DC solver's input (ADR 0012): one island holding every node, node `n`
 * with the single member terminal `(n + 1, 'n')`, branch `k` connection `k + 1` of model
 * `oracle.element`, in the circuit's branch order, with its real `topologyHash`. Throws on an AC
 * circuit (`oracleAcInput`).
 */
export function oracleDcInput(circuit: OracleCircuit): { readonly netlist: Netlist; readonly values: DcBranchValues } {
  if (circuit.domain !== 'dc') throw new RangeError(`${circuit.name}: not a DC circuit`);
  const values = new DcBranchValues(circuit.elements.length);
  const branches: NetlistBranch[] = circuit.elements.map((element, index): NetlistBranch => {
    const base = adaptedBranch(index, element);
    switch (element.kind) {
      case 'resistor':
        values.resistor(index, valueNumber(element.resistanceOhm));
        return { ...base, kind: 'resistor', source: null };
      case 'vsource':
        values.vsource(index, valueNumber(element.emfV), valueNumber(element.internalResistanceOhm));
        return { ...base, kind: 'vsource', source: 'dc' };
      case 'isource':
        // A `resistor` element with an isource stamp: never a reference candidate.
        values.isource(index, valueNumber(element.currentA));
        return { ...base, kind: 'resistor', source: 'dc' };
      default:
        throw new RangeError(`${circuit.name}: ${element.kind} is not a DC element`);
    }
  });
  return { netlist: adaptedNetlist(adaptedNodes(circuit), branches, 'dc'), values };
}

/**
 * An AC oracle circuit as the phasor solver's input (F2.2 part 2, ADR 0012), laid out as
 * `oracleDcInput`'s, at `ORACLE_FREQUENCY_HZ`: R, L and C are `resistor` elements with their AC stamp,
 * and a phasor source is a `vsource` element whose EMF comes from `phasorUnit` (the exact angle
 * constants), where the deck's comes from ngspice's own cos and sin. Throws on a DC circuit.
 */
export function oracleAcInput(circuit: OracleCircuit): {
  readonly netlist: Netlist;
  readonly values: AcBranchValues;
  readonly frequencyHz: number;
} {
  if (circuit.domain !== 'ac') throw new RangeError(`${circuit.name}: not an AC circuit`);
  const values = new AcBranchValues(circuit.elements.length);
  const branches: NetlistBranch[] = circuit.elements.map((element, index): NetlistBranch => {
    const base = adaptedBranch(index, element);
    switch (element.kind) {
      case 'resistor':
        values.resistor(index, valueNumber(element.resistanceOhm));
        return { ...base, kind: 'resistor', source: null };
      case 'inductor':
        values.inductor(index, valueNumber(element.inductanceH));
        return { ...base, kind: 'resistor', source: null };
      case 'capacitor':
        values.capacitor(index, valueNumber(element.capacitanceF));
        return { ...base, kind: 'resistor', source: null };
      case 'vsource':
        values.vsourcePolar(
          index,
          valueNumber(element.emfV),
          element.angleDeg,
          valueNumber(element.internalResistanceOhm),
        );
        return { ...base, kind: 'vsource', source: 'ac' };
      default:
        throw new RangeError(`${circuit.name}: ${element.kind} is not an AC element`);
    }
  });
  return { netlist: adaptedNetlist(adaptedNodes(circuit), branches, 'ac'), values, frequencyHz: ORACLE_FREQUENCY_HZ };
}
