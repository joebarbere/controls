import type { ServiceSplitPhaseParams } from '@controls/catalog';
import type { DeviceOutputSchema } from '@controls/sim-protocol';
import type { SimDevice, SimDeviceBank, SimDeviceModel } from '../../engine/device-model';
import { AC_STAMP_RESISTOR, AC_STAMP_VSOURCE, AcBranchValues } from '../../mna/ac-values';
import { f64Field, READING_SOLVED, readingStatusCode, statusField, writeAmps, writeVolts } from '../readings';
import { splitPhaseTEquivalent } from './ac-source';
import { serviceDropOhm } from './netlist-models';

/*
 * The utility service (engine 8, D4 and D5, ADR 0021): `service.splitPhase`, the pole transformer, the
 * service drop and the meter base as one entity, whose terminals are the meter base's load-side lugs
 * (`l1`, `l2`, `n`) and the transformer's neutral bushing at the pole (`x0`, which nothing can reach:
 * the entry declares it `access: 'none'`).
 *
 * - **The transformer** is the split-phase T-equivalent (`splitPhaseTEquivalent`): two windings from
 *   `x0`, L1 at 0° and L2 at 180°, each behind Z_LN on its own current and the neutral arm Z_n on the
 *   other's (the coupled 2 × 2 block, `AcBranchValues.couple`; no negative element).
 * - **The drop** is three conductors of `dropLengthMm`: each line conductor's resistance is in series
 *   with its winding (added to the winding's own R, exactly what a series resistor between the winding
 *   and the lug would do, with no node between), and the neutral's is a resistor element `dropN` from
 *   `x0` to `n`. Each is ρ · L / A · (1 + α (T − T₀)) at the game's ambient (`serviceDropOhm`), never a
 *   table; no thermal node and no reactance in P4 (labelled abstractions, ADR 0021).
 * - **The utility's neutral grounding** is an earth link from `x0` to remote earth of
 *   `utilityGroundingOhm` (the compiler's `earth` contact): the return path of any current that reaches
 *   earth elsewhere (a ground rod), in parallel with the service's own electrode through the drop
 *   neutral (the plan's R_utility ∥ R_service-rod).
 *
 * The windings and the drop neutral are AC elements valued by the bank; the island's reference is
 * `x0` (the negative end of its first source).
 *
 * **Its record** (protocol 8): the line currents `l1CurrentA`, `l2CurrentA` (each winding's, through its
 * drop conductor), the drop neutral's `neutralCurrentA`, the utility grounding's `groundingCurrentA`
 * (x0 to remote earth), and at the meter base's lugs `l1NeutralV`, `l2NeutralV` and `lineToLineV`: all
 * RMS magnitudes, readings only on a solved island (the validity rule). The netlist models (`serviceSplitPhaseNetlistModel`,
 * `groundRodNetlistModel`) and `serviceDropOhm` are in `netlist-models.ts`, which imports no solver.
 */

const SERVICE_OUTPUT: DeviceOutputSchema = {
  kind: 'service.splitPhase',
  recordBytes: 64,
  fields: [
    f64Field('l1CurrentA', 0, 'A'),
    f64Field('l2CurrentA', 8, 'A'),
    f64Field('neutralCurrentA', 16, 'A'),
    f64Field('groundingCurrentA', 24, 'A'),
    f64Field('l1NeutralV', 32, 'V'),
    f64Field('l2NeutralV', 40, 'V'),
    f64Field('lineToLineV', 48, 'V'),
    statusField(56),
  ],
};

/** The service's engine model: its windings' phasor values (the coupled block plus the line drop) and the drop neutral. */
export const SERVICE_SPLIT_PHASE_MODEL: SimDeviceModel = {
  kind: 'service.splitPhase',
  output: SERVICE_OUTPUT,
  bank(devices: readonly SimDevice[]): SimDeviceBank {
    // Every value is fixed for the bank's life: worked out once (validated through a scratch value set)
    // and copied in at each solve, as the utility stand-in's (`ac-source.ts`), so a solve allocates nothing.
    const scratch = new AcBranchValues(1);
    const count = devices.length;
    const neutralOhms = new Float64Array(count);
    const re = new Float64Array(2 * count);
    const im = new Float64Array(2 * count);
    const ohms = new Float64Array(2 * count);
    const henries = new Float64Array(2 * count);
    const mutualOhms = new Float64Array(count);
    const mutualHenries = new Float64Array(count);
    const branches = new Int32Array(3 * count);
    // The utility grounding's earth contact branch (−1 if it didn't compile), for the record.
    const grounding = new Int32Array(count).fill(-1);
    devices.forEach((d, i) => {
      for (const c of d.contacts) if (c.relation === 'earth' && c.contact === 'grounding') grounding[i] = c.branch;
      const p = d.params as ServiceSplitPhaseParams;
      const t = splitPhaseTEquivalent(p, d.frequencyHz);
      const line = serviceDropOhm(p, p.dropLineAreaM2);
      neutralOhms[i] = serviceDropOhm(p, p.dropNeutralAreaM2);
      for (let j = 0; j < 2; j++) {
        scratch.vsourcePolar(
          0,
          p.lineToNeutralV,
          j === 0 ? 0 : 180,
          t.lineToNeutral.ohms + line,
          t.lineToNeutral.henries,
        );
        re[2 * i + j] = scratch.emfRe[0];
        im[2 * i + j] = scratch.emfIm[0];
        ohms[2 * i + j] = scratch.ohms[0];
        henries[2 * i + j] = scratch.seriesHenries[0];
      }
      mutualOhms[i] = t.neutral.ohms;
      mutualHenries[i] = t.neutral.henries;
      // Its branches in part order: dropN, l1, l2.
      for (let k = 0; k < 3; k++) branches[3 * i + k] = d.branches[k];
    });
    return {
      bag: () => ({}),
      writeRecord: (i, view, offset, ctx) => {
        const dropN = branches[3 * i];
        const netlist = ctx.netlist;
        const status = readingStatusCode(ctx.islandStatus(netlist.branches[dropN].island));
        view.setUint8(offset + 56, status);
        if (status !== READING_SOLVED) return;
        // Ends: each winding x0 → its lug, the drop neutral x0 → n. Written out (no helper returning a
        // double: a call V8 doesn't inline boxes it), so a record write allocates nothing.
        const l1 = branches[3 * i + 1];
        const l2 = branches[3 * i + 2];
        writeAmps(ctx.solution.branches, l1, view, offset);
        writeAmps(ctx.solution.branches, l2, view, offset + 8);
        writeAmps(ctx.solution.branches, dropN, view, offset + 16);
        if (grounding[i] >= 0) writeAmps(ctx.solution.branches, grounding[i], view, offset + 24);
        const n = netlist.branches[dropN].b;
        const lug1 = netlist.branches[l1].b;
        const lug2 = netlist.branches[l2].b;
        writeVolts(ctx.solution.nodes, lug1, n, view, offset + 32);
        writeVolts(ctx.solution.nodes, lug2, n, view, offset + 40);
        writeVolts(ctx.solution.nodes, lug1, lug2, view, offset + 48);
      },
      acValue: (i, b, values) => {
        const k = b.index;
        const part = k === branches[3 * i] ? 0 : k === branches[3 * i + 1] ? 1 : 2;
        if (part === 0) {
          values.stamps[k] = AC_STAMP_RESISTOR;
          values.ohms[k] = neutralOhms[i];
          return true;
        }
        const w = 2 * i + part - 1;
        values.stamps[k] = AC_STAMP_VSOURCE;
        values.emfRe[k] = re[w];
        values.emfIm[k] = im[w];
        values.ohms[k] = ohms[w];
        values.seriesHenries[k] = henries[w];
        values.partner[k] = branches[3 * i + (part === 1 ? 2 : 1)];
        values.mutualOhms[k] = mutualOhms[i];
        values.mutualHenries[k] = mutualHenries[i];
        return true;
      },
    };
  },
};
