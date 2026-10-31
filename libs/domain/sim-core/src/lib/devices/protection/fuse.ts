import type { FuseParams } from '@controls/catalog';
import type { DeviceOutputSchema } from '@controls/sim-protocol';
import type { SimDevice, SimDeviceBank, SimDeviceModel } from '../../engine/device-model';
import { branchReading, enumField, f64Field, READING_SOLVED, statusField } from '../readings';

/*
 * The cartridge fuse (plan F2.5): a link that melts when the heat from I² t outruns what it sheds.
 * Its melt state is sim-owned (`blown`, `elementHeat` and `bodyHeat` in the `sim` bag), so a blown fuse
 * stays blown across a save, a topology change and an undone delete (the engine's tombstones).
 *
 * **The melt model: two thermal bodies** (`electrical-realism-reviewer`, F2.5 review, decided). A fuse
 * element is a small, fast thermal mass inside a slower one (its body, end caps and holder). Each is a
 * first-order lag towards its share of a steady rise ∝ I², in units of the rise that melts the
 * element:
 *
 *   dθ_e/dt = (w (I / I_min)² − θ_e) / τ_e,   dθ_b/dt = ((1 − w) (I / I_min)² − θ_b) / τ_b,
 *
 * and the element melts when θ_e + θ_b ≥ 1. I_min is the minimum fusing current (the steady sum is
 * (I / I_min)², so below it a fuse never opens), w the element's share (`elementFraction`) and τ_b the
 * body's time constant (`bodyTimeConstantS`). The element's τ_e follows from the datasheet's melting
 * I²t: at large currents both lags are negligible, θ_e + θ_b ≈ ∫I² dt · (w / τ_e + (1 − w) / τ_b) /
 * I_min², so the fuse melts when **∫I² dt reaches**
 *
 *   I²t = I_min² / (w / τ_e + (1 − w) / τ_b),   τ_e = w / (I_min² / I²t − (1 − w) / τ_b).
 *
 * For the bench fuse (1 A, 0.7 A²s, I_min 1.2 A, w 0.3, τ_b 10 s) τ_e = 0.151 s, and it melts after
 * 12.05 s at 135 %, 0.908 s at 200 %, 0.107 s at 300 % and 7.16 ms at 1000 % (the specs compute them):
 * the slow body gives the long-overload end a real fast-acting fuse's seconds-to-minutes, where one
 * body melted in under a second. Explicit Euler at the 1 ms tick (dt/τ_e = 0.0066); a current so large
 * that one tick takes the sum past 1 blows in that tick, as a real fuse clears a bolted fault within a
 * millisecond. No transcendental (D6): `ln` and `exp` appear only in the specs' hand calculations.
 *
 * **Blowing.** The protection layer sets `blown` when θ_e + θ_b ≥ 1, raises a `blown` event at that
 * tick and returns `true`: the engine recompiles (the link is gone: `simTopologyKeys` names `blown`)
 * and re-solves at once, within the step. Replacing a fuse in P2 means deleting it and placing a new
 * one.
 *
 * **Abstractions** (for `electrical-realism-reviewer`): two lumped bodies, not a distributed element;
 * the element's resistance is constant (it rises with temperature in a real fuse); no arcing time (the
 * clearing I²t is the melting one), no pre-damage from repeated overloads below I_min, no voltage or
 * interrupting rating checks (P4 and P5).
 */

/** The element's time constant τ_e (s) that makes the adiabatic melting integral the datasheet's I²t. */
export function fuseElementTimeConstantS(p: FuseParams): number {
  const minimum = p.ratedCurrentA * p.minimumFusingRatio;
  return p.elementFraction / ((minimum * minimum) / p.meltingI2tA2s - (1 - p.elementFraction) / p.bodyTimeConstantS);
}

/** The fuse's record: its state and melt fraction θ_e + θ_b (its own, always), the current (solved), the status. */
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
    const element = new Float64Array(n);
    const body = new Float64Array(n);
    const branch = new Int32Array(n);
    const entity = new Int32Array(n);
    // (1 / I_min)², each body's share of the steady rise and 1 / τ, per fuse.
    const invMin2 = new Float64Array(n);
    const elementShare = new Float64Array(n);
    const bodyShare = new Float64Array(n);
    const invElementTau = new Float64Array(n);
    const invBodyTau = new Float64Array(n);
    devices.forEach((d, i) => {
      const p = d.params as FuseParams;
      blown[i] = d.bag['blown'] === true ? 1 : 0;
      const e = d.bag['elementHeat'];
      const b = d.bag['bodyHeat'];
      element[i] = typeof e === 'number' ? e : 0;
      body[i] = typeof b === 'number' ? b : 0;
      branch[i] = d.branches.length > 0 ? d.branches[0] : -1;
      entity[i] = d.entity;
      const minimum = p.ratedCurrentA * p.minimumFusingRatio;
      invMin2[i] = 1 / (minimum * minimum);
      elementShare[i] = p.elementFraction;
      bodyShare[i] = 1 - p.elementFraction;
      invElementTau[i] = 1 / fuseElementTimeConstantS(p);
      invBodyTau[i] = 1 / p.bodyTimeConstantS;
    });
    return {
      bag: (i) => ({ blown: blown[i] === 1, bodyHeat: body[i], elementHeat: element[i] }),
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
          const x2 = (re * re + im * im) * invMin2[i];
          // Math.max, not a ternary: a ternary on a closure constant boxes the result (simulation caveats).
          element[i] = Math.max(0, element[i] + dt * invElementTau[i] * (elementShare[i] * x2 - element[i])) + 0;
          body[i] = Math.max(0, body[i] + dt * invBodyTau[i] * (bodyShare[i] * x2 - body[i])) + 0;
          if (element[i] + body[i] >= 1) {
            blown[i] = 1;
            ctx.emit('blown', entity[i]);
            changed = true;
          }
        }
        return changed;
      },
      writeRecord: (i, view, offset, ctx) => {
        view.setFloat64(offset + 8, Math.min(1, element[i] + body[i]), true);
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
