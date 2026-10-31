import type { SourceDomain } from '../lib/netlist/types';
import {
  type OracleCircuit,
  type OracleDomain,
  type OracleElement,
  type OracleElementKind,
  ORACLE_FREQUENCY_HZ,
  ORACLE_GMIN_S,
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
 * TODO(F2.2): after #46 lands, add the adapter from this netlist to the solver's input, a `Netlist`
 * plus `DcBranchValues`: `resistor` and `vsource` map to themselves, and an `isource` maps to a
 * `resistor` element with the `DC_STAMP_ISOURCE` stamp, so `islandReferenceNode` can never pick a
 * current source's end. Then, in `corpus.spec.ts`: run the element-equation and KCL residuals on the
 * adapted `Netlist` and `DcBranchValues`, assert `islandReferenceNode(...) === 0` for every circuit,
 * and switch the DC comparison on (part 2 adds `inductor` and `capacitor` and the AC comparison).
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
    gminS: ORACLE_GMIN_S,
    branches: circuit.elements.map((element, index) => branchOf(circuit.domain, index, element)),
  };
}
