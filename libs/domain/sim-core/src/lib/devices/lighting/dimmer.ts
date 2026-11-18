import type { DimmerParams } from '@controls/catalog';
import type { SimDevice, SimDeviceBank, SimDeviceModel } from '../../engine/device-model';
import { type DcSolution, ISLAND_FLAG_SINGULAR } from '../../mna/dc';
import { angularFrequency } from '../../mna/phasor';
import { LAMP_RESOLVE_MIN_A } from '../loads/lamp';
import {
  DIMMER_DC_ON_OHM,
  DIMMER_MAX_FITS,
  DIMMER_MIN_REACTANCE_OHM,
  DIMMER_PROBE_RELSTEP,
  DIMMER_RESOLVE_RELTOL,
  DIMMER_RMS_CURVE,
} from './constants';

/*
 * The forward-phase-cut wall dimmer (`dimmer.wall`, P4 D10; ADR 0021 part 3). A real dimmer's triac
 * switches the sine on at a firing angle α in each half cycle, so a resistive load sees the RMS voltage
 * of a phase-cut sine, f(α) of the whole (`DIMMER_RMS_CURVE`, at the level the slider is on). A phasor
 * solve has one frequency and no waveform, so the model holds that RMS with a **lossless series
 * reactance** X chosen at each solve: for a circuit seen by the dimmer as a source behind a resistance
 * R_th (its Thévenin equivalent across the dimmer's terminals), the current is
 *
 *   |I(X)| = |V_th| / √(R_th² + X²),
 *
 * and the phase-cut load's current is k = f(α) of the undimmed one, |V_th| / R_th, exactly when
 *
 *   X = c · R_th,   c = √(1/k² − 1).
 *
 * So every resistive load downstream sees k of its undimmed voltage, the power k² of its undimmed
 * power, and the dimmer itself dissipates nothing (a reactance: its stamp has no resistance).
 *
 * **Measuring R_th.** The dimmer can't see R_th directly, but 1 / |I|² = a + b X² is linear in X², with
 * a = R_th² / |V_th|² and b = 1 / |V_th|², so two solves at two reactances give R_th = √(a / b) (a
 * secant, exact for a fixed linear circuit). The engine's phasor outer loop (`acIterate`) runs them in
 * one engine solve:
 *
 * - pass 0 takes the reactance the last solution was solved with (|V_d| / |I|, from the warm start), or
 *   with no usable warm start a near short (`DIMMER_MIN_REACTANCE_OHM`);
 * - pass 1 records that point and probes a second: a step of `DIMMER_PROBE_RELSTEP` from a warm start,
 *   or from a cold one the reactance the rated voltage would need (c · V_r / |I|, R_th ≈ V_r / |I|);
 * - each later pass fits a and b through the last two points and stamps X = c · √(a / b), until the
 *   fit is within `DIMMER_RESOLVE_RELTOL` of the reactance just solved with;
 * - a fit that fails from a warm start (a stale reactance, such as one fitted while a driver downstream
 *   was stopped) starts again cold, once per solve; one that fails from cold, or that has moved the
 *   reactance `DIMMER_MAX_FITS` times, freezes it for the rest of the solve.
 *
 * The dimmer is the loop's **stage 0** (`acStage`): it fits with every LED driver's admittance frozen,
 * and the drivers (stage 1) settle afterwards with its reactance frozen, so a driver behind a dimmer
 * can't chase the fit (ADR 0021 L2, review E1).
 *
 * **The probe ratchets, boundedly.** The probed point X(1 + 1e-4) is the one accepted when the warm
 * start was already right, so on a steady circuit X creeps up by the probe step each engine solve until
 * it is more than `DIMMER_RESOLVE_RELTOL` off the fit, which then snaps it back with a third phasor
 * solve: a sawtooth within 0.1 % of X (0.1 % × (1 − k²) of the RMS fraction), two phasor solves per
 * engine solve and a third about one solve in ten. Nothing is kept across engine solves (a loaded
 * engine starts from the same warm start, the solution record), so a save and load continue bit for
 * bit. The tick path allocates nothing: the level's ratio is read again only when the branch's values
 * object changes, and every stamp goes through a slot (`inductorAt`).
 *
 * **Abstractions** (for `electrical-realism-reviewer`): exact for RMS, P, S and PF on resistive loads,
 * which is what a phase-cut dimmer is rated for; its harmonics (and an MWBC neutral's) and the triac's
 * on-state loss (about 1 W per 100 W) are left out; the source's reactance is folded into R_th (the
 * fit takes the circuit as resistive; for a house branch circuit X_th / R_th is about 1e-4, so the RMS
 * fraction is off by far less than the golden's 0.5 %). It is exact for a single dimmer, or for
 * dimmers at equal levels; at unequal levels on the two legs of a split-phase MWBC the shared neutral's
 * true RMS (phase-cut waveforms don't cancel) is under-read by up to about 20 % (60°/120° firing: 0.431
 * against 0.552 of a leg's full current; 30°/90°: 0.408 against 0.485). Its reactive power includes
 * what is really distortion power: at level 0.5 the true fundamental displacement is 32.5°, the
 * model's 45°. **Two dimmers in series** don't multiply: each fits the circuit the other leaves, so two
 * at 0.5 give about 0.707 together (not 0.5), with about 0.03 % solve-to-solve jitter. **A
 * non-resistive load downstream** (an LED driver, which a phase-cut dimmer isn't meant to feed, the
 * plan's must-avoid) gets a defined, readable operating point: the reactance the fit reaches with the
 * driver frozen, then the driver settled behind it; it is not a model of a dimmed LED. On a DC island
 * the triac latches on (`DIMMER_DC_ON_OHM`); off, the dimmer is open (its netlist model).
 */

/** The RMS fraction of the phase-cut sine at `level` (0 … 1): linear between the curve's points. */
export function dimmerRmsFraction(level: number): number {
  const fractions = CURVE;
  const x = Math.min(1, Math.max(0, level)) * DIMMER_RMS_CURVE.levels;
  const k = Math.min(DIMMER_RMS_CURVE.levels - 1, Math.floor(x));
  const t = x - k;
  return fractions[k] + (fractions[k + 1] - fractions[k]) * t;
}

/** c = √(1/k² − 1): the reactance over the circuit's resistance that gives RMS fraction `k`. */
export function dimmerReactanceRatio(level: number): number {
  const k = dimmerRmsFraction(level);
  return Math.sqrt(1 / (k * k) - 1);
}

const CURVE = Float64Array.from(DIMMER_RMS_CURVE.fractions);
const MIN_I2 = LAMP_RESOLVE_MIN_A.value * LAMP_RESOLVE_MIN_A.value;

/** Whether `solution`'s island `island` holds a reading to start from (solved, not singular). */
export function usable(solution: DcSolution | null, island: number): solution is DcSolution {
  if (solution === null) return false;
  const result = solution.islands[island];
  return result !== undefined && result.solved && (result.flags & ISLAND_FLAG_SINGULAR) === 0;
}

export const DIMMER_MODEL: SimDeviceModel = {
  kind: 'dimmer.wall',
  // Its protocol 8 record (`levelRms`, the load voltage) is P4 PR 11's (ADR 0019 "Protocol 8").
  output: null,
  bank(devices: readonly SimDevice[]): SimDeviceBank {
    const n = devices.length;
    const ratedV = Float64Array.from(devices, (d) => (d.params as DimmerParams).ratedVoltageV);
    const invOmega = 1 / angularFrequency(devices[0].frequencyHz);
    // The level's reactance ratio c, read again only when the branch's values object changes (a level
    // change is a value-only recompile, which gives the branch new values): no keyed load per pass.
    const valuesSeen: (Readonly<Record<string, number>> | null)[] = new Array<Readonly<Record<string, number>> | null>(
      n,
    ).fill(null);
    const ratio = new Float64Array(n);
    // Scratch for one engine solve's passes (never read across solves): the reactance stamped and its
    // inductance slot, the fit's previous point (X, 1 / |I|²), whether there is one, whether the solve
    // started cold, how many fits moved it, and whether it is frozen for the rest of the solve.
    const stamped = new Float64Array(n);
    const henries = new Float64Array(n);
    const pointX = new Float64Array(n);
    const pointJ = new Float64Array(n);
    const havePoint = new Uint8Array(n);
    const cold = new Uint8Array(n);
    const fits = new Uint8Array(n);
    const frozen = new Uint8Array(n);
    const dcOhms = Float64Array.of(DIMMER_DC_ON_OHM.value);
    const maxFits = DIMMER_MAX_FITS.value;
    const probeStep = 1 + DIMMER_PROBE_RELSTEP.value;
    const tol = DIMMER_RESOLVE_RELTOL.value;
    return {
      bag: () => ({}),
      dcValue: (_i, b, values) => {
        values.resistorAt(b.index, dcOhms, 0);
        return true;
      },
      // Stage 0: the dimmer fits the circuit with every LED driver's admittance frozen (ADR 0021 L2).
      acStage: 0,
      acIterate: (i, b, iterate, values, pass) => {
        if (b.values !== valuesSeen[i]) {
          valuesSeen[i] = b.values;
          ratioInto(b.values['level'], ratio, i);
        }
        if (pass === 0) {
          havePoint[i] = 0;
          fits[i] = 0;
          frozen[i] = 0;
          cold[i] = 1;
          stamped[i] = DIMMER_MIN_REACTANCE_OHM.value;
          if (usable(iterate, b.island)) {
            const re = iterate.branches[2 * b.index];
            const im = iterate.branches[2 * b.index + 1];
            const i2 = re * re + im * im;
            if (i2 > MIN_I2) {
              const nodes = iterate.nodes;
              const vr = nodes[2 * b.a] - nodes[2 * b.b];
              const vi = nodes[2 * b.a + 1] - nodes[2 * b.b + 1];
              const solved = Math.sqrt((vr * vr + vi * vi) / i2);
              if (solved > 0 && solved < Infinity) {
                stamped[i] = solved;
                cold[i] = 0;
              }
            }
          }
          henries[i] = stamped[i] * invOmega;
          values.inductorAt(b.index, henries, i);
          return false;
        }
        if (frozen[i] === 1) return false;
        const solution = iterate as DcSolution;
        const re = solution.branches[2 * b.index];
        const im = solution.branches[2 * b.index + 1];
        const i2 = re * re + im * im;
        // No current (nothing downstream): any reactance is right; keep the one solved with.
        if (!(i2 > MIN_I2)) return false;
        const j = 1 / i2;
        const xb = stamped[i];
        if (havePoint[i] === 0) {
          pointX[i] = xb;
          pointJ[i] = j;
          havePoint[i] = 1;
          // The second point: a small step from a warm start, the rated-voltage guess from a cold one.
          stamped[i] = cold[i] === 1 ? (ratio[i] * ratedV[i]) / Math.sqrt(i2) : xb * probeStep;
          henries[i] = stamped[i] * invOmega;
          values.inductorAt(b.index, henries, i);
          return true;
        }
        const xa = pointX[i];
        const dx2 = xb * xb - xa * xa;
        const slope = (j - pointJ[i]) / dx2;
        const intercept = pointJ[i] - slope * xa * xa;
        if (!(dx2 !== 0 && slope > 0 && intercept > 0)) {
          // A failed fit from a warm start (the circuit changed under a stale reactance, such as one
          // fitted while a driver downstream was stopped): start again cold, once per solve.
          if (cold[i] === 0) {
            cold[i] = 1;
            havePoint[i] = 0;
            stamped[i] = DIMMER_MIN_REACTANCE_OHM.value;
            henries[i] = stamped[i] * invOmega;
            values.inductorAt(b.index, henries, i);
            return true;
          }
          // Not a fixed circuit behind a resistance even from cold: freeze the reactance for the rest of
          // this solve; the next engine solve fits again.
          frozen[i] = 1;
          return false;
        }
        if (fits[i] >= maxFits) {
          frozen[i] = 1;
          return false;
        }
        const target = ratio[i] * Math.sqrt(intercept / slope);
        const off = target > xb ? target - xb : xb - target;
        if (off <= tol * target) return false;
        fits[i]++;
        pointX[i] = xb;
        pointJ[i] = j;
        stamped[i] = target;
        henries[i] = target * invOmega;
        values.inductorAt(b.index, henries, i);
        return true;
      },
    };
  },
};

/** `out[i]` = c for `level` (`dimmerReactanceRatio`), computed in place: no double crosses the call. */
function ratioInto(level: number, out: Float64Array, i: number): void {
  const x = Math.min(1, Math.max(0, level)) * DIMMER_RMS_CURVE.levels;
  const k = Math.min(DIMMER_RMS_CURVE.levels - 1, Math.floor(x));
  const f = CURVE[k] + (CURVE[k + 1] - CURVE[k]) * (x - k);
  out[i] = Math.sqrt(1 / (f * f) - 1);
}
