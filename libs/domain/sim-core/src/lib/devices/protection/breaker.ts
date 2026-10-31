import type { BreakerParams } from '@controls/catalog';
import type { DeviceOutputSchema } from '@controls/sim-protocol';
import type { SimDevice, SimDeviceBank, SimDeviceModel } from '../../engine/device-model';
import { branchReading, enumField, f64Field, READING_SOLVED, statusField } from '../readings';

/*
 * The basic thermal-magnetic circuit breaker (plan F2.5): single-pole, standalone (no panel until P4).
 * The handle is commanded (`on`, `device.operate`); whether it has tripped and how warm its bimetal is
 * are sim-owned (`tripped` and `thermal` in the `sim` bag). It conducts only while the handle is on
 * and it hasn't tripped.
 *
 * **Thermal element.** A bimetal heated by I² and cooling towards ambient, as a first-order lag in
 * units of its rated-current steady state:
 *
 *   dθ/dt = ((I / I_n)² − θ) / τ,
 *
 * so θ settles at (I / I_n)², and the breaker trips when θ reaches k_u², k_u the ultimate trip ratio
 * (the smallest multiple of the rating that trips it at all: it carries I_n and anything below k_u I_n
 * indefinitely). At a constant overload I the thermal trip time is t = −τ ln(1 − (k_u I_n / I)²), the
 * long, inverse-time part of a manufacturer's time-current curve. Explicit Euler at the 1 ms tick.
 *
 * **Magnetic element.** Above its pickup the solenoid trips the breaker at once (within the tick): the
 * flat, instantaneous part of the curve. A real pickup varies from unit to unit inside the
 * manufacturer's band, so each breaker draws its own from its seeded stream when its bank is built
 * (`deriveStream(world.seed, entityStreamKey(id))`, one draw, never again): reproducible per entity,
 * and the same after a load.
 *
 * **Tripping and resetting.** A trip (thermal or magnetic) sets `tripped`, raises a `tripped` event
 * with its cause, and re-solves within the step (the pole is gone: `simTopologyKeys` names `tripped`).
 * The handle stays where the player left it (`on` is commanded: the sim never writes it), so a
 * tripped breaker with its handle on stays open; it resets only when the handle is turned **off**
 * (the engine sees the commanded state through `commanded` and clears `tripped`), and closes when it
 * is turned on again. That is the plan's "off, then on", and a command never reads `tripped`.
 *
 * **Abstractions** (for `electrical-realism-reviewer`): one thermal time constant (a real bimetal and
 * its case make the curve steeper at small overloads); no ambient-temperature compensation; the
 * magnetic pickup is the same on AC and DC (an AC breaker's DC pickup is typically higher); no arcing,
 * let-through or interrupting-rating check (P4); the contact resistance is constant.
 */

/** The breaker's record: its state and thermal fraction (its own, always), the current (solved), the status. */
export const BREAKER_OUTPUT: DeviceOutputSchema = Object.freeze({
  kind: 'breaker.thermalMagnetic',
  recordBytes: 32,
  fields: Object.freeze([
    f64Field('currentA', 0, 'A'),
    f64Field('thermalFraction', 8, null),
    f64Field('magneticPickupA', 16, 'A'),
    enumField('state', 24, ['off', 'on', 'tripped']),
    statusField(25),
  ]),
});

const STATE_OFF = 0;
const STATE_ON = 1;
const STATE_TRIPPED = 2;

export const BREAKER_MODEL: SimDeviceModel = {
  kind: 'breaker.thermalMagnetic',
  output: BREAKER_OUTPUT,
  bank(devices: readonly SimDevice[]): SimDeviceBank {
    const n = devices.length;
    const tripped = new Uint8Array(n);
    const handleOn = new Uint8Array(n);
    const thermal = new Float64Array(n);
    const branch = new Int32Array(n);
    const entity = new Int32Array(n);
    const invRated2 = new Float64Array(n);
    const invTau = new Float64Array(n);
    const tripAt = new Float64Array(n);
    const pickup2 = new Float64Array(n);
    const pickup = new Float64Array(n);
    devices.forEach((d, i) => {
      const p = d.params as BreakerParams;
      tripped[i] = d.bag['tripped'] === true ? 1 : 0;
      handleOn[i] = d.state['on'] === true ? 1 : 0;
      const t = d.bag['thermal'];
      thermal[i] = typeof t === 'number' ? t : 0;
      branch[i] = d.branches.length > 0 ? d.branches[0] : -1;
      entity[i] = d.entity;
      invRated2[i] = 1 / (p.ratedCurrentA * p.ratedCurrentA);
      invTau[i] = 1 / p.thermalTimeConstantS;
      tripAt[i] = p.ultimateTripRatio * p.ultimateTripRatio;
      // One draw from the breaker's own stream, at every bank build: the same pickup every time.
      const u = d.stream().nextFloat();
      pickup[i] = p.ratedCurrentA * (p.magneticTripMinRatio + (p.magneticTripMaxRatio - p.magneticTripMinRatio) * u);
      pickup2[i] = pickup[i] * pickup[i];
    });
    return {
      bag: (i) => ({ thermal: thermal[i], tripped: tripped[i] === 1 }),
      commanded: (i, state) => {
        handleOn[i] = state['on'] === true ? 1 : 0;
        // Turning the handle off resets a tripped breaker (it closes when turned on again).
        if (handleOn[i] === 0 && tripped[i] === 1) tripped[i] = 0;
      },
      protection: (ctx) => {
        let changed = false;
        const dt = ctx.dtS;
        const branches = ctx.solution.branches;
        for (let i = 0; i < n; i++) {
          const b = branch[i];
          let i2 = 0;
          if (b >= 0) {
            // Closed: an unknown current (an unsolved or unsettled island) freezes the bimetal.
            if (!ctx.islandReadable(ctx.netlist.branches[b].island)) continue;
            const re = branches[2 * b];
            const im = branches[2 * b + 1];
            i2 = re * re + im * im;
          }
          // Open (off or tripped): no current, the bimetal cools.
          thermal[i] = Math.max(0, thermal[i] + dt * invTau[i] * (i2 * invRated2[i] - thermal[i])) + 0;
          if (b < 0) continue;
          const magnetic = i2 >= pickup2[i];
          if (magnetic || thermal[i] >= tripAt[i]) {
            tripped[i] = 1;
            ctx.emit('tripped', entity[i], { cause: magnetic ? 'magnetic' : 'thermal' });
            changed = true;
          }
        }
        return changed;
      },
      writeRecord: (i, view, offset, ctx) => {
        view.setFloat64(offset + 8, thermal[i] / tripAt[i], true);
        view.setFloat64(offset + 16, pickup[i], true);
        view.setUint8(offset + 24, tripped[i] === 1 ? STATE_TRIPPED : handleOn[i] === 1 ? STATE_ON : STATE_OFF);
        const b = branch[i];
        // An open pole carries exactly no current, whatever its island: that is a reading.
        if (b < 0) {
          view.setUint8(offset + 25, READING_SOLVED);
          return;
        }
        const status = branchReading(ctx, b);
        if (status === READING_SOLVED) {
          const re = ctx.solution.branches[2 * b];
          const im = ctx.solution.branches[2 * b + 1];
          const ac = ctx.netlist.islands[ctx.netlist.branches[b].island].kind === 'ac';
          view.setFloat64(offset, (ac ? Math.sqrt(re * re + im * im) : re) + 0, true);
        }
        view.setUint8(offset + 25, status);
      },
    };
  },
};
