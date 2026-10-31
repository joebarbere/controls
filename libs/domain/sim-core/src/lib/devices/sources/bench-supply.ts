import type { BenchSupplyParams } from '@controls/catalog';
import type { DeviceOutputSchema } from '@controls/sim-protocol';
import type { SimDevice, SimDeviceBank, SimDeviceModel } from '../../engine/device-model';
import {
  branchReading,
  enumField,
  f64Field,
  READING_SINGULAR,
  READING_SOLVED,
  READING_UNSOLVED,
  statusField,
} from '../readings';
import { iterateRegulated, REG_CC, REG_CV, RegulatorSettings, stampedMode, stampRegulated } from './regulator';

/*
 * The bench DC supply (plan F2.4, kind `supply.bench`): a CV/CC regulated output (`regulator.ts`)
 * between `neg` and `pos`, whose voltage setpoint, current limit and output switch are the player's
 * (`device.operate`: `setpointV`, `currentLimitA`, `outputOn`, commanded state). They reach the solver
 * as the output element's netlist values, so changing one is a value change (same `topologyHash`,
 * plan F2.1) that the engine re-solves at the command's tick. The regulation mode is sim-owned
 * (`mode`, `cv` or `cc`, in the `sim` bag) and published in the device record.
 *
 * - **Output off:** the element is an open circuit, a current source of 0 A. The mode resets to CV,
 *   so switching the output on starts regulating voltage, as a real supply comes up.
 * - **Output resistance:** the catalogue's `outputResistanceOhm` (1 mΩ, from the class's CV load
 *   regulation), never 0: two supplies paralleled in CV are a resistive loop that the CV/CC loop
 *   settles, never an ideal-source loop (`singular`).
 * - **CC:** an ideal current source: no CC load regulation (an infinite output resistance in CC). Its
 *   compliance is the setpoint, through
 *   the CC → CV test.
 */

/** The record's `mode` values, by code. */
export const BENCH_SUPPLY_MODES = Object.freeze(['off', 'cv', 'cc'] as const);
const MODE_OFF = 0;

/**
 * The bench supply's output record (ADR 0011 §5.4, finalised in F2.4): the output voltage V(pos) −
 * V(neg) and current (out of `pos`), solved (0 unless `status` is `solved`); the mode (`off` when the
 * output is switched off, else the regulation mode, its own state); and the reading status. A reader
 * shows an `unsettled` supply's mode and values as unsettled (`readings.ts`).
 */
export const BENCH_SUPPLY_OUTPUT: DeviceOutputSchema = Object.freeze({
  kind: 'supply.bench',
  recordBytes: 24,
  fields: Object.freeze([
    f64Field('outputV', 0, 'V'),
    f64Field('outputA', 8, 'A'),
    enumField('mode', 16, BENCH_SUPPLY_MODES),
    statusField(17),
  ]),
});

const SIM_MODES = ['cv', 'cc'] as const;

export const BENCH_SUPPLY_MODEL: SimDeviceModel = {
  kind: 'supply.bench',
  output: BENCH_SUPPLY_OUTPUT,
  bank(devices: readonly SimDevice[]): SimDeviceBank {
    const n = devices.length;
    const mode = new Uint8Array(n);
    const branch = new Int32Array(n);
    // The setpoint and limit are controls (the branch's netlist values), copied in by `dcValue`.
    const settings = new RegulatorSettings(n);
    devices.forEach((d, i) => {
      const m = d.bag['mode'];
      // The load check (`checkBags`) only lets `cv` and `cc` in: anything else is a programming error.
      if (m !== 'cv' && m !== 'cc') throw new Error(`supply.bench ${d.entity}: unknown mode ${String(m)}`);
      mode[i] = m === 'cc' ? REG_CC : REG_CV;
      branch[i] = d.branches[0];
      settings.ohms[i] = (d.params as BenchSupplyParams).outputResistanceOhm;
    });
    return {
      bag: (i) => ({ mode: SIM_MODES[mode[i]] }),
      dcValue: (i, b, values) => {
        const v = b.values;
        settings.setpointV[i] = v['setpointV'];
        settings.limitA[i] = v['currentLimitA'];
        if (v['outputOn'] !== 1) values.isource(b.index, 0);
        else stampRegulated(values, b.index, mode[i], settings, i);
        return true;
      },
      iterate: (i, b, iterate, values) => {
        const v = b.values;
        settings.setpointV[i] = v['setpointV'];
        settings.limitA[i] = v['currentLimitA'];
        if (v['outputOn'] !== 1) values.isource(b.index, 0);
        else iterateRegulated(b, iterate, values, mode[i], settings, i);
      },
      afterSolve: (ctx, values) => {
        for (let i = 0; i < n; i++) {
          const b = branch[i];
          if (ctx.netlist.branches[b].values['outputOn'] !== 1) {
            mode[i] = REG_CV;
            continue;
          }
          // Commit only what a solve decided: an unsolved or singular island's stamps decided nothing.
          // Defensive today: there the stamps are still the bank's own mode (from `dcValue`), so
          // committing them would change nothing; it guards a future solver that leaves other stamps.
          const status = branchReading(ctx, b);
          if (status === READING_UNSOLVED || status === READING_SINGULAR) continue;
          mode[i] = stampedMode(values, b);
        }
      },
      writeRecord: (i, view, offset, ctx) => {
        const b = branch[i];
        const element = ctx.netlist.branches[b];
        const status = branchReading(ctx, b);
        if (status === READING_SOLVED) {
          const nodes = ctx.solution.nodes;
          view.setFloat64(offset, nodes[2 * element.b] - nodes[2 * element.a] + 0, true);
          view.setFloat64(offset + 8, ctx.solution.branches[2 * b] + 0, true);
        }
        view.setUint8(offset + 16, element.values['outputOn'] === 1 ? mode[i] + 1 : MODE_OFF);
        view.setUint8(offset + 17, status);
      },
    };
  },
};
