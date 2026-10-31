import type { DinPsuParams } from '@controls/catalog';
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
import { iterateRegulated, REG_CC, REG_CV, stampedMode, stampRegulated } from './regulator';

/*
 * The DIN-rail switch-mode supply (plan F2.4, kind `supply.dinPsu`): a fixed `ratedVoltageV` behind
 * `outputResistanceOhm`, with a current limit at `currentLimitA` (`regulator.ts`), and **hiccup
 * mode**: an overload that holds the output in current limit for `hiccupDetectMs` switches it off for
 * `hiccupOffMs`, then it retries. A short circuit therefore hiccups with a period of
 * `hiccupDetectMs + hiccupOffMs` ticks, exactly (1 tick = 1 ms):
 *
 * - a command shorts the output at tick T0; its solve finds the limit (`mode` `limit`);
 * - the protection layer counts each step spent in limit (`phaseTicks`); the step that reaches
 *   `hiccupDetectMs` (step T0 + D − 1) switches the output off (`hiccupOff`, an open circuit) and raises
 *   `hiccup {phase: 'off'}`; the engine re-solves within that step, so the state at T0 + D is off;
 * - it counts each step off; the step that reaches `hiccupOffMs` switches back to regulating (`ok`)
 *   and raises `hiccup {phase: 'retry'}`; the re-solve at T0 + D + F finds the short again.
 *
 * An overload that clears (the load drops back under the limit) resets the count. The timer runs on
 * sim ticks only (never the wall clock), so the period is the same headless and in the worker. Its
 * values are game-design choices inside the class's published behaviour (the catalogue's sources).
 *
 * State: `mode` (`ok`, `limit`, `hiccupOff`) and `phaseTicks` in the `sim` bag, both needed for the
 * future, so a save mid-hiccup resumes the same period (the save-and-load property). There is no AC
 * input in P2 (the supply is always powered); P4's load centre feeds it.
 */

/** The supply's modes, by code: in the `sim` bag and the record. */
export const DIN_PSU_MODES = Object.freeze(['ok', 'limit', 'hiccupOff'] as const);
const MODE_OK = 0;
const MODE_LIMIT = 1;
const MODE_OFF = 2;

/** The `hiccup` events' detail (ADR 0011 §4). */
const HICCUP_OFF = Object.freeze({ phase: 'off' });
const HICCUP_RETRY = Object.freeze({ phase: 'retry' });

/**
 * The DIN PSU's output record (ADR 0011 §5.4, finalised in F2.4): the output voltage and current
 * (solved: 0 unless `status` is `solved`), its mode (its own state) and the reading status.
 */
export const DIN_PSU_OUTPUT: DeviceOutputSchema = Object.freeze({
  kind: 'supply.dinPsu',
  recordBytes: 24,
  fields: Object.freeze([
    f64Field('outputV', 0, 'V'),
    f64Field('outputA', 8, 'A'),
    enumField('mode', 16, DIN_PSU_MODES),
    statusField(17),
  ]),
});

export const DIN_PSU_MODEL: SimDeviceModel = {
  kind: 'supply.dinPsu',
  output: DIN_PSU_OUTPUT,
  bank(devices: readonly SimDevice[]): SimDeviceBank {
    const n = devices.length;
    const mode = new Uint8Array(n);
    const phase = new Float64Array(n);
    const branch = new Int32Array(n);
    const entity = new Int32Array(n);
    const params = devices.map((d) => d.params as DinPsuParams);
    devices.forEach((d, i) => {
      const m = DIN_PSU_MODES.indexOf(d.bag['mode'] as (typeof DIN_PSU_MODES)[number]);
      mode[i] = m < 0 ? MODE_OK : m;
      phase[i] = d.bag['phaseTicks'] as number;
      branch[i] = d.branches[0];
      entity[i] = d.entity;
    });
    const regulation = (i: number) => (mode[i] === MODE_LIMIT ? REG_CC : REG_CV);
    return {
      bag: (i) => ({ mode: DIN_PSU_MODES[mode[i]], phaseTicks: phase[i] }),
      dcValue: (i, b, values) => {
        const p = params[i];
        if (mode[i] === MODE_OFF) values.isource(b.index, 0);
        else stampRegulated(values, b.index, regulation(i), p.ratedVoltageV, p.currentLimitA, p.outputResistanceOhm);
        return true;
      },
      iterate: (i, b, iterate, values) => {
        const p = params[i];
        if (mode[i] === MODE_OFF) values.isource(b.index, 0);
        else
          iterateRegulated(b, iterate, values, regulation(i), p.ratedVoltageV, p.currentLimitA, p.outputResistanceOhm);
      },
      afterSolve: (ctx, values) => {
        for (let i = 0; i < n; i++) {
          if (mode[i] === MODE_OFF) continue;
          const status = branchReading(ctx, branch[i]);
          if (status === READING_UNSOLVED || status === READING_SINGULAR) continue;
          mode[i] = stampedMode(values, branch[i]) === REG_CC ? MODE_LIMIT : MODE_OK;
        }
      },
      protection: (ctx) => {
        let changed = false;
        for (let i = 0; i < n; i++) {
          if (mode[i] === MODE_OK) {
            phase[i] = 0;
          } else if (mode[i] === MODE_LIMIT) {
            // Only a solved island's limit is an overload (an unsettled one may be noise).
            if (!ctx.islandReadable(ctx.netlist.branches[branch[i]].island)) continue;
            phase[i]++;
            if (phase[i] >= params[i].hiccupDetectMs) {
              mode[i] = MODE_OFF;
              phase[i] = 0;
              ctx.emit('hiccup', entity[i], HICCUP_OFF);
              changed = true;
            }
          } else {
            phase[i]++;
            if (phase[i] >= params[i].hiccupOffMs) {
              mode[i] = MODE_OK;
              phase[i] = 0;
              ctx.emit('hiccup', entity[i], HICCUP_RETRY);
              changed = true;
            }
          }
        }
        return changed;
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
        view.setUint8(offset + 16, mode[i]);
        view.setUint8(offset + 17, status);
      },
    };
  },
};
