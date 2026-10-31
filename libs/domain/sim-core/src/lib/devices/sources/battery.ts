import type { BatteryParams } from '@controls/catalog';
import type { DeviceOutputSchema } from '@controls/sim-protocol';
import type { SourcedConstant } from '../../constants';
import type { SimDevice, SimDeviceBank, SimDeviceModel } from '../../engine/device-model';
import { branchReading, f64Field, READING_SOLVED, statusField } from '../readings';

/*
 * The battery (plan F2.4): one cell element from `neg` to `pos` (F2.1's netlist model), an EMF that
 * follows the state of charge, behind a constant internal resistance, and coulomb counting in the
 * continuous layer. The state of charge is the only sim-owned value (`stateOfCharge` in the `sim` bag,
 * ADR 0011 §1), so a save or a topology change carries it exactly.
 *
 * **EMF against state of charge.** A rested lead-acid cell's open-circuit voltage is close to linear
 * in its state of charge: it is about the electrolyte's specific gravity plus 0.84 V, and the specific
 * gravity falls about linearly as the acid is used (Linden's Handbook of Batteries, lead-acid
 * chapters; the catalogue entry's `lead-acid-open-circuit-voltage` source). So, above the last
 * `BATTERY_COLLAPSE_SOC` of charge,
 *
 *   E(s) = E_empty + (E_full − E_empty) · s,
 *
 * 12.9 V full and 11.8 V empty for the catalogue's VRLA monobloc. A battery resting at 12.0 V is about
 * 18 % charged on this line (published state-of-charge charts put it nearer 25 %: the real curve sags
 * towards empty), so the nominal 12 V is a name, never an EMF.
 *
 * **A flat battery collapses** (`electrical-realism-reviewer`, F2.4 review): below s_c =
 * `BATTERY_COLLAPSE_SOC` the EMF falls linearly from E(s_c) to 0 V at s = 0, so a discharge slows as
 * the battery empties and stops at empty: it never delivers charge it doesn't have. Shorted through two
 * test leads, the last 2 % drains with a time constant of about 5 s.
 *
 * **A full battery stops accepting charge.** A charging lead-acid cell's voltage rises above its rest
 * voltage towards gassing (about 2.4 V per cell, 14.4 V for six) as it fills, so a charger at a fixed
 * voltage sees the current taper. Modelled as a charge EMF E_c(s) = E(s) up to s_a =
 * `BATTERY_ABSORPTION_SOC`, then rising linearly to the gassing voltage at s = 1. The cell is then a
 * piecewise-linear element, monotone in its terminal voltage V:
 *
 * - V ≤ E(s): discharging (or at rest), EMF E(s) behind R;
 * - V ≥ E_c(s): charging, EMF E_c(s) behind R;
 * - in between (only above s_a): no current, the charger's voltage is below what the battery needs.
 *
 * The outer loop picks the segment from its iterate's V (the `iterate` hook), so a full battery on a
 * 13.8 V float supply settles at no current, and only a source above 14.4 V keeps pushing charge in
 * (the state of charge then clamps at 1: overcharge and gassing losses aren't modelled). The segment is
 * a function of the iterate alone, so nothing about it needs to be in the `sim` bag.
 *
 * **Coulomb counting.** Each step, with I the cell's current (a → b, positive while discharging, from
 * the last solution) and Q the capacity in A·h,
 *
 *   s ← s − I · Δt / (3600 · Q),   clamped to [0, 1].
 *
 * Only a solved island counts (an unsolved or unsettled island's values are not a current).
 *
 * **Abstractions** (recorded in the simulation caveats, for `electrical-realism-reviewer`):
 *
 * - the internal resistance is the full-charge figure at every state of charge (it rises as a real
 *   battery empties) and a 1 kHz tester's figure used as a DC resistance (the catalogue says so);
 * - capacity doesn't depend on the discharge rate (Peukert's effect): the model's capacity is
 *   optimistic by about 20 % at C/5, 40 % at C/2 and roughly 70 % at 1C (at 0.7C a real 7 Ah VRLA is
 *   near its cutoff within the hour, where this one has used 71 %); nor on temperature;
 * - charging is counted at 100 % coulombic efficiency, and the charge EMF is a straight line to
 *   gassing, not a measured charge curve. There is no charge overpotential, so bulk charge reads low
 *   and runs fast (a half-charged battery taking 5 A reads about 12.47 V; a stiff source drives about
 *   9C), a 13.8 V float charges only to about 93 %, and overcharge is limited by the internal
 *   resistance alone (about 26 A at 15 V, where a real battery takes C/50 to C/20);
 * - the EMF follows s at once: the surface charge and the recovery of a rested cell are ignored;
 *   sulphation and wear are a later fault and wear feature.
 */

/** Seconds per hour: A·h to coulombs. */
const SECONDS_PER_HOUR = 3600;

/** Below this state of charge a flat battery's EMF collapses linearly to 0 V at empty. */
export const BATTERY_COLLAPSE_SOC: SourcedConstant = {
  value: 0.02,
  unit: '1',
  kind: 'game-design',
  source:
    "game-design: the last 2 % of capacity, over which a flat cell's voltage falls away (a lead-acid cell past its end-of-discharge voltage collapses steeply as the acid at the plates runs out; Linden's Handbook of Batteries, lead-acid discharge curves, paraphrased). Its job is that a flat battery stops delivering charge; the shape of the knee is not modelled.",
};

/** Above this state of charge a charging battery's EMF rises towards the gassing voltage. */
export const BATTERY_ABSORPTION_SOC: SourcedConstant = {
  value: 0.8,
  unit: '1',
  kind: 'game-design',
  source:
    "game-design inside published behaviour: lead-acid charging moves from the bulk (constant-current) stage to the absorption (constant-voltage) stage at roughly 80 % charge, where the charge voltage approaches gassing and the current tapers (VRLA manufacturers' charging guides, paraphrased). The rise is modelled as a straight line to the gassing voltage at full.",
};

/** A lead-acid cell's gassing voltage, per 2 V nominal cell. */
export const LEAD_ACID_GASSING_V_PER_CELL: SourcedConstant = {
  value: 2.4,
  unit: 'V',
  kind: 'real-world',
  source:
    "About 2.4 V per cell at 25 °C, where a lead-acid cell begins to gas: the usual absorption-charge limit for VRLA batteries (14.4 V for a 12 V, six-cell monobloc). VRLA manufacturers' charging guides and Linden's Handbook of Batteries, paraphrased.",
};

/**
 * The open-circuit EMF (V) of a battery with `params` at state of charge `soc` (clamped to [0, 1]):
 * linear above `BATTERY_COLLAPSE_SOC`, collapsing linearly to 0 V at empty below it.
 */
export function batteryEmfV(params: BatteryParams, soc: number): number {
  const s = soc < 0 ? 0 : soc > 1 ? 1 : soc;
  const c = BATTERY_COLLAPSE_SOC.value;
  const span = params.openCircuitVoltageFullV - params.openCircuitVoltageEmptyV;
  if (s >= c) return params.openCircuitVoltageEmptyV + span * s;
  return ((params.openCircuitVoltageEmptyV + span * c) * s) / c;
}

/** The gassing voltage (V) of a lead-acid battery: 2.4 V per 2 V nominal cell. */
export function batteryGassingV(params: BatteryParams): number {
  return (params.nominalVoltageV / 2) * LEAD_ACID_GASSING_V_PER_CELL.value;
}

/**
 * The EMF (V) a charging battery presents at state of charge `soc`: E(s) up to
 * `BATTERY_ABSORPTION_SOC`, then rising linearly to the gassing voltage at full.
 */
export function batteryChargeEmfV(params: BatteryParams, soc: number): number {
  const s = soc < 0 ? 0 : soc > 1 ? 1 : soc;
  const a = BATTERY_ABSORPTION_SOC.value;
  if (s <= a) return batteryEmfV(params, s);
  return batteryEmfV(params, s) + ((batteryGassingV(params) - params.openCircuitVoltageFullV) * (s - a)) / (1 - a);
}

/**
 * The battery's output record (ADR 0011 §5.4, amended in F2.4): the EMF and the state of charge (its
 * own state, always written), the terminal voltage V(pos) − V(neg) and the discharge current (solved:
 * 0 unless `status` is `solved`), and the reading status (`readings.ts`).
 */
export const BATTERY_OUTPUT: DeviceOutputSchema = Object.freeze({
  kind: 'battery',
  recordBytes: 40,
  fields: Object.freeze([
    f64Field('emfV', 0, 'V'),
    f64Field('terminalV', 8, 'V'),
    f64Field('currentA', 16, 'A'),
    f64Field('stateOfCharge', 24, null),
    statusField(32),
  ]),
});

export const BATTERY_MODEL: SimDeviceModel = {
  kind: 'battery',
  output: BATTERY_OUTPUT,
  bank(devices: readonly SimDevice[]): SimDeviceBank {
    const n = devices.length;
    const soc = new Float64Array(n);
    const branch = new Int32Array(n);
    const ohms = new Float64Array(n);
    // Coulombs per unit of state of charge, Q · 3600.
    const coulombs = new Float64Array(n);
    // Each solve's discharge and charge EMFs, E(s) and E_c(s), set in `dcValue` and read by `iterate`.
    const emf = new Float64Array(n);
    const chargeEmf = new Float64Array(n);
    const params = devices.map((d) => d.params as BatteryParams);
    devices.forEach((d, i) => {
      // A loaded world's bag is validated (a number in [0, 1]); a hand-built one may lack the key (the
      // bench plant's `sim: {}`), which starts at the kind's initial value: a new, full battery.
      const s = d.bag['stateOfCharge'];
      soc[i] = typeof s === 'number' ? s : 1;
      branch[i] = d.branches[0];
      ohms[i] = params[i].internalResistanceOhm;
      coulombs[i] = params[i].capacityAh * SECONDS_PER_HOUR;
    });
    return {
      bag: (i) => ({ stateOfCharge: soc[i] }),
      dcValue: (i, b, values) => {
        emf[i] = batteryEmfV(params[i], soc[i]);
        chargeEmf[i] = batteryChargeEmfV(params[i], soc[i]);
        values.vsourceAt(b.index, emf, ohms, i);
        return true;
      },
      // The cell's segment from the iterate's terminal voltage (see the header): discharge (E behind R),
      // charge (E_c behind R) or, between the two, no current. A cold start begins on discharge.
      iterate: (i, b, iterate, values) => {
        const k = b.index;
        const v = iterate === null ? emf[i] : iterate.nodes[2 * b.b] - iterate.nodes[2 * b.a];
        if (v <= emf[i]) values.vsourceAt(k, emf, ohms, i);
        else if (v >= chargeEmf[i]) values.vsourceAt(k, chargeEmf, ohms, i);
        else values.isource(k, 0);
      },
      continuous: (ctx) => {
        const branches = ctx.solution.branches;
        for (let i = 0; i < n; i++) {
          if (!ctx.islandReadable(ctx.netlist.branches[branch[i]].island)) continue;
          const next = soc[i] - (branches[2 * branch[i]] * ctx.dtS) / coulombs[i];
          // `+ 0` keeps −0 out of the bag (every stored value is finite and −0 is +0, ADR 0011 §5.3).
          soc[i] = (next < 0 ? 0 : next > 1 ? 1 : next) + 0;
        }
      },
      writeRecord: (i, view, offset, ctx) => {
        const b = branch[i];
        const status = branchReading(ctx, b);
        view.setFloat64(offset, batteryEmfV(params[i], soc[i]), true);
        if (status === READING_SOLVED) {
          const element = ctx.netlist.branches[b];
          const nodes = ctx.solution.nodes;
          view.setFloat64(offset + 8, nodes[2 * element.b] - nodes[2 * element.a] + 0, true);
          view.setFloat64(offset + 16, ctx.solution.branches[2 * b] + 0, true);
        }
        view.setFloat64(offset + 24, soc[i], true);
        view.setUint8(offset + 32, status);
      },
    };
  },
};
