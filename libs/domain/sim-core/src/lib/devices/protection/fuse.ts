import type { FuseParams } from '@controls/catalog';
import type { DeviceOutputSchema } from '@controls/sim-protocol';
import type { SimDevice, SimDeviceBank, SimDeviceModel } from '../../engine/device-model';
import { branchReading, enumField, f64Field, READING_SOLVED, statusField } from '../readings';

/*
 * The cartridge fuse (plan F2.5): a link that melts when the heat from I² t outruns what it sheds.
 * Its melt state is sim-owned (`blown` and `meltFraction` in the `sim` bag), so a blown fuse stays
 * blown across a save, a topology change and an undone delete (the engine's tombstones).
 *
 * **The melt model.** A fuse element is a thermal mass heated by I²R and cooled through its end caps,
 * so its temperature rise follows a first-order lag towards a steady rise ∝ I². With θ the rise as a
 * fraction of the rise that melts the element (`meltFraction`),
 *
 *   dθ/dt = ((I / I_min)² − θ) / τ,   τ = I²t_melt / I_min²,
 *
 * where I_min is the minimum fusing current (the current whose steady rise just melts it: below it a
 * fuse never opens) and I²t_melt the datasheet's melting integral. The element melts when θ reaches 1.
 * The two limits are the datasheet's two numbers:
 *
 * - at large currents the lag is negligible and θ ≈ ∫I² dt / (τ I_min²) = ∫I² dt / I²t_melt: the fuse
 *   melts when **∫I² dt reaches the melting I²t** (adiabatic, the region a melting I²t is quoted for);
 * - at a constant current I > I_min it melts after t = −τ ln(1 − (I_min / I)²), and never below I_min.
 *
 * So the time-current curve and its asymptote come from two sourced figures and nothing is
 * tabulated; `ln` appears only in the specs' hand calculations (D6). Explicit Euler at the 1 ms tick
 * (dt/τ = 0.0018 for the bench fuse); a current so large that one tick takes θ past 1 blows in that
 * tick, as a real fuse clears a bolted fault within a millisecond.
 *
 * **Blowing.** The protection layer sets `blown` when θ ≥ 1, raises a `blown` event at that tick and
 * returns `true`: the engine recompiles (the link is gone: `simTopologyKeys` names `blown`) and
 * re-solves at once, within the step. Replacing a fuse in P2 means deleting it and placing a new one.
 *
 * **Abstractions** (for `electrical-realism-reviewer`): one time constant, so the long-overload end of
 * the curve is faster than a real fuse's (whose holder and body add slower thermal masses); the
 * element's resistance is constant (it rises with temperature in a real fuse); no arcing time (the
 * clearing I²t is the melting one), no pre-damage from repeated overloads below I_min, no voltage or
 * interrupting rating checks (P4 and P5).
 */

/** The fuse's record: its state and melt fraction (its own, always), the current (solved) and the status. */
export const FUSE_OUTPUT: DeviceOutputSchema = Object.freeze({
  kind: 'fuse',
  recordBytes: 24,
  fields: Object.freeze([
    f64Field('currentA', 0, 'A'),
    f64Field('meltFraction', 8, null),
    enumField('state', 16, ['intact', 'blown']),
    statusField(17),
  ]),
});

export const FUSE_MODEL: SimDeviceModel = {
  kind: 'fuse',
  output: FUSE_OUTPUT,
  bank(devices: readonly SimDevice[]): SimDeviceBank {
    const n = devices.length;
    const blown = new Uint8Array(n);
    const melt = new Float64Array(n);
    const branch = new Int32Array(n);
    const entity = new Int32Array(n);
    // (1 / I_min)² and 1 / τ, per fuse.
    const invMin2 = new Float64Array(n);
    const invTau = new Float64Array(n);
    devices.forEach((d, i) => {
      const p = d.params as FuseParams;
      blown[i] = d.bag['blown'] === true ? 1 : 0;
      const m = d.bag['meltFraction'];
      melt[i] = typeof m === 'number' ? m : 0;
      branch[i] = d.branches.length > 0 ? d.branches[0] : -1;
      entity[i] = d.entity;
      const minimum = p.ratedCurrentA * p.minimumFusingRatio;
      invMin2[i] = 1 / (minimum * minimum);
      invTau[i] = (minimum * minimum) / p.meltingI2tA2s;
    });
    return {
      bag: (i) => ({ blown: blown[i] === 1, meltFraction: melt[i] }),
      protection: (ctx) => {
        let changed = false;
        const dt = ctx.dtS;
        const branches = ctx.solution.branches;
        for (let i = 0; i < n; i++) {
          if (blown[i] === 1) continue;
          const b = branch[i];
          if (!ctx.islandReadable(ctx.netlist.branches[b].island)) continue; // an unknown current: frozen
          const re = branches[2 * b];
          const im = branches[2 * b + 1];
          const next = melt[i] + dt * invTau[i] * ((re * re + im * im) * invMin2[i] - melt[i]);
          // Math.min/max keep the clamp a float64 (a ternary on a closure constant boxes it).
          melt[i] = Math.min(1, Math.max(0, next)) + 0;
          if (next >= 1) {
            blown[i] = 1;
            ctx.emit('blown', entity[i]);
            changed = true;
          }
        }
        return changed;
      },
      writeRecord: (i, view, offset, ctx) => {
        view.setFloat64(offset + 8, melt[i], true);
        view.setUint8(offset + 16, blown[i]);
        // A blown link carries exactly no current, whatever its island: that is a reading.
        if (blown[i] === 1) {
          view.setUint8(offset + 17, READING_SOLVED);
          return;
        }
        const status = branchReading(ctx, branch[i]);
        if (status === READING_SOLVED) {
          const re = ctx.solution.branches[2 * branch[i]];
          const im = ctx.solution.branches[2 * branch[i] + 1];
          const ac = ctx.netlist.islands[ctx.netlist.branches[branch[i]].island].kind === 'ac';
          view.setFloat64(offset, (ac ? Math.sqrt(re * re + im * im) : re) + 0, true);
        }
        view.setUint8(offset + 17, status);
      },
    };
  },
};
