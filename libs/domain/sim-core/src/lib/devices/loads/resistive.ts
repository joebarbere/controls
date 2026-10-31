import type { HeaterParams, ResistorParams } from '@controls/catalog';
import type { DeviceOutputField, DeviceOutputSchema } from '@controls/sim-protocol';
import type { LayerContext, SimDevice, SimDeviceBank, SimDeviceModel } from '../../engine/device-model';
import { branchReading, enumField, f64Field, READING_SOLVED, statusField } from '../readings';

/*
 * Fixed resistive loads (plan F2.5): the resistor and the heater. Each is one `resistor` element from
 * `a` to `b` whose value is a pure function of the catalogue entry (`DC_DEFAULT_VALUES` and
 * `AC_DEFAULT_VALUES` value it from the netlist values, so a solver run with no engine model gives
 * the same answer). Neither has sim-owned state; their engine models only publish records.
 *
 * - **Resistor:** R and a power rating. Its record says whether the solved dissipation I²R exceeds the
 *   rating (`overRated`); P2 has no damage model (no drift, no open circuit, no smoke), so an
 *   over-rated resistor keeps its value. `overRated` is a solved quantity: 0 unless `status` is solved.
 * - **Heater:** a resistance element rated in watts at a rated voltage, R = V_r² / P_r. Nichrome's
 *   temperature coefficient is about 1e-4 per kelvin, so the element's resistance moves by a few
 *   percent from cold to hot; P2 takes it as constant (the rated, hot value), which a heater's own
 *   nameplate figures already assume.
 *
 * On an AC island the record's voltage and current are RMS magnitudes, and the power is |I|² R.
 */

/** The resistance (Ω) of a heater rated `ratedPowerW` at `ratedVoltageV`: V² / P. */
export function heaterResistanceOhm(params: HeaterParams): number {
  return (params.ratedVoltageV * params.ratedVoltageV) / params.ratedPowerW;
}

const solvedFields = (): DeviceOutputField[] => [
  f64Field('voltageV', 0, 'V'),
  f64Field('currentA', 8, 'A'),
  f64Field('powerW', 16, 'W'),
];

/** The resistor's record: voltage, current and power (solved), `overRated` (solved, 0/1) and the status. */
export const RESISTOR_OUTPUT: DeviceOutputSchema = Object.freeze({
  kind: 'resistor',
  recordBytes: 32,
  fields: Object.freeze([...solvedFields(), enumField('overRated', 24, ['no', 'yes']), statusField(25)]),
});

/** The heater's record: voltage, current and power (solved) and the status. */
export const HEATER_OUTPUT: DeviceOutputSchema = Object.freeze({
  kind: 'heater',
  recordBytes: 32,
  fields: Object.freeze([...solvedFields(), statusField(24)]),
});

/**
 * Writes the solved voltage V(a) − V(b), current a → b and power I²R of `branch` (RMS magnitudes on an
 * AC island) at `offset`, and returns the power; 0 and nothing written unless the island is solved.
 */
function writeSolved(ctx: LayerContext, branch: number, ohms: number, view: DataView, offset: number): number {
  const element = ctx.netlist.branches[branch];
  const nodes = ctx.solution.nodes;
  const re = ctx.solution.branches[2 * branch];
  const im = ctx.solution.branches[2 * branch + 1];
  const vr = nodes[2 * element.a] - nodes[2 * element.b];
  const vi = nodes[2 * element.a + 1] - nodes[2 * element.b + 1];
  const i2 = re * re + im * im;
  const ac = ctx.netlist.islands[element.island].kind === 'ac';
  const power = i2 * ohms + 0;
  view.setFloat64(offset, (ac ? Math.sqrt(vr * vr + vi * vi) : vr) + 0, true);
  view.setFloat64(offset + 8, (ac ? Math.sqrt(i2) : re) + 0, true);
  view.setFloat64(offset + 16, power, true);
  return power;
}

export const RESISTOR_MODEL: SimDeviceModel = {
  kind: 'resistor',
  output: RESISTOR_OUTPUT,
  bank(devices: readonly SimDevice[]): SimDeviceBank {
    const branch = Int32Array.from(devices, (d) => d.branches[0]);
    const params = devices.map((d) => d.params as ResistorParams);
    return {
      bag: () => ({}),
      writeRecord: (i, view, offset, ctx) => {
        const status = branchReading(ctx, branch[i]);
        if (status === READING_SOLVED) {
          const power = writeSolved(ctx, branch[i], params[i].resistanceOhm, view, offset);
          view.setUint8(offset + 24, power > params[i].powerRatingW ? 1 : 0);
        }
        view.setUint8(offset + 25, status);
      },
    };
  },
};

export const HEATER_MODEL: SimDeviceModel = {
  kind: 'heater',
  output: HEATER_OUTPUT,
  bank(devices: readonly SimDevice[]): SimDeviceBank {
    const branch = Int32Array.from(devices, (d) => d.branches[0]);
    const ohms = Float64Array.from(devices, (d) => heaterResistanceOhm(d.params as HeaterParams));
    return {
      bag: () => ({}),
      writeRecord: (i, view, offset, ctx) => {
        const status = branchReading(ctx, branch[i]);
        if (status === READING_SOLVED) writeSolved(ctx, branch[i], ohms[i], view, offset);
        view.setUint8(offset + 24, status);
      },
    };
  },
};
