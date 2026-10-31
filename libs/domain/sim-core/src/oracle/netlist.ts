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
 * `resistor` and `vsource` are F2.1's `ElementKind`s; `isource` (F2.2 part 1) and `inductor` and
 * `capacitor` (part 2) are the stamps F2.2 adds. TODO(F2.2): when the solver's input type lands, add
 * the adapter from this netlist to it here (or emit it directly), and switch the comparison specs on.
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
