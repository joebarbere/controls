import type { LampIncandescentParams } from '@controls/catalog';
import type { DeviceOutputSchema } from '@controls/sim-protocol';
import { AMBIENT_TEMPERATURE_K, type SourcedConstant } from '../../constants';
import type { SimDevice, SimDeviceBank, SimDeviceModel } from '../../engine/device-model';
import { branchReading, f64Field, READING_SOLVED, statusField } from '../readings';
import { tungstenResistivity } from './tungsten';

/*
 * The incandescent lamp (plan F2.5): a tungsten filament whose resistance follows its temperature,
 * heated by I²R and cooled by radiation and by conduction along the filament into its two lead-ins. The
 * filament temperature is the only sim-owned value (`filamentTempK` in the `sim` bag), so a save or a
 * topology change carries it exactly.
 *
 * **R(T).** The filament's resistance is its rated (hot) resistance scaled by tungsten's resistivity
 * (`tungsten.ts`, Jones and Langmuir's measurements):
 *
 *   R(T) = R_r · ρ(T) / ρ(T_r),   R_r = V_r² / P_r,
 *
 * so the rated point is exact by construction, and the cold resistance follows from the material: for
 * the bench lamp (12 V, 5 W, T_r = 2700 K) R_r = 28.8 Ω and R(293.15 K) = 1.95 Ω, a cold/hot ratio of
 * 14.8.
 *
 * **The thermal ODE** (engine 6). With C the filament's heat capacity, k its radiation constant and G
 * its conductance to the two lead-ins (the end loss),
 *
 *   C · dT/dt = I² · R(T) − k · (T⁴ − T_a⁴) − G · (T − T_a).
 *
 * At the rated point a fraction f (the entry's `conductionFraction`, else `LAMP_CONDUCTION_FRACTION`;
 * P3 D17) of the rated power leaves by conduction
 * and the rest by radiation, so T_r is still the steady state at the rated power:
 *
 *   k = (1 − f) · P_r / (T_r⁴ − T_a⁴),   G = f · P_r / (T_r − T_a),
 *
 * and C comes from the catalogue's thermal time constant τ, the small-signal time constant at the rated
 * point, where the loss's slope is 4 k T_r³ + G: C = (4 k T_r³ + G) · τ. Hot, radiation's slope is
 * about 32 times conduction's (bench lamp), so the warm-up barely changes; cooling, radiation's T⁴ dies
 * away below about 1000 K and conduction takes over, so the bench lamp is within 10 K of ambient about
 * 7 s after its switch opens (engine 5, radiation alone, took minutes). Integrated by explicit Euler
 * at the 1 ms tick (dt/τ = 0.02 for the bench lamp's 50 ms, so the step is stable and accurate to
 * about a percent). T⁴ is two multiplications (D6).
 *
 * **Inrush emerges.** A cold filament is about a fifteenth of its hot resistance, so the first solve
 * after the switch closes draws about fourteen times the steady current; the current then falls as
 * the filament heats over a few time constants. Nothing about inrush is scripted.
 *
 * **Light output.** Fink and Beaty's published relations for an incandescent lamp near its rated
 * voltage are L ∝ V^3.4 and P ∝ V^1.6, so L ∝ P^(3.4/1.6) = P^(17/8). The model takes P as the power the
 * filament radiates, k (T⁴ − T_a⁴) (the conducted part makes no light), a function of its temperature
 * alone, so the light follows the filament (dark during the cold inrush, fading as it cools, never
 * following the current):
 *
 *   lightOutputRel = x^(17/8),   x = (T⁴ − T_a⁴) / (T_r⁴ − T_a⁴),
 *
 * 1 at the rated point and 0 at ambient. x^(17/8) = x² · ⁸√x, three correctly rounded square roots (D6).
 *
 * **A re-solve when the filament moves.** Between the 10 ms cadence solves the layers integrate
 * against the last solution, which goes stale fast while a cold filament heats. So the continuous
 * layer asks for a re-solve (within the step) when R(T) has moved by more than `LAMP_RESOLVE_RELTOL`
 * from the resistance the last solve saw. That resistance is read back from the solution itself
 * (|ΔV| / |I|), never cached, so a loaded engine re-solves at exactly the ticks a straight run does.
 * A lamp carrying less than `LAMP_RESOLVE_MIN_A` never asks: its temperature barely moves, and a
 * gmin-level current's |ΔV| / |I| is rounding.
 *
 * **Only a reading moves the filament.** On an island that isn't solved (unmodelled, mixed, singular
 * or non-converged) the current is unknown, so the temperature is frozen: neither heated nor cooled
 * (the battery's coulomb counting does the same). Its record then says so (`status`), and every
 * reader shows the lamp as unknown or unsettled, never as a dark lamp drawing 0 W.
 *
 * **Abstractions** (for `electrical-realism-reviewer`): a constant emissivity and heat capacity
 * (both rise with temperature in tungsten); conduction lumped into one linear conductance (really heat
 * flowing along the filament into its two cooler lead-ins, so the ends cool first);
 * with both, the model's light follows the published L ∝ V^3.4 within 3 % from 75 % to 115 % of rated
 * volts. No gas fill (a vacuum lamp), no burnout, evaporation or end of life (the temperature is
 * clamped at the resistivity table's 3600 K, 100 K below tungsten's melting point).
 */

/**
 * The lamp's ambient (K): a lamp starts here (its `filamentTempK` is null until the engine first
 * netlists it), and radiates and conducts to it. The game's one ambient since F3.6 part 1
 * (`AMBIENT_TEMPERATURE_K`, ADR 0018 §3.1), so a lamp and the leads and conductors feeding it share it.
 */
export const LAMP_AMBIENT_K: SourcedConstant = AMBIENT_TEMPERATURE_K;

/** The highest filament temperature the model reaches (K): the resistivity table's top. */
export const LAMP_MAX_TEMP_K: SourcedConstant = {
  value: 3600,
  unit: 'K',
  kind: 'game-design',
  source:
    "game-design: the top of the tungsten resistivity table (Jones and Langmuir's 3600 K), about 100 K below tungsten's melting point (3695 K). P2 has no burnout model, so a grossly over-voltaged filament is clamped here rather than extrapolated.",
};

/**
 * The fraction of a lamp's rated power lost by conduction (the end loss through its two lead-ins) at its
 * rated point; the rest is radiated. Sets the conductance G = f · P_r / (T_r − T_a). The default for an
 * entry without its own `conductionFraction` param (`lampConductionFraction`).
 */
export const LAMP_CONDUCTION_FRACTION: SourcedConstant = {
  value: 0.1,
  unit: '1',
  kind: 'game-design',
  source:
    "game-design inside published behaviour. A filament loses heat by conduction along itself into its two cooler lead-ins as well as by radiation (a small wedge-base lamp's filament hangs between its two lead-ins without separate supports); this end loss is largest for short, thick, low-voltage filaments (I. Langmuir, S. MacLane and K. B. Blodgett, \"The effect of end losses on the characteristics of filaments of tungsten and other materials\", Physical Review 35 (5), 1930, pp. 478–503, doi:10.1103/PhysRev.35.478). For the bench lamp (a 12 V 5 W filament of about 40 µm tungsten wire some 40–50 mm long) a fin-equation estimate puts the end loss through the two lead-ins at a few percent of the input, about 5 % if the leads stayed at ambient. 10 % is taken at the rated point as an upper value; the model's light fits the published L ∝ V^3.4 (Fink and Beaty) best near 5 % and stays within 3 % of it from 75 % to 115 % of rated volts at 10 %. With the bench lamp's 50 ms time constant a switched-off filament is below 600 K in about 1.8 s and within 10 K of ambient in about 7 s; radiation alone (engine 5) took about 6 s and 20 s to reach 600 K and 400 K.",
};

/**
 * The conduction fraction a lamp entry runs with: its own `conductionFraction` param when it has one
 * (P3 D17: the 120 V lamp's τ ≈ 30 ms / f ≈ 0.05 pairing), else `LAMP_CONDUCTION_FRACTION` (the bench
 * lamp, whose physics and hashes are unchanged).
 */
export function lampConductionFraction(p: LampIncandescentParams): number {
  return p.conductionFraction ?? LAMP_CONDUCTION_FRACTION.value;
}

/** Light output against radiated power: L ∝ P^(3.4/1.6) = P^(17/8). */
export const LAMP_LIGHT_POWER_EXPONENT: SourcedConstant = {
  value: 17 / 8,
  unit: '1',
  kind: 'real-world',
  source:
    "The published operating relations of an incandescent lamp near its rated voltage: light output ∝ V^3.4 and power ∝ V^1.6 (D. G. Fink and H. W. Beaty, Standard Handbook for Electrical Engineers, lighting section; paraphrased). Eliminating V gives light ∝ P^(3.4/1.6) = P^2.125 = P^(17/8), which the model applies to the filament's radiated power so the light follows the filament's temperature.",
};

/** The continuous layer asks for a re-solve when R(T) has moved by more than this, relative. */
export const LAMP_RESOLVE_RELTOL: SourcedConstant = {
  value: 0.01,
  unit: '1',
  kind: 'numerical',
  source:
    "numerical: a 1 % move in the filament resistance since the last solve triggers a re-solve within the step, so the heating power never runs more than about 1 % stale while a cold filament heats (about 270 solves over a bench lamp's warm-up, then none while it is steady). Halving it doubles the warm-up solves and moves the inrush trace by well under 1 %.",
};

/** Below this current (A) the lamp never asks for a re-solve. */
export const LAMP_RESOLVE_MIN_A: SourcedConstant = {
  value: 1e-6,
  unit: 'A',
  kind: 'numerical',
  source:
    "numerical: a lamp carrying under 1 µA (an open circuit's gmin-level current) dissipates nothing that moves its filament, and its |ΔV| / |I| is rounding, so it never triggers a re-solve. 1 µA is far below any lamp's operating current and far above gmin's 1e-12 S × the bench's voltages.",
};

const RESOLVE_MIN_A2 = LAMP_RESOLVE_MIN_A.value * LAMP_RESOLVE_MIN_A.value;
const RESOLVE_RELTOL = LAMP_RESOLVE_RELTOL.value;

/** The lamp's resistance (Ω) at `kelvin`, given its rated resistance and rated temperature's resistivity. */
export function lampResistanceOhm(ratedOhm: number, rhoRated: number, kelvin: number): number {
  return (ratedOhm * tungstenResistivity(kelvin)) / rhoRated;
}

/** x^(17/8) for x ≥ 0 (0 for x ≤ 0): x² · ⁸√x, IEEE-exact operations only (D6). */
export function pow17over8(x: number): number {
  if (!(x > 0)) return 0;
  const eighth = Math.sqrt(Math.sqrt(Math.sqrt(x)));
  return x * x * eighth;
}

/**
 * The lamp's output record (ADR 0011 §5.4, amended in F2.4): the power, current and voltage across the
 * filament (solved: 0 unless `status` is `solved`; on an AC island, RMS magnitudes), and its own state,
 * always written: its resistance, its temperature and its light output relative to rated. **A reader
 * shows an unsolved, singular or unsettled lamp as unknown, never as a dark lamp drawing 0 W** (plan
 * F2.5's validity rule): `lightOutputRel` is the filament's, frozen while its island isn't a reading.
 */
export const LAMP_OUTPUT: DeviceOutputSchema = Object.freeze({
  kind: 'lamp.incandescent',
  recordBytes: 56,
  fields: Object.freeze([
    f64Field('powerW', 0, 'W'),
    f64Field('currentA', 8, 'A'),
    f64Field('voltageV', 16, 'V'),
    f64Field('resistanceOhm', 24, 'Ω'),
    f64Field('filamentTempK', 32, 'K'),
    f64Field('lightOutputRel', 40, null),
    statusField(48),
  ]),
});

export const LAMP_MODEL: SimDeviceModel = {
  kind: 'lamp.incandescent',
  output: LAMP_OUTPUT,
  bank(devices: readonly SimDevice[]): SimDeviceBank {
    const n = devices.length;
    const ambient = LAMP_AMBIENT_K.value;
    const ambient4 = ambient * ambient * ambient * ambient;
    const maxK = LAMP_MAX_TEMP_K.value;
    const temp = new Float64Array(n);
    const branch = new Int32Array(n);
    const ratedOhm = new Float64Array(n);
    const rhoRated = new Float64Array(n);
    // k (W/K⁴), G (W/K) and C (J/K) of the ODE, and the rated radiated power's T⁴ term, T_r⁴ − T_a⁴.
    const radiation = new Float64Array(n);
    const conduction = new Float64Array(n);
    const heatCapacity = new Float64Array(n);
    const ratedSpan4 = new Float64Array(n);
    devices.forEach((d, i) => {
      const p = d.params as LampIncandescentParams;
      // A null-initial key: a lamp entering the netlist for the first time starts at ambient. A
      // hand-built world may lack the key altogether (the bench plant's `sim: {}`); the same applies.
      const t = d.bag['filamentTempK'];
      // Clamped into the model's range: the key's schema already refuses below 200 K (the resistivity
      // table's extension reaches 0 Ω near 65.6 K), and the filament never goes below ambient or past
      // the table's top, so a bag from anywhere starts where the model can step it.
      temp[i] = typeof t === 'number' ? Math.min(maxK, Math.max(ambient, t)) : ambient;
      branch[i] = d.branches[0];
      ratedOhm[i] = (p.ratedVoltageV * p.ratedVoltageV) / p.ratedPowerW;
      const tr = p.filamentRatedTempK;
      rhoRated[i] = tungstenResistivity(tr);
      const tr3 = tr * tr * tr;
      ratedSpan4[i] = tr3 * tr - ambient4;
      // The entry's own fraction (D17) or, for an entry without one, the sourced default.
      const conductionFraction = lampConductionFraction(p);
      radiation[i] = ((1 - conductionFraction) * p.ratedPowerW) / ratedSpan4[i];
      conduction[i] = (conductionFraction * p.ratedPowerW) / (tr - ambient);
      heatCapacity[i] = (4 * radiation[i] * tr3 + conduction[i]) * (p.thermalTimeConstantMs / 1000);
    });
    const resistance = (i: number): number => lampResistanceOhm(ratedOhm[i], rhoRated[i], temp[i]);
    const light = (i: number): number => {
      const t = temp[i];
      return pow17over8((t * t * t * t - ambient4) / ratedSpan4[i]);
    };
    return {
      bag: (i) => ({ filamentTempK: temp[i] }),
      dcValue: (i, b, values) => {
        values.resistor(b.index, resistance(i));
        return true;
      },
      acValue: (i, b, values) => {
        values.resistor(b.index, resistance(i));
        return true;
      },
      // Indexed loops over typed arrays: a step allocates nothing of its own.
      continuous: (ctx) => {
        let resolve = false;
        const dt = ctx.dtS;
        const branches = ctx.solution.branches;
        const nodes = ctx.solution.nodes;
        const elements = ctx.netlist.branches;
        for (let i = 0; i < n; i++) {
          const b = branch[i];
          const element = elements[b];
          // Only a reading moves the filament: on an unsolved or unsettled island it is frozen.
          if (!ctx.islandReadable(element.island)) continue;
          const re = branches[2 * b];
          const im = branches[2 * b + 1];
          const i2 = re * re + im * im;
          const t = temp[i];
          const r = (ratedOhm[i] * tungstenResistivity(t)) / rhoRated[i];
          const t4 = t * t * t * t;
          const loss = radiation[i] * (t4 - ambient4) + conduction[i] * (t - ambient);
          const next = t + (dt * (i2 * r - loss)) / heatCapacity[i];
          // Math.min/max, not a ternary: a ternary choosing between a closure constant (a boxed double)
          // and `next` made V8 box `next` into a new heap number every step (16 B/step on the gate).
          const settled = Math.min(maxK, Math.max(ambient, next)) + 0;
          temp[i] = settled;
          if (i2 <= RESOLVE_MIN_A2) continue;
          // The resistance the last solve saw, |ΔV| / |I|, read back from the solution (never cached).
          const vr = nodes[2 * element.a] - nodes[2 * element.b];
          const vi = nodes[2 * element.a + 1] - nodes[2 * element.b + 1];
          const solvedOhm = Math.sqrt((vr * vr + vi * vi) / i2);
          const now = (ratedOhm[i] * tungstenResistivity(settled)) / rhoRated[i];
          const moved = now > solvedOhm ? now - solvedOhm : solvedOhm - now;
          if (moved > RESOLVE_RELTOL * now) resolve = true;
        }
        return resolve;
      },
      writeRecord: (i, view, offset, ctx) => {
        const b = branch[i];
        const status = branchReading(ctx, b);
        const r = resistance(i);
        if (status === READING_SOLVED) {
          const element = ctx.netlist.branches[b];
          const nodes = ctx.solution.nodes;
          const re = ctx.solution.branches[2 * b];
          const im = ctx.solution.branches[2 * b + 1];
          const i2 = re * re + im * im;
          const vr = nodes[2 * element.a] - nodes[2 * element.b];
          const vi = nodes[2 * element.a + 1] - nodes[2 * element.b + 1];
          const ac = ctx.netlist.islands[element.island].kind === 'ac';
          view.setFloat64(offset, i2 * r + 0, true);
          view.setFloat64(offset + 8, (ac ? Math.sqrt(i2) : re) + 0, true);
          view.setFloat64(offset + 16, (ac ? Math.sqrt(vr * vr + vi * vi) : vr) + 0, true);
        }
        view.setFloat64(offset + 24, r, true);
        view.setFloat64(offset + 32, temp[i], true);
        view.setFloat64(offset + 40, light(i), true);
        view.setUint8(offset + 48, status);
      },
    };
  },
};
