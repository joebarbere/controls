import type { LedDriverParams } from '@controls/catalog';
import type { DeviceOutputSchema } from '@controls/sim-protocol';
import type { SimDevice, SimDeviceBank, SimDeviceModel } from '../../engine/device-model';
import { branchReading, enumField, f64Field, READING_SOLVED, statusField } from '../readings';
import type { AcBranchValues } from '../../mna/ac-values';
import { angularFrequency } from '../../mna/phasor';
import { LED_DRIVER_OFF_OHM, LED_RESOLVE_RELTOL } from './constants';
import { usable } from './dimmer';

/*
 * The constant-power LED driver (`light.led`, `light.ledFixture`, P4 D11; ADR 0021 part 3). A switch-mode
 * driver regulates its LEDs' current, so over its operating range it draws the same power whatever its
 * input voltage: modelled as an admittance chosen at each solve,
 *
 *   Y = conj(S) / |V|² = (P + j|Q|) / |V|²,   |Q| = P · √(1 − pf²) / pf,
 *
 * on two parallel elements, a conductance G = P / |V|² and an inductive susceptance B = |Q| / |V|²
 * (Y = G − jB, S = P + j|Q| at its terminals: the datasheet power factor carried as a **lagging**
 * displacement, so |I| and the VA match a meter). Lagging, not leading, on purpose (review of PR 12,
 * item 3): a real small driver's displacement is leading (its input capacitor), but the angle is an
 * abstraction either way (most of its power factor is distortion), and a leading admittance behind the
 * dimmer's series reactance (an inductor, the fundamental of a phase-control triac lags) resonates, so
 * a dimmer-fed driver sat at 128–133 V on a 120 V supply. A lagging admittance behind any lossless
 * series reactance of the same sign never sees more than the open-circuit voltage: |Z / (Z + jX)| < 1
 * for Z = a + jb with a, b, X ≥ 0. |V| comes from the solution itself through the engine's phasor outer loop (`acIterate`):
 * pass 0 takes it from the warm start (the last solution) or, with none, the rated voltage; each later
 * pass re-reads it and solves again until G moves by less than `LED_RESOLVE_RELTOL`. A driver is a
 * tiny load on a branch circuit (a 9 W lamp behind half an ohm moves its own voltage by 3e-4 of it), so
 * the loop settles in one or two passes. The drivers are the loop's **stage 1**: they settle after any
 * dimmer (stage 0) has fitted its reactance, with that reactance frozen. A fixed-point iteration that
 * still moves at the cap leaves its island `nonConverged`, never hidden.
 *
 * **Dropout.** Below `dropoutVoltageV` a running driver stops and draws nothing (both elements at
 * `LED_DRIVER_OFF_OHM`, a stable branch); a stopped one starts again at `restartVoltageV`. The band is
 * a hysteresis inside the passes (each pass compares against the state it was solved in, as the bench
 * supply's CV/CC loop does), and the state a solve settles in is committed in `afterSolve` as the
 * persisted `running` key (the F2.4 rule), so a save inside the band reloads into the same state.
 * **A driver that stops during a solve can't restart in the same solve.** On a supply that can't hold
 * it up (running it would sit below dropout, stopped it sees more than restart: a real one blinks) the
 * solve settles with it stopped within about ten passes, so its island stays readable; at the next
 * solve it may start again from the warm start and stop again (one blink per solve at most), and its
 * committed state is stopped. Without this rule such a driver took the island to the 50-pass cap at
 * every solve and blanked every reading on it (review E1).
 *
 * **Light output** is constant while it runs (D11) and zero when stopped (its protocol 8 record, P4
 * PR 11).
 *
 * **Abstractions** (for `electrical-realism-reviewer`): power exactly constant from dropout up (a real
 * driver's efficiency and input current drift a few percent across its range); `powerFactor` is the
 * datasheet (true) power factor, carried as a lagging displacement so |I| and the VA match a meter,
 * while the phase angle it implies and the harmonic current are abstractions; no
 * inrush into its input capacitor; on a DC island the driver is stopped (an AC driver on DC is not
 * modelled; P4 has no DC lighting).
 */

export const LED_MODEL_KINDS = ['light.led', 'light.ledFixture'] as const;

/**
 * The LED lamp's and fixture's record (protocol 8, ADR 0011's amendment; registered by P4 PR 12): the
 * power, voltage and current at the driver's terminals (solved; RMS magnitudes on AC), its light output
 * relative to rated (own: 1 while running, 0 stopped) and `driverState` (own, the committed `running`).
 */
function ledOutput(kind: string): DeviceOutputSchema {
  return Object.freeze({
    kind,
    recordBytes: 40,
    fields: Object.freeze([
      f64Field('powerW', 0, 'W'),
      f64Field('voltageV', 8, 'V'),
      f64Field('currentA', 16, 'A'),
      f64Field('lightOutputRel', 24, null),
      enumField('driverState', 32, ['off', 'running']),
      statusField(33),
    ]),
  });
}

function ledModel(kind: (typeof LED_MODEL_KINDS)[number]): SimDeviceModel {
  return {
    kind,
    output: ledOutput(kind),
    bank(devices: readonly SimDevice[]): SimDeviceBank {
      const n = devices.length;
      const omega = angularFrequency(devices[0].frequencyHz);
      const power = new Float64Array(n);
      const reactive = new Float64Array(n);
      const dropout2 = new Float64Array(n);
      const restart2 = new Float64Array(n);
      const rated2 = new Float64Array(n);
      const conductanceBranch = new Int32Array(n);
      const susceptanceBranch = new Int32Array(n);
      const running = new Uint8Array(n);
      const overvoltageSinceTick: (number | null)[] = new Array<number | null>(n).fill(null);
      // Scratch for one engine solve's passes: the state and admittance the driver was last stamped with,
      // whether it stopped during this solve (a stopped driver can't restart in the same solve), |V|² of
      // the iterate, and the slots its stamps read (no double crosses a call on the tick path).
      const on = new Uint8Array(n);
      const stoppedThisSolve = new Uint8Array(n);
      const conductance = new Float64Array(n);
      const susceptance = new Float64Array(n);
      const volts2 = new Float64Array(n);
      const ohms = new Float64Array(n);
      const henries = new Float64Array(n);
      const offOhms = Float64Array.of(LED_DRIVER_OFF_OHM.value);
      devices.forEach((d, i) => {
        const p = d.params as LedDriverParams;
        power[i] = p.ratedPowerW;
        reactive[i] = (p.ratedPowerW * Math.sqrt(1 - p.powerFactor * p.powerFactor)) / p.powerFactor;
        dropout2[i] = p.dropoutVoltageV * p.dropoutVoltageV;
        restart2[i] = p.restartVoltageV * p.restartVoltageV;
        rated2[i] = p.ratedVoltageV * p.ratedVoltageV;
        // Parts in order: `conductance`, then `susceptance` (the netlist model's).
        conductanceBranch[i] = d.branches[0];
        susceptanceBranch[i] = d.branches[1];
        running[i] = d.bag['running'] === true ? 1 : 0;
        // Carried through as saved until F4.4 sets it (the lamp's rule, ADR 0021 part 1 deviation 5).
        const since = d.bag['overvoltageSinceTick'];
        overvoltageSinceTick[i] = typeof since === 'number' ? since : null;
      });
      /**
       * Device `i`'s state for |V|² = `volts2[i]`, from the state it was stamped in (the hysteresis); a
       * driver that stopped during this solve stays stopped for the rest of it.
       */
      const decide = (i: number): void => {
        const v2 = volts2[i];
        const next = on[i] === 1 ? v2 >= dropout2[i] : v2 >= restart2[i] && stoppedThisSolve[i] === 0;
        if (on[i] === 1 && !next) stoppedThisSolve[i] = 1;
        on[i] = next ? 1 : 0;
        if (next) {
          conductance[i] = power[i] / v2;
          susceptance[i] = reactive[i] / v2;
        }
      };
      const stampSusceptance = (i: number, values: AcBranchValues): void => {
        const b = susceptanceBranch[i];
        if (on[i] === 1 && susceptance[i] > 0) {
          // An inductive susceptance B: Y = −jB, so L = 1 / (ω B).
          henries[i] = 1 / (omega * susceptance[i]);
          values.inductorAt(b, henries, i);
        } else values.resistorAt(b, offOhms, 0);
      };
      const stampBoth = (i: number, values: AcBranchValues): void => {
        const g = conductanceBranch[i];
        if (on[i] === 0) values.resistorAt(g, offOhms, 0);
        else {
          ohms[i] = 1 / conductance[i];
          values.resistorAt(g, ohms, i);
        }
        stampSusceptance(i, values);
      };
      return {
        bag: (i) => ({ overvoltageSinceTick: overvoltageSinceTick[i], running: running[i] === 1 }),
        // On a DC (or unsupplied, empty) island the driver is stopped.
        dcValue: (i, b, values) => {
          on[i] = 0;
          values.resistorAt(b.index, offOhms, 0);
          return true;
        },
        // Stage 1: the drivers settle after any dimmer's fit, with its reactance frozen (ADR 0021 L3).
        acStage: 1,
        acIterate: (i, b, iterate, values, pass) => {
          // The conductance branch (first in part order) decides and stamps both of the driver's branches;
          // at pass 0 the engine clears each branch's stamp just before its own call, so the susceptance
          // branch stamps itself there from the state its sibling just decided.
          if (b.index !== conductanceBranch[i]) {
            if (pass === 0) stampSusceptance(i, values);
            return false;
          }
          if (pass === 0) {
            on[i] = running[i];
            stoppedThisSolve[i] = 0;
            if (usable(iterate, b.island)) {
              const nodes = iterate.nodes;
              const vr = nodes[2 * b.a] - nodes[2 * b.b];
              const vi = nodes[2 * b.a + 1] - nodes[2 * b.b + 1];
              volts2[i] = vr * vr + vi * vi;
              decide(i);
            } else if (on[i] === 1) {
              // No warm start: a running driver starts the passes at its rated voltage's admittance; a
              // stopped one stays stopped until a pass sees the restart voltage (a guess never decides).
              conductance[i] = power[i] / rated2[i];
              susceptance[i] = reactive[i] / rated2[i];
            }
            stampBoth(i, values);
            return false;
          }
          const nodes = (iterate as NonNullable<typeof iterate>).nodes;
          const vr = nodes[2 * b.a] - nodes[2 * b.b];
          const vi = nodes[2 * b.a + 1] - nodes[2 * b.b + 1];
          volts2[i] = vr * vr + vi * vi;
          const wasOn = on[i];
          const solvedG = conductance[i];
          const solvedB = susceptance[i];
          decide(i);
          if (on[i] !== wasOn) {
            stampBoth(i, values);
            return true;
          }
          if (on[i] === 0) return false;
          const moved = conductance[i] > solvedG ? conductance[i] - solvedG : solvedG - conductance[i];
          if (moved > LED_RESOLVE_RELTOL.value * conductance[i]) {
            stampBoth(i, values);
            return true;
          }
          // Accept: the values stay the ones this solution was solved with.
          conductance[i] = solvedG;
          susceptance[i] = solvedB;
          return false;
        },
        writeRecord: (i, view, offset, ctx) => {
          const g = conductanceBranch[i];
          const status = branchReading(ctx, g);
          if (status === READING_SOLVED) {
            const element = ctx.netlist.branches[g];
            const nodes = ctx.solution.nodes;
            const branches = ctx.solution.branches;
            const sb = susceptanceBranch[i];
            const ir = branches[2 * g] + branches[2 * sb];
            const ii = branches[2 * g + 1] + branches[2 * sb + 1];
            const vr = nodes[2 * element.a] - nodes[2 * element.b];
            const vi = nodes[2 * element.a + 1] - nodes[2 * element.b + 1];
            view.setFloat64(offset, vr * ir + vi * ii + 0, true);
            if (ctx.netlist.islands[element.island].kind === 'ac') {
              view.setFloat64(offset + 8, Math.sqrt(vr * vr + vi * vi) + 0, true);
              view.setFloat64(offset + 16, Math.sqrt(ir * ir + ii * ii) + 0, true);
            } else {
              view.setFloat64(offset + 8, vr + 0, true);
              view.setFloat64(offset + 16, ir + 0, true);
            }
          }
          view.setFloat64(offset + 24, running[i], true);
          view.setUint8(offset + 32, running[i]);
          view.setUint8(offset + 33, status);
        },
        afterSolve: (ctx) => {
          for (let i = 0; i < n; i++) {
            // Commit what a solve decided; an unsolved or unsettled island decided nothing.
            if (ctx.islandReadable(ctx.netlist.branches[conductanceBranch[i]].island)) running[i] = on[i];
          }
        },
      };
    },
  };
}

export const LIGHT_LED_MODEL: SimDeviceModel = ledModel('light.led');
export const LIGHT_LED_FIXTURE_MODEL: SimDeviceModel = ledModel('light.ledFixture');
