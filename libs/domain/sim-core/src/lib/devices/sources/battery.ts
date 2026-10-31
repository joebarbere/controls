import type { BatteryParams } from '@controls/catalog';
import type { DeviceOutputSchema } from '@controls/sim-protocol';
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
 * chapters; the catalogue entry's `lead-acid-open-circuit-voltage` source). So
 *
 *   E(s) = E_empty + (E_full − E_empty) · s,   s ∈ [0, 1],
 *
 * 12.9 V full and 11.8 V empty for the catalogue's VRLA monobloc. A battery resting at 12.0 V is about
 * 18 % charged on this line (published state-of-charge charts put it nearer 25 %: the real curve sags
 * towards empty), so the nominal 12 V is a name, never an EMF.
 *
 * **Coulomb counting.** Each step, with I the cell's current (a → b, positive while discharging, from
 * the last solution) and Q the capacity in A·h,
 *
 *   s ← s − I · Δt / (3600 · Q),   clamped to [0, 1].
 *
 * Only a solved island counts (an unsolved island's zeros are not a current).
 *
 * **Abstractions** (recorded in the simulation caveats, for `electrical-realism-reviewer`):
 *
 * - the internal resistance is the full-charge figure at every state of charge (it rises as a real
 *   battery empties) and a 1 kHz tester's figure used as a DC resistance (the catalogue says so);
 * - capacity doesn't depend on the discharge rate (Peukert's effect is ignored), nor on temperature;
 * - charging is counted at 100 % coulombic efficiency, with no gassing or absorption stage, and stops
 *   at full;
 * - below empty (s = 0) the EMF stays at E_empty: deep discharge, sulphation and the voltage collapse
 *   of a flat battery are not modelled (a later fault and wear feature);
 * - the EMF follows s at once: the surface charge and the recovery of a rested cell are ignored.
 */

/** Seconds per hour: A·h to coulombs. */
const SECONDS_PER_HOUR = 3600;

/** The open-circuit EMF (V) of a battery with `params` at state of charge `soc` (clamped to [0, 1]). */
export function batteryEmfV(params: BatteryParams, soc: number): number {
  const s = soc < 0 ? 0 : soc > 1 ? 1 : soc;
  return params.openCircuitVoltageEmptyV + (params.openCircuitVoltageFullV - params.openCircuitVoltageEmptyV) * s;
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
        values.vsource(b.index, batteryEmfV(params[i], soc[i]), ohms[i]);
        return true;
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
