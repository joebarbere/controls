import type { DeviceOutputSchema } from '@controls/sim-protocol';
import type { SimDevice, SimDeviceBank, SimDeviceModel } from '../../engine/device-model';
import {
  f64Field,
  READING_SOLVED,
  READING_UNSOLVED,
  readingStatusCode,
  statusField,
  writeAmps,
  writeVolts,
} from '../readings';

/*
 * The ground rod's engine model (engine 8, D5; its record is protocol 8's, ADR 0011's protocol 8
 * amendment). The rod has no state and no element of its own: its acorn clamp reaches remote earth
 * through the compiler's `earth` contact (`electrode`, of the entry's `earthResistanceOhm`, ADR 0021
 * §3), so the bank exists only to publish the record:
 *
 * - `currentA`: |I| through the earth link (RMS on AC), the current the rod puts into the soil;
 * - `touchVoltageV`: |V(clamp) − V(remote earth)|, the rod's potential rise against remote earth (the
 *   link's own drop, ADR 0019's `touchVoltageV`).
 *
 * Both are readings only on a solved island (the validity rule); the clamp and remote earth are always
 * on one island, the link joining them. A rod whose link didn't compile (never, for a netlisted rod)
 * reads `unsolved`.
 */

const GROUND_ROD_OUTPUT: DeviceOutputSchema = {
  kind: 'electrode.groundRod',
  recordBytes: 24,
  fields: [f64Field('currentA', 0, 'A'), f64Field('touchVoltageV', 8, 'V'), statusField(16)],
};

/** `electrode.groundRod`: its record only (no state, no values: the link is a `contact` resistor). */
export const GROUND_ROD_MODEL: SimDeviceModel = {
  kind: 'electrode.groundRod',
  output: GROUND_ROD_OUTPUT,
  bank(devices: readonly SimDevice[]): SimDeviceBank {
    const electrode = new Int32Array(devices.length).fill(-1);
    devices.forEach((d, i) => {
      for (const c of d.contacts) if (c.relation === 'earth' && c.contact === 'electrode') electrode[i] = c.branch;
    });
    return {
      bag: () => ({}),
      writeRecord: (i, view, offset, ctx) => {
        const b = electrode[i];
        if (b < 0) {
          view.setUint8(offset + 16, READING_UNSOLVED);
          return;
        }
        const branch = ctx.netlist.branches[b];
        const status = readingStatusCode(ctx.islandStatus(branch.island));
        view.setUint8(offset + 16, status);
        if (status !== READING_SOLVED) return;
        writeAmps(ctx.solution.branches, b, view, offset);
        // The link runs from the clamp (end a) to remote earth (end b).
        writeVolts(ctx.solution.nodes, branch.a, branch.b, view, offset + 8);
      },
    };
  },
};
