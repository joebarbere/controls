import { PHASOR_ANGLES, type PhasorAngle, phasorUnit } from '../lib/mna/phasor';

/*
 * The oracle's intermediate representation (plan F2.7, decision D5, ADR 0012): one linear circuit,
 * from which both a SPICE deck (`deck.ts`) and a sim-core netlist (`netlist.ts`) are emitted, so the
 * two can never describe different circuits.
 *
 * Node 0 is the reference node: SPICE ground, and the node sim-core takes as the island's reference
 * (the negative end of its first voltage source in branch order, else its smallest node). Nodes
 * 1 … nodeCount − 1 are the unknowns. Every element runs from node `a` to node `b`, and its current is
 * positive from `a` to `b` through the element, as in F2.1's `NetlistBranch`.
 *
 * Every value is a decimal `mantissa × 10^exponent` with an integer mantissa, so the deck's text and
 * the netlist's number are the same decimal: `Number(text)` is the correctly rounded double.
 */

/** Which analysis a circuit is for. */
export type OracleDomain = 'dc' | 'ac';

export const ORACLE_DOMAINS: readonly OracleDomain[] = ['dc', 'ac'];

/** A decimal value `mantissa × 10^exponent`; `text` is its deck spelling (`47e2`). */
export interface OracleValue {
  readonly mantissa: number;
  readonly exponent: number;
}

/** The deck spelling of a value: `47e2`, `33e-4`. */
export function valueText(value: OracleValue): string {
  return `${value.mantissa}e${value.exponent}`;
}

/** The value as a double: the correctly rounded `Number` of its text. */
export function valueNumber(value: OracleValue): number {
  return Number(valueText(value));
}

/**
 * A phasor source's angle in degrees: only the angles whose cosine and sine are exact constants
 * (decision D6), the angles of a split-phase or three-phase supply. The solver's own definitions
 * (`lib/mna/phasor.ts`), re-exported so the corpus and the solver can't disagree.
 */
export { PHASOR_ANGLES, type PhasorAngle, phasorUnit };

/** A resistor, `a` → `b`. */
export interface OracleResistor {
  readonly kind: 'resistor';
  readonly a: number;
  readonly b: number;
  readonly resistanceOhm: OracleValue;
}

/**
 * A voltage source from `a` (negative) to `b` (positive) behind a series internal resistance, the
 * F2.1 `vsource`: `V(b) − V(a) = emf − I · r`, with `I` positive from `a` to `b` through the source.
 * In the `ac` domain `emfV` is the phasor's magnitude (RMS) and `angleDeg` its angle, and the source may
 * have a series inductance; in `dc`, `angleDeg` is 0 and the EMF is `emfV`.
 */
export interface OracleVoltageSource {
  readonly kind: 'vsource';
  readonly a: number;
  readonly b: number;
  readonly emfV: OracleValue;
  readonly angleDeg: PhasorAngle;
  readonly internalResistanceOhm: OracleValue;
  /**
   * AC only (F2.4): a series inductance behind the internal resistance, a utility transformer's or a
   * generator's source reactance, so `V(b) − V(a) = emf − I · (r + jωL)`. Absent for a purely
   * resistive source.
   */
  readonly seriesInductanceH?: OracleValue;
}

/** An ideal current source pushing `currentA` from `a` to `b` through itself (DC only). */
export interface OracleCurrentSource {
  readonly kind: 'isource';
  readonly a: number;
  readonly b: number;
  readonly currentA: OracleValue;
}

/** An ideal inductor, `a` → `b` (AC only). */
export interface OracleInductor {
  readonly kind: 'inductor';
  readonly a: number;
  readonly b: number;
  readonly inductanceH: OracleValue;
}

/** An ideal capacitor, `a` → `b` (AC only). */
export interface OracleCapacitor {
  readonly kind: 'capacitor';
  readonly a: number;
  readonly b: number;
  readonly capacitanceF: OracleValue;
}

export type OracleElement =
  OracleResistor | OracleVoltageSource | OracleCurrentSource | OracleInductor | OracleCapacitor;

export type OracleElementKind = OracleElement['kind'];

/** One generated circuit of the corpus. */
export interface OracleCircuit {
  /** `dc-0042`: the domain and the index, zero-padded; the deck's file stem. */
  readonly name: string;
  readonly domain: OracleDomain;
  /** The corpus seed it was drawn from (ADR 0012) and its index in the corpus. */
  readonly seed: number;
  readonly index: number;
  /** Nodes, including the reference node 0: 2 … 30. */
  readonly nodeCount: number;
  /** Elements in branch order: element k is sim-core branch k and deck element k. */
  readonly elements: readonly OracleElement[];
}

/** The AC analysis frequency (Hz): the NEC region's 60 Hz (plan §4.5), the only P2 frequency. */
export const ORACLE_FREQUENCY_HZ = 60;
