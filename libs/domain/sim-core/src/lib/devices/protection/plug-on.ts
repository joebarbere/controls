import { type GfciBreakerParams, type PlugOnBreakerParams, TRIP_CAUSES } from '@controls/catalog';
import type { DeviceStateValue } from '@controls/save-format';
import type { DeviceOutputField, DeviceOutputSchema } from '@controls/sim-protocol';
import { INTERMITTENT_MIN_DWELL_TICKS, intermittentBucket } from '../../contact/regimes';
import type {
  CommandedContext,
  LayerContext,
  SimDevice,
  SimDeviceBank,
  SimDeviceModel,
} from '../../engine/device-model';
import type { Netlist } from '../../netlist/types';
import {
  enumField,
  f64Field,
  READING_SOLVED,
  READING_UNSOLVED,
  readingStatusCode,
  statusField,
  writeVolts,
} from '../readings';
import { afciDetectionBuckets, afciDraw, type AfciLimitValues, afciLimitValues, markDownstream } from './afci';
import { AFCI_QUIET_RESET_TICKS, GFCI_TEST_HOLD_TICKS, TRIP_ELECTRONICS_MIN_V } from './constants';
import { drawTicksInBand, GfciSensor, gfciRateTable } from './gfci';

/*
 * Breakers v2 (P4 D6–D8, ADR 0021 part 2): one bank for the four residential breaker kinds, the
 * single- and two-pole plug-on breakers, the GFCI breaker and the combination AFCI breaker (the plan's
 * "one breaker bank"). The DIN `breaker.thermalMagnetic` keeps its P2 model (`breaker.ts`).
 *
 * **Thermal.** The P2 bimetal law per pole, dθ/dt = ((I / I_n)² − θ) / τ, tripping at θ ≥ k_u²
 * (`thermal`, or `thermalL1` and `thermalL2`). At a constant overload I the trip time is
 * t = −τ ln(1 − (k_u I_n / I)²): with τ 60 s and k_u 1.25, 116.8 s at 135 %, 29.7 s at 200 %,
 * 3.87 s at 500 % and 0.945 s at 10 × (200 A on a 20 A breaker is still thermal: below its band).
 * It never trips at or below k_u I_n. An open pole cools.
 *
 * **Magnetic.** Each pole draws its pickup once per bank build inside the entry's absolute band
 * (240–400 A for 15 and 20 A): pole 1 from the entity's own stream (P2's rule), pole 2 from
 * `entity:<id>:pickupL2`. Above it the breaker **opens after its opening time** (D6), drawn once per
 * bank build from `entity:<id>:opening` as ⌈min + (max − min) u⌉ ticks over the entry's band
 * (8–20 ms), counted from the first protection step that saw a pole above its pickup
 * (`magneticSinceTick`, persisted, so a save inside the window opens at the same tick); the fault
 * current keeps flowing (and heating the bimetal) until then. Below the pickup the excursion ends.
 *
 * **Common trip.** Any pole's thermal or magnetic trip opens every pole (`tripped`, one key). The cause
 * is persisted (`tripCause`) and carried by the `tripped` event; when two causes come at one step the
 * first of magnetic, thermal, ground fault (or test), arc fault is reported.
 *
 * **GFCI** (`breaker.gfci1p`, D7): the residual |I_pole + I_neutral| through `GfciSensor` (the shared
 * GFCI logic). A test press closes the internal test resistor (`testHeldSinceTick`, a topology key)
 * until the breaker trips or `GFCI_TEST_HOLD_TICKS` pass; a trip while it is held is cause `test`.
 * Reset is the handle (off, then on).
 *
 * **AFCI** (`breaker.afci1p`, D8): at each 100-tick bucket boundary, an arcing end downstream carrying
 * at least 5 A adds to `arcExposure` and may trip it (`afci.ts`). A test press trips it at once (cause
 * `test`) when it is closed and its electronics are powered (`TRIP_ELECTRONICS_MIN_V` between line and
 * pigtail in the last solution); otherwise nothing happens.
 *
 * **Reset and the handle** are the DIN breaker's: turning the handle off clears a trip (the
 * `commanded` hook), and the sim never writes `on`. **Frozen on an island that isn't a reading**: a
 * closed breaker's bimetals, magnetic window, residual and arc detection don't move.
 *
 * **Abstractions** (for `electrical-realism-reviewer`): one time constant per bimetal (no case mass);
 * no ambient compensation; the pickup is the same on AC and DC; a pole's contact resistance is
 * constant; no let-through I²t or interrupting rating; the GFCI and AFCI's neutral is never switched.
 *
 * **Records** (protocol 8, P4 PR 11; ADR 0011's protocol 8 amendment): per-pole currents (|I|, RMS on
 * AC), thermal fractions (θ / k_u², 1 trips) and drawn pickups, the drawn opening time, `state`
 * (`off`, `on`, `tripped`: read this, never the handle's `on`, to show a trip) and `tripCause`,
 * always written; the GFCI adds its neutral current, `residualMa`, `pickupMa`, `residualIntegral`,
 * `testHeld` and the line-side and load-side voltages, the AFCI its neutral current, the voltages,
 * `arcExposure` and `arcingDownstream`. An open pole carries exactly 0 A, a reading whatever its
 * island (the DIN breaker's rule). The GFCI's and AFCI's electrical fields are readings only with their
 * `readings` bit (`DEVICE_READING_*`): a voltage needs both terminals on one solved island.
 */

const CAUSE_NONE = 0;
/** Cause codes: 1 + the index in `TRIP_CAUSES`. */
const CAUSE_THERMAL = 1;
const CAUSE_MAGNETIC = 2;
const CAUSE_GROUND_FAULT = 3;
const CAUSE_ARC_FAULT = 4;
const CAUSE_TEST = 5;

const BUCKET_TICKS = INTERMITTENT_MIN_DWELL_TICKS.value;
const HOLD_TICKS = GFCI_TEST_HOLD_TICKS.value;
const QUIET_TICKS = AFCI_QUIET_RESET_TICKS.value;
const ELECTRONICS_MIN_V2 = TRIP_ELECTRONICS_MIN_V.value * TRIP_ELECTRONICS_MIN_V.value;

const causeCode = (value: unknown): number => {
  const index = TRIP_CAUSES.indexOf(value as (typeof TRIP_CAUSES)[number]);
  return index < 0 ? CAUSE_NONE : index + 1;
};

const num = (value: unknown, fallback: number): number => (typeof value === 'number' ? value : fallback);

/** What sets the four kinds apart. */
interface Variant {
  readonly kind: string;
  readonly poles: 1 | 2;
  readonly gfci: boolean;
  readonly afci: boolean;
}

const POLE_PARTS: Readonly<Record<1 | 2, readonly string[]>> = { 1: ['pole'], 2: ['pole1', 'pole2'] };

// --- protocol 8 records (ADR 0011's protocol 8 amendment; `sim-protocol`'s copies must equal these) --

/** A breaker's `state` by code (the DIN breaker's: the handle and the trip). */
const BREAKER_STATES = ['off', 'on', 'tripped'] as const;
const STATE_OFF = 0;
const STATE_ON = 1;
const STATE_TRIPPED = 2;
/** `tripCause` by code: `none`, then `TRIP_CAUSES` (so a cause's code is the bank's `cause` code). */
const TRIP_CAUSE_FIELD_VALUES: readonly string[] = ['none', ...TRIP_CAUSES];
const NO_YES = ['no', 'yes'] as const;
/** `readings` bits (`sim-protocol`'s `DEVICE_READING_*`, pinned equal by `outputs.spec.ts`). */
export const PLUG_ON_READING_CURRENT = 1;
export const PLUG_ON_READING_NEUTRAL_CURRENT = 2;
export const PLUG_ON_READING_RESIDUAL = 4;
export const PLUG_ON_READING_LINE_VOLTAGE = 8;
export const PLUG_ON_READING_LOAD_VOLTAGE = 16;

const bitsField = (name: string, offset: number): DeviceOutputField => ({
  name,
  type: 'u8',
  offset,
  unit: null,
  values: null,
});

const PLUG_ON_1P_OUTPUT: DeviceOutputSchema = {
  kind: 'breaker.plugOn1p',
  recordBytes: 40,
  fields: [
    f64Field('currentA', 0, 'A'),
    f64Field('thermalFraction', 8, null),
    f64Field('magneticPickupA', 16, 'A'),
    f64Field('openingMs', 24, 'ms'),
    enumField('state', 32, BREAKER_STATES),
    enumField('tripCause', 33, TRIP_CAUSE_FIELD_VALUES),
    statusField(34),
  ],
};

const PLUG_ON_2P_OUTPUT: DeviceOutputSchema = {
  kind: 'breaker.plugOn2p',
  recordBytes: 64,
  fields: [
    f64Field('pole1CurrentA', 0, 'A'),
    f64Field('pole2CurrentA', 8, 'A'),
    f64Field('pole1ThermalFraction', 16, null),
    f64Field('pole2ThermalFraction', 24, null),
    f64Field('pole1MagneticPickupA', 32, 'A'),
    f64Field('pole2MagneticPickupA', 40, 'A'),
    f64Field('openingMs', 48, 'ms'),
    enumField('state', 56, BREAKER_STATES),
    enumField('tripCause', 57, TRIP_CAUSE_FIELD_VALUES),
    statusField(58),
  ],
};

const GFCI_1P_OUTPUT: DeviceOutputSchema = {
  kind: 'breaker.gfci1p',
  recordBytes: 88,
  fields: [
    f64Field('currentA', 0, 'A', PLUG_ON_READING_CURRENT),
    f64Field('neutralCurrentA', 8, 'A', PLUG_ON_READING_NEUTRAL_CURRENT),
    f64Field('residualMa', 16, 'mA', PLUG_ON_READING_RESIDUAL),
    f64Field('lineVoltageV', 24, 'V', PLUG_ON_READING_LINE_VOLTAGE),
    f64Field('loadVoltageV', 32, 'V', PLUG_ON_READING_LOAD_VOLTAGE),
    f64Field('thermalFraction', 40, null),
    f64Field('magneticPickupA', 48, 'A'),
    f64Field('openingMs', 56, 'ms'),
    f64Field('pickupMa', 64, 'mA'),
    f64Field('residualIntegral', 72, null),
    enumField('state', 80, BREAKER_STATES),
    enumField('tripCause', 81, TRIP_CAUSE_FIELD_VALUES),
    enumField('testHeld', 82, NO_YES),
    bitsField('readings', 83),
    statusField(84),
  ],
};

const AFCI_1P_OUTPUT: DeviceOutputSchema = {
  kind: 'breaker.afci1p',
  recordBytes: 72,
  fields: [
    f64Field('currentA', 0, 'A', PLUG_ON_READING_CURRENT),
    f64Field('neutralCurrentA', 8, 'A', PLUG_ON_READING_NEUTRAL_CURRENT),
    f64Field('lineVoltageV', 16, 'V', PLUG_ON_READING_LINE_VOLTAGE),
    f64Field('loadVoltageV', 24, 'V', PLUG_ON_READING_LOAD_VOLTAGE),
    f64Field('thermalFraction', 32, null),
    f64Field('magneticPickupA', 40, 'A'),
    f64Field('openingMs', 48, 'ms'),
    f64Field('arcExposure', 56, null),
    enumField('state', 64, BREAKER_STATES),
    enumField('tripCause', 65, TRIP_CAUSE_FIELD_VALUES),
    enumField('arcingDownstream', 66, NO_YES),
    bitsField('readings', 67),
    statusField(68),
  ],
};

function outputOf(variant: Variant): DeviceOutputSchema {
  if (variant.gfci) return GFCI_1P_OUTPUT;
  if (variant.afci) return AFCI_1P_OUTPUT;
  return variant.poles === 2 ? PLUG_ON_2P_OUTPUT : PLUG_ON_1P_OUTPUT;
}

function plugOnModel(variant: Variant): SimDeviceModel {
  return { kind: variant.kind, output: outputOf(variant), bank: (devices) => plugOnBank(variant, devices) };
}

function plugOnBank(variant: Variant, devices: readonly SimDevice[]): SimDeviceBank {
  const n = devices.length;
  const poles = variant.poles;
  const handleOn = new Uint8Array(n);
  const tripped = new Uint8Array(n);
  const cause = new Uint8Array(n);
  const entity = new Int32Array(n);
  const thermal = new Float64Array(2 * n);
  const pickupA = new Float64Array(2 * n);
  const pickup2 = new Float64Array(2 * n);
  /** Per pole: its branch while closed, else −1. */
  const hot = new Int32Array(2 * n).fill(-1);
  /** A GFCI's or AFCI's neutral branch (always present), else −1. */
  const neutral = new Int32Array(n).fill(-1);
  const invRated2 = new Float64Array(n);
  const invTau = new Float64Array(n);
  const tripAt = new Float64Array(n);
  const openingTicks = new Float64Array(n);
  const magSince = new Float64Array(n).fill(-1);
  const testSeen = new Float64Array(n);
  const sensor = variant.gfci && n > 0 ? new GfciSensor(n, gfciRateTable(devices[0].protection.gfci)) : null;
  const exposure = new Float64Array(n);
  const lastSeen = new Float64Array(n).fill(-1);
  const afciFirst = new Uint32Array(n);
  const ratedA = new Float64Array(n);
  const afciLimits: AfciLimitValues | null = variant.afci && n > 0 ? afciLimitValues(devices[0].protection.afci) : null;
  // The AFCI's downstream set, per device: lazily, for the netlist it was marked on.
  const downNetlist: (Netlist | null)[] = new Array<Netlist | null>(n).fill(null);
  const downMarks: Uint8Array[] = [];
  // The GFCI's and AFCI's terminal nodes in this topology (−1: not netlisted), for their records' voltages.
  const lineNode = new Int32Array(n).fill(-1);
  const pigtailNode = new Int32Array(n).fill(-1);
  const loadNode = new Int32Array(n).fill(-1);
  const loadNeutralNode = new Int32Array(n).fill(-1);

  devices.forEach((d, i) => {
    const p = d.params as PlugOnBreakerParams;
    const bag = d.bag;
    entity[i] = d.entity;
    handleOn[i] = d.state['on'] === true ? 1 : 0;
    // A trip survives only with the handle on: a save holding `tripped` with the handle off (which the
    // engine never writes) starts reset, as turning the handle off would have left it.
    tripped[i] = bag['tripped'] === true && handleOn[i] === 1 ? 1 : 0;
    cause[i] = tripped[i] === 1 ? causeCode(bag['tripCause']) : CAUSE_NONE;
    if (poles === 1) thermal[2 * i] = num(bag['thermal'], 0);
    else {
      thermal[2 * i] = num(bag['thermalL1'], 0);
      thermal[2 * i + 1] = num(bag['thermalL2'], 0);
    }
    magSince[i] = tripped[i] === 1 ? -1 : num(bag['magneticSinceTick'], -1);
    invRated2[i] = 1 / (p.ratedCurrentA * p.ratedCurrentA);
    invTau[i] = 1 / p.thermalTimeConstantS;
    tripAt[i] = p.ultimateTripRatio * p.ultimateTripRatio;
    ratedA[i] = p.ratedCurrentA;
    const band = p.magneticPickupMaxA - p.magneticPickupMinA;
    // Pole 1 from the entity's own stream (P2's rule), pole 2 from its `pickupL2` stream: first outputs.
    pickupA[2 * i] = p.magneticPickupMinA + band * d.stream().nextFloat();
    if (poles === 2) pickupA[2 * i + 1] = p.magneticPickupMinA + band * d.purposeStream('pickupL2').nextFloat();
    pickup2[2 * i] = pickupA[2 * i] * pickupA[2 * i];
    pickup2[2 * i + 1] = pickupA[2 * i + 1] * pickupA[2 * i + 1];
    openingTicks[i] = drawTicksInBand(d.purposeStream('opening'), p.openingTimeMinMs, p.openingTimeMaxMs);
    const parts = POLE_PARTS[poles];
    d.parts.forEach((part, k) => {
      const at = parts.indexOf(part);
      if (at >= 0) hot[2 * i + at] = d.branches[k];
      else if (part === 'neutral') neutral[i] = d.branches[k];
    });
    testSeen[i] = num(d.state['test'], 0);
    if (variant.gfci || variant.afci) {
      lineNode[i] = d.terminalNode('line');
      pigtailNode[i] = d.terminalNode('pigtail');
      loadNode[i] = d.terminalNode('load');
      loadNeutralNode[i] = d.terminalNode('loadNeutral');
    }
    if (sensor !== null) {
      const g = d.params as GfciBreakerParams;
      sensor.init(
        i,
        {
          pickupMinA: g.residualPickupMinA,
          pickupMaxA: g.residualPickupMaxA,
          mechanismMinMs: g.mechanismTimeMinMs,
          mechanismMaxMs: g.mechanismTimeMaxMs,
        },
        d.purposeStream('gfciPickup'),
        d.purposeStream('gfciMechanism'),
        bag,
      );
    }
    if (variant.afci) {
      exposure[i] = num(bag['arcExposure'], 0);
      lastSeen[i] = num(bag['arcLastSeenTick'], -1);
      afciFirst[i] = d.purposeStream('afci').nextU32();
    }
    downMarks.push(new Uint8Array(0));
  });

  /** Opens every pole of device `i` for `code`, and reports it. */
  const trip = (i: number, code: number, emit: LayerContext['emit']): void => {
    tripped[i] = 1;
    cause[i] = code;
    magSince[i] = -1;
    if (sensor !== null) sensor.tripped(i);
    emit('tripped', entity[i], { cause: TRIP_CAUSES[code - 1] });
  };

  /** Whether device `i`'s line-side electronics are powered in the last solution (line to pigtail). */
  const powered = (i: number, ctx: CommandedContext): boolean => {
    const h = hot[2 * i];
    const nb = neutral[i];
    if (h < 0 || nb < 0) return false;
    const branches = ctx.netlist.branches;
    const line = branches[h];
    const pigtail = branches[nb];
    if (line.island !== pigtail.island || !ctx.islandReadable(line.island)) return false;
    const v = ctx.solution.nodes;
    const re = v[2 * line.a] - v[2 * pigtail.a];
    const im = v[2 * line.a + 1] - v[2 * pigtail.a + 1];
    return re * re + im * im >= ELECTRONICS_MIN_V2;
  };

  /**
   * Device `i`'s (a closed AFCI's) downstream marks on `netlist`: the nodes reached from its `load` and
   * `loadNeutral` without crossing its own poles, marked once per netlist object (lazily: only while
   * some end is arcing).
   */
  const downstreamOf = (i: number, netlist: Netlist): Uint8Array => {
    if (downNetlist[i] !== netlist) {
      if (downMarks[i].length !== netlist.nodes.length) downMarks[i] = new Uint8Array(netlist.nodes.length);
      const h = netlist.branches[hot[2 * i]];
      const nb = netlist.branches[neutral[i]];
      markDownstream(netlist, [h.b, nb.b], [h.index, nb.index], downMarks[i]);
      downNetlist[i] = netlist;
    }
    return downMarks[i];
  };

  // --- the record (protocol 8) ---

  /**
   * Whether a netlisted end is arcing downstream of AFCI `i` now (its record's `arcingDownstream`): any
   * current, any island (an end's state is the connection bank's own, decided for its bucket). `false`
   * while open: with its poles open there is no load side to judge.
   */
  const arcingDownstream = (i: number, ctx: LayerContext): boolean => {
    if (hot[2 * i] < 0 || neutral[i] < 0) return false;
    const count = ctx.arcingCount();
    if (count === 0) return false;
    const netlist = ctx.netlist;
    const marks = downstreamOf(i, netlist);
    for (let k = 0; k < count; k++) {
      const branch = netlist.branches[ctx.arcingBranch(k)];
      if (marks[branch.a] !== 0 || marks[branch.b] !== 0) return true;
    }
    return false;
  };

  /** The record status of island `island` in the context's solution. */
  const islandCode = (ctx: LayerContext, island: number): number => readingStatusCode(ctx.islandStatus(island));

  /**
   * Writes |V(a) − V(b)| (RMS on AC) at `at` and returns `true` when both nodes are on one solved
   * island; else writes nothing and returns `false` (no reading). Never returns the double: a call V8
   * doesn't inline would box it.
   */
  const writeVoltsOf = (ctx: LayerContext, a: number, b: number, view: DataView, at: number): boolean => {
    if (a < 0 || b < 0) return false;
    const nodes = ctx.netlist.nodes;
    const island = nodes[a].island;
    if (nodes[b].island !== island || islandCode(ctx, island) !== READING_SOLVED) return false;
    writeVolts(ctx.solution.nodes, a, b, view, at);
    return true;
  };

  /** Device `i`'s `state` code: tripped, else the handle. */
  const stateCode = (i: number): number =>
    tripped[i] === 1 ? STATE_TRIPPED : handleOn[i] === 1 ? STATE_ON : STATE_OFF;

  /** Device `i`'s pole `p`: writes its |I| at `at` and returns its status (an open pole: 0 A, `solved`). */
  const writePole = (i: number, p: number, view: DataView, at: number, ctx: LayerContext): number => {
    const b = hot[2 * i + p];
    if (b < 0) return READING_SOLVED;
    const status = islandCode(ctx, ctx.netlist.branches[b].island);
    if (status === READING_SOLVED) view.setFloat64(at, Math.sqrt(amps2(ctx, b)) + 0, true);
    return status;
  };

  /**
   * A GFCI's or AFCI's sensed fields: `currentA` (at 0), `neutralCurrentA` (8), the GFCI's `residualMa`
   * (16), and the line- and load-side voltages at `voltsAt` and `voltsAt + 8`; returns the `readings`
   * bits. An open pole carries exactly 0 A (a reading), and none of the residual.
   */
  const writeSensed = (i: number, view: DataView, offset: number, ctx: LayerContext, voltsAt: number): number => {
    const s = ctx.solution.branches;
    let bits = 0;
    const h = hot[2 * i];
    let hotRe = 0;
    let hotIm = 0;
    let hotRead = true;
    if (h < 0) bits |= PLUG_ON_READING_CURRENT;
    else if (islandCode(ctx, ctx.netlist.branches[h].island) === READING_SOLVED) {
      hotRe = s[2 * h];
      hotIm = s[2 * h + 1];
      view.setFloat64(offset, Math.sqrt(hotRe * hotRe + hotIm * hotIm) + 0, true);
      bits |= PLUG_ON_READING_CURRENT;
    } else hotRead = false;
    const nb = neutral[i];
    if (nb >= 0 && islandCode(ctx, ctx.netlist.branches[nb].island) === READING_SOLVED) {
      view.setFloat64(offset + 8, Math.sqrt(amps2(ctx, nb)) + 0, true);
      bits |= PLUG_ON_READING_NEUTRAL_CURRENT;
      if (sensor !== null && hotRead) {
        // What the sensor sees: |I_pole + I_neutral|, in mA.
        const re = hotRe + s[2 * nb];
        const im = hotIm + s[2 * nb + 1];
        view.setFloat64(offset + 16, 1000 * Math.sqrt(re * re + im * im) + 0, true);
        bits |= PLUG_ON_READING_RESIDUAL;
      }
    }
    if (writeVoltsOf(ctx, lineNode[i], pigtailNode[i], view, offset + voltsAt)) bits |= PLUG_ON_READING_LINE_VOLTAGE;
    if (writeVoltsOf(ctx, loadNode[i], loadNeutralNode[i], view, offset + voltsAt + 8)) {
      bits |= PLUG_ON_READING_LOAD_VOLTAGE;
    }
    return bits;
  };

  /** A GFCI's or AFCI's status: its pole's island while closed, its line terminal's while open. */
  const sensedStatus = (i: number, ctx: LayerContext): number => {
    const h = hot[2 * i];
    if (h >= 0) return islandCode(ctx, ctx.netlist.branches[h].island);
    const line = lineNode[i];
    return line < 0 ? READING_UNSOLVED : islandCode(ctx, ctx.netlist.nodes[line].island);
  };

  /**
   * Device `i`'s record (its variant's schema) at `offset`; the bytes arrive zeroed. Everything follows
   * from the bank's state and the solution (ADR 0011 §5.5). Allocates nothing, except an AFCI's
   * downstream marks the first time an end arcs on a new netlist.
   */
  const writeRecord = (i: number, view: DataView, offset: number, ctx: LayerContext): void => {
    const k = 2 * i;
    if (sensor !== null) {
      const bits = writeSensed(i, view, offset, ctx, 24);
      view.setFloat64(offset + 40, thermal[k] / tripAt[i], true);
      view.setFloat64(offset + 48, pickupA[k], true);
      view.setFloat64(offset + 56, openingTicks[i], true);
      view.setFloat64(offset + 64, 1000 * sensor.pickupA[i], true);
      view.setFloat64(offset + 72, sensor.integral[i], true);
      view.setUint8(offset + 80, stateCode(i));
      view.setUint8(offset + 81, cause[i]);
      view.setUint8(offset + 82, sensor.testHeld[i] >= 0 ? 1 : 0);
      view.setUint8(offset + 83, bits);
      view.setUint8(offset + 84, sensedStatus(i, ctx));
      return;
    }
    if (variant.afci) {
      const bits = writeSensed(i, view, offset, ctx, 16);
      view.setFloat64(offset + 32, thermal[k] / tripAt[i], true);
      view.setFloat64(offset + 40, pickupA[k], true);
      view.setFloat64(offset + 48, openingTicks[i], true);
      view.setFloat64(offset + 56, exposure[i], true);
      view.setUint8(offset + 64, stateCode(i));
      view.setUint8(offset + 65, cause[i]);
      view.setUint8(offset + 66, arcingDownstream(i, ctx) ? 1 : 0);
      view.setUint8(offset + 67, bits);
      view.setUint8(offset + 68, sensedStatus(i, ctx));
      return;
    }
    if (poles === 1) {
      const status = writePole(i, 0, view, offset, ctx);
      view.setFloat64(offset + 8, thermal[k] / tripAt[i], true);
      view.setFloat64(offset + 16, pickupA[k], true);
      view.setFloat64(offset + 24, openingTicks[i], true);
      view.setUint8(offset + 32, stateCode(i));
      view.setUint8(offset + 33, cause[i]);
      view.setUint8(offset + 34, status);
      return;
    }
    // Two poles: `solved` only when both are, else the first pole's status that isn't.
    const s1 = writePole(i, 0, view, offset, ctx);
    const s2 = writePole(i, 1, view, offset + 8, ctx);
    view.setFloat64(offset + 16, thermal[k] / tripAt[i], true);
    view.setFloat64(offset + 24, thermal[k + 1] / tripAt[i], true);
    view.setFloat64(offset + 32, pickupA[k], true);
    view.setFloat64(offset + 40, pickupA[k + 1], true);
    view.setFloat64(offset + 48, openingTicks[i], true);
    view.setUint8(offset + 56, stateCode(i));
    view.setUint8(offset + 57, cause[i]);
    view.setUint8(offset + 58, s1 !== READING_SOLVED ? s1 : s2);
  };

  /**
   * Device `i` (an AFCI) at a bucket boundary: counts the bucket that just ended if an end downstream of
   * it arced at 5 A or more, and returns whether it trips (D8). Allocates only when some end is arcing
   * and the netlist changed since its downstream set was marked.
   */
  const arcBoundary = (i: number, ctx: LayerContext, readable: boolean): boolean => {
    const tick = ctx.tick;
    let largest = 0;
    if (readable) {
      const count = ctx.arcingCount();
      if (count > 0) {
        const netlist = ctx.netlist;
        const marks = downstreamOf(i, netlist);
        for (let k = 0; k < count; k++) {
          const b = ctx.arcingBranch(k);
          const branch = netlist.branches[b];
          if (marks[branch.a] === 0 && marks[branch.b] === 0) continue;
          if (!ctx.islandReadable(branch.island)) continue;
          const s = ctx.solution.branches;
          largest = Math.max(largest, Math.sqrt(s[2 * b] * s[2 * b] + s[2 * b + 1] * s[2 * b + 1]));
        }
      }
    }
    const buckets = largest > 0 ? afciDetectionBuckets(largest, ratedA[i], afciLimits as AfciLimitValues) : 0;
    if (buckets === 0) {
      // Only arcing buckets count (D8); the exposure is forgotten a quiet gap after the last one.
      if (lastSeen[i] >= 0 && tick - lastSeen[i] >= QUIET_TICKS) {
        exposure[i] = 0;
        lastSeen[i] = -1;
      }
      return false;
    }
    const before = exposure[i];
    const after = Math.min(1, before + 1 / buckets);
    exposure[i] = after;
    lastSeen[i] = tick;
    // The bucket that just ended is the one the arcing was decided for (ADR 0018 §6).
    return after >= 1 || afciDraw(afciFirst[i], intermittentBucket(tick - 1)) < (after - before) / (1 - before);
  };

  return {
    bag: (i) => {
      const bag: Record<string, DeviceStateValue> = {
        magneticSinceTick: magSince[i] < 0 ? null : magSince[i],
        tripCause: cause[i] === CAUSE_NONE ? null : TRIP_CAUSES[cause[i] - 1],
        tripped: tripped[i] === 1,
      };
      if (poles === 1) bag['thermal'] = thermal[2 * i];
      else {
        bag['thermalL1'] = thermal[2 * i];
        bag['thermalL2'] = thermal[2 * i + 1];
      }
      if (sensor !== null) sensor.bagInto(i, bag as Record<string, number | null>);
      if (variant.afci) {
        bag['arcExposure'] = exposure[i];
        bag['arcLastSeenTick'] = lastSeen[i] < 0 ? null : lastSeen[i];
      }
      return bag;
    },
    simValue: (i, key) => {
      if (key === 'tripped') return tripped[i] === 1;
      if (key === 'testHeldSinceTick' && sensor !== null) return sensor.testHeld[i] < 0 ? null : sensor.testHeld[i];
      return undefined;
    },
    commanded: (i, state, ctx) => {
      handleOn[i] = state['on'] === true ? 1 : 0;
      // Turning the handle off resets a trip (it closes when turned on again).
      if (handleOn[i] === 0 && tripped[i] === 1) {
        tripped[i] = 0;
        cause[i] = CAUSE_NONE;
      }
      if (!variant.gfci && !variant.afci) return;
      // A press is the counter rising above the bank's copy; an undo lowers it and presses nothing.
      const count = num(state['test'], 0);
      const pressed = count > testSeen[i];
      testSeen[i] = count;
      if (!pressed) return;
      if (sensor !== null) {
        // The test contact closes now: its resistor is in the netlist compiled at this tick.
        sensor.testHeld[i] = ctx.tick;
      } else if (handleOn[i] === 1 && tripped[i] === 0 && powered(i, ctx)) {
        trip(i, CAUSE_TEST, ctx.emit);
      }
    },
    writeRecord,
    protection: (ctx) => {
      let changed = false;
      const dt = ctx.dtS;
      const tick = ctx.tick;
      const branches = ctx.netlist.branches;
      const s = ctx.solution.branches;
      if (sensor !== null) sensor.dtS[0] = dt;
      const boundary = variant.afci && tick % BUCKET_TICKS === 0;
      for (let i = 0; i < n; i++) {
        // Whether the test was held over this step (its resistor drew this step's residual): the cause of
        // a trip at this step, even on the step the hold lets go.
        const held = sensor !== null && sensor.testHeld[i] >= 0;
        // A held test lets go after the hold (a topology change), whatever else happens.
        if (held && tick + 1 - (sensor as GfciSensor).testHeld[i] >= HOLD_TICKS) {
          (sensor as GfciSensor).testHeld[i] = -1;
          changed = true;
        }
        const h0 = hot[2 * i];
        if (h0 < 0) {
          // Open (off or tripped): no current, every bimetal cools, no excursion.
          for (let p = 0; p < poles; p++) {
            const k = 2 * i + p;
            thermal[k] = Math.max(0, thermal[k] - dt * invTau[i] * thermal[k]) + 0;
          }
          magSince[i] = -1;
          if (sensor !== null) sensor.quiet(i);
          if (boundary) arcBoundary(i, ctx, false);
          continue;
        }
        // Closed: an unknown current (an unsolved or unsettled island) freezes everything.
        if (!ctx.islandReadable(branches[h0].island)) continue;
        if (poles === 2 && !ctx.islandReadable(branches[hot[2 * i + 1]].island)) continue;
        const nb = neutral[i];
        if (nb >= 0 && !ctx.islandReadable(branches[nb].island)) continue;
        let above = false;
        let hotThermal = false;
        for (let p = 0; p < poles; p++) {
          const k = 2 * i + p;
          // |I|² read in place: a helper returning it boxes the double when it isn't inlined (gfci.ts).
          const hb = hot[k];
          const i2 = s[2 * hb] * s[2 * hb] + s[2 * hb + 1] * s[2 * hb + 1];
          thermal[k] = Math.max(0, thermal[k] + dt * invTau[i] * (i2 * invRated2[i] - thermal[k])) + 0;
          if (i2 >= pickup2[k]) above = true;
          if (thermal[k] >= tripAt[i]) hotThermal = true;
        }
        let code = CAUSE_NONE;
        if (above) {
          if (magSince[i] < 0) magSince[i] = tick;
          // Open at the state tick `magneticSinceTick + opening`: this step's end.
          if (tick + 1 - magSince[i] >= openingTicks[i]) code = CAUSE_MAGNETIC;
        } else magSince[i] = -1;
        if (code === CAUSE_NONE && hotThermal) code = CAUSE_THERMAL;
        if (sensor !== null) {
          const re = s[2 * h0] + s[2 * nb];
          const im = s[2 * h0 + 1] + s[2 * nb + 1];
          sensor.residualA[i] = Math.sqrt(re * re + im * im);
          if (sensor.step(i, tick) && code === CAUSE_NONE) {
            code = held ? CAUSE_TEST : CAUSE_GROUND_FAULT;
          }
        }
        if (boundary && arcBoundary(i, ctx, true) && code === CAUSE_NONE) code = CAUSE_ARC_FAULT;
        if (code !== CAUSE_NONE) {
          trip(i, code, ctx.emit);
          changed = true;
        }
      }
      return changed;
    },
  };
}

/** `breaker.plugOn1p`: a single-pole plug-on breaker. */
export const PLUG_ON_1P_MODEL: SimDeviceModel = plugOnModel({
  kind: 'breaker.plugOn1p',
  poles: 1,
  gfci: false,
  afci: false,
});

/** `breaker.plugOn2p`: a two-pole plug-on breaker, one bimetal and pickup per pole, a common trip. */
export const PLUG_ON_2P_MODEL: SimDeviceModel = plugOnModel({
  kind: 'breaker.plugOn2p',
  poles: 2,
  gfci: false,
  afci: false,
});

/** `breaker.gfci1p`: a plug-on GFCI breaker. */
export const GFCI_BREAKER_MODEL: SimDeviceModel = plugOnModel({
  kind: 'breaker.gfci1p',
  poles: 1,
  gfci: true,
  afci: false,
});

/** `breaker.afci1p`: a plug-on combination AFCI breaker. */
export const AFCI_BREAKER_MODEL: SimDeviceModel = plugOnModel({
  kind: 'breaker.afci1p',
  poles: 1,
  gfci: false,
  afci: true,
});
