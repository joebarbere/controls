import { GMIN_S } from '../lib/constants';
import { type OracleCircuit, type OracleElement, ORACLE_FREQUENCY_HZ, valueText } from './circuit';

/*
 * The SPICE deck of an oracle circuit (plan F2.7, ADR 0012), for ngspice 47 in batch mode
 * (`ngspice -b <deck>`). The deck is checked in; `pnpm sim oracle regen` runs it. Its text is a pure
 * function of the circuit, so the staleness test can regenerate it byte for byte.
 *
 * - `.options sparse`: ngspice's own Sparse 1.3 solver, so the results don't depend on whether a build
 *   links KLU (plan P2 kickoff step 4).
 * - `gmin`: sim-core stamps `gmin` from every non-reference node to the island's reference, which the
 *   generator makes node 0 (SPICE ground). ngspice's `gmin` option only shunts semiconductor junctions.
 *   `.options rshunt=1e12` would shunt every node, including the deck's internal ones: each sense node
 *   `s<k>` sits at its element's `a` voltage, so a node with m elements would get (m + 1)·gmin instead
 *   of gmin, and each source's `e<k>` would get one sim-core doesn't have. So the deck stamps gmin
 *   explicitly on the circuit nodes only: a resistor of 1/gmin from each node to ground (`RG<n>`).
 *   `gmin=` is still set to the same value, for the record (it changes nothing in a linear deck).
 * - **Branch currents:** every element sits behind a 0 V sense source `VS<k>` from its `a` end, so
 *   `i(VS<k>)` is element k's current, positive from `a` to `b`, straight from ngspice's solution
 *   vector (ngspice reports no complex device currents in AC). A sense source changes no voltage.
 * - **Voltage sources** are `V<k>` (the EMF, + at the internal node `e<k>`) in series with `RI<k>` (the
 *   internal resistance) to `b`, or, with a series inductance (AC, F2.4), `RI<k>` to `m<k>` and `LI<k>`
 *   on to `b`.
 * - `noopac`: the AC analysis skips the DC operating point, which would be singular for a loop of
 *   inductors and is meaningless for a phasor circuit.
 * - **Printing:** `numdgt=17` prints 17 significant digits, enough to round-trip every double, so the
 *   1e-6 relative target is meaningful. Node voltages are printed as `v(<n>)` for n ≥ 1 and currents as
 *   `i(vs<k>)`, in order, ten to a line; AC values print as `re,im`.
 */

/** Names printed per `print` line, to keep lines short. */
const PRINT_CHUNK = 10;

/** The `.options` line every deck carries; the corpus header records it. */
export function oracleDeckOptions(): string {
  return `.options sparse gmin=${GMIN_S.value} noopac`;
}

/** The deck resistance of the explicit `gmin` shunt: 1/gmin, as `String` spells the double. */
export function gminShuntText(): string {
  return String(1 / GMIN_S.value);
}

function elementLines(ac: boolean, k: number, element: OracleElement): string[] {
  const s = `s${k}`;
  const sense = `VS${k} ${element.a} ${s} 0`;
  switch (element.kind) {
    case 'resistor':
      return [sense, `R${k} ${s} ${element.b} ${valueText(element.resistanceOhm)}`];
    case 'vsource': {
      const e = `e${k}`;
      const emf = valueText(element.emfV);
      // dc: the EMF; ac: no DC value, the phasor as magnitude (RMS) and angle (degrees).
      const spec = ac ? `DC 0 AC ${emf} ${element.angleDeg}` : `DC ${emf}`;
      const r = valueText(element.internalResistanceOhm);
      if (element.seriesInductanceH === undefined)
        return [sense, `V${k} ${e} ${s} ${spec}`, `RI${k} ${e} ${element.b} ${r}`];
      // A series inductance (F2.4) after the internal resistance, through a second internal node.
      const m = `m${k}`;
      return [
        sense,
        `V${k} ${e} ${s} ${spec}`,
        `RI${k} ${e} ${m} ${r}`,
        `LI${k} ${m} ${element.b} ${valueText(element.seriesInductanceH)}`,
      ];
    }
    case 'isource':
      return [sense, `I${k} ${s} ${element.b} DC ${valueText(element.currentA)}`];
    case 'inductor':
      return [sense, `L${k} ${s} ${element.b} ${valueText(element.inductanceH)}`];
    case 'capacitor':
      return [sense, `C${k} ${s} ${element.b} ${valueText(element.capacitanceF)}`];
  }
}

function printLines(names: readonly string[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < names.length; i += PRINT_CHUNK) lines.push(`print ${names.slice(i, i + PRINT_CHUNK).join(' ')}`);
  return lines;
}

/** The vector names ngspice prints for a circuit's node voltages, nodes 1 … n − 1. */
export function nodeVectorNames(circuit: OracleCircuit): string[] {
  return Array.from({ length: circuit.nodeCount - 1 }, (_, i) => `v(${i + 1})`);
}

/** The vector names ngspice prints for a circuit's branch currents: `i(vs<k>)`, the sense sources' currents. */
export function branchVectorNames(circuit: OracleCircuit): string[] {
  return circuit.elements.map((_, k) => `i(vs${k})`);
}

/** The deck text of `circuit`, LF line endings, ending in a newline. */
export function oracleDeck(circuit: OracleCircuit): string {
  const ac = circuit.domain === 'ac';
  const lines = [
    `controls oracle ${circuit.name}`,
    `* Generated (plan F2.7, ADR 0012): do not edit; regenerate with \`pnpm sim oracle regen\`. ${circuit.domain} seed ${circuit.seed} index ${circuit.index} nodes ${circuit.nodeCount} elements ${circuit.elements.length}`,
    oracleDeckOptions(),
  ];
  const shunt = gminShuntText();
  for (let n = 1; n < circuit.nodeCount; n++) lines.push(`RG${n} ${n} 0 ${shunt}`);
  circuit.elements.forEach((element, k) => lines.push(...elementLines(ac, k, element)));
  lines.push(
    '.control',
    'set numdgt=17',
    ac ? `ac lin 1 ${ORACLE_FREQUENCY_HZ} ${ORACLE_FREQUENCY_HZ}` : 'op',
    ...printLines(nodeVectorNames(circuit)),
    ...printLines(branchVectorNames(circuit)),
    '.endc',
    '.end',
  );
  return `${lines.join('\n')}\n`;
}
