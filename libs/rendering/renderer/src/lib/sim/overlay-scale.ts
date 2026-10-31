import { NEC_REGION, type NominalSystem, type RegionProfile } from '@controls/catalog';

/*
 * The debug overlays' scales (plan F2.6, ADR 0011 §9.2): a fixed voltage scale for each nominal band,
 * one current scale, 32 bins plus an over-range bin, half-step hysteresis, the colour ramp and the
 * legend. Pure (lint-fenced: no three, DOM or clock), so it is unit-tested in Node.
 *
 * **Band 0 (`none`) means "no scale"** (#52 review): an island in band 0, or in a band this table has
 * no scale for, gets no voltage colour at all ({@link STEP_NO_SCALE}), never the first bin of some
 * scale. Islands whose values are not a reading get {@link STEP_UNKNOWN}, never a 0 V or 0 A colour.
 * The band of an island is chosen by the engine (`NOMINAL_BANDS`, by index in the snapshot); the
 * renderer only looks its name up here, so the scales stay data-driven and a new band is a new row.
 */

/** In-range bins per scale (ADR 0011 §9.2). */
export const OVERLAY_BINS = 32;
/** The over-range bin: above the scale's full scale. */
export const OVER_RANGE_BIN = OVERLAY_BINS;
/** A display step that is not a bin: the island is in band 0 (or an unknown band), so it has no voltage scale. */
export const STEP_NO_SCALE = 253;
/** A display step that is not a bin: no reading (the island isn't `solved`, or the item isn't in this generation's netlist). */
export const STEP_UNKNOWN = 254;

/** A sourced value of a scale (realism charter, plan §3). */
export interface ScaleValue {
  readonly value: number;
  readonly unit: string;
  readonly kind: 'real-world' | 'game-design';
  readonly source: string;
}

/** A voltage overlay scale: linear from 0 V to `fullScaleV`, for one nominal band. */
export interface VoltageScale {
  /** The `NOMINAL_BANDS` name this scale is for. */
  readonly band: string;
  /** How the legend names the system (`12 V DC`, `208Y/120 V AC`). */
  readonly title: string;
  readonly kind: 'dc' | 'ac';
  /**
   * The nominal voltage a healthy reading shows against the island reference: the DC nominal, and for
   * AC the **line-to-neutral** voltage, since an AC source's reference node is its neutral (so a
   * 120/240 V line reads 120 V, not 240 V). Line-to-line voltages reach up to √3 or 2 × this and read
   * high on the scale or over range; the title still names the system.
   */
  readonly nominalV: ScaleValue;
  /** The top of the in-range bins; above it is the over-range bin. */
  readonly fullScaleV: ScaleValue;
}

/**
 * Game-design: full scale is 4/3 of the band's nominal (line to neutral for AC), so the nominal value sits at
 * three quarters of the bar (bin 24) and a healthy supply (ANSI C84.1 range B tops out at about
 * +5.8 %; a charging lead-acid battery or a 24 V supply at its +20 % tolerance stays under +33 %)
 * never reads over range. A spec checks the region's range B against it.
 */
export const FULL_SCALE_OF_NOMINAL: ScaleValue = {
  value: 4 / 3,
  unit: '1',
  kind: 'game-design',
  source:
    'Game-design: full scale = 4/3 × the band nominal, so the nominal voltage reads at three quarters of the scale and every healthy steady-state supply (ANSI C84.1 range B, from the region profile) stays in range.',
};

const fullScale = (nominal: ScaleValue): ScaleValue => ({
  value: nominal.value * FULL_SCALE_OF_NOMINAL.value,
  unit: 'V',
  kind: 'game-design',
  source: `${FULL_SCALE_OF_NOMINAL.source} Nominal: ${nominal.value} V.`,
});

const dcScale = (band: string, volts: number, source: string): VoltageScale => {
  const nominalV: ScaleValue = { value: volts, unit: 'V', kind: 'real-world', source };
  return { band, title: `${volts} V DC`, kind: 'dc', nominalV, fullScaleV: fullScale(nominalV) };
};

const acScale = (band: string, system: NominalSystem): VoltageScale => {
  const nominalV: ScaleValue = { ...system.lineToNeutralV };
  return { band, title: `${system.name} AC`, kind: 'ac', nominalV, fullScaleV: fullScale(nominalV) };
};

/**
 * The voltage scales of a region's nominal bands, by `NOMINAL_BANDS` name. The AC bands come from
 * the region profile (`@controls/catalog`, ANSI C84.1 nominal systems); the region profile has no DC
 * systems, so the two extra-low-voltage DC bands cite the device classes the catalogue nameplates
 * (a spec checks those entries against them).
 */
export function voltageScales(region: RegionProfile = NEC_REGION): Readonly<Record<string, VoltageScale>> {
  const scales = [
    dcScale(
      'dc12',
      12,
      'The 12 V nominal of a six-cell lead-acid battery (6 × 2 V cells), the class of the catalogue battery battery.ferrovane-12v-7ah (its nominalVoltageV).',
    ),
    dcScale(
      'dc24',
      24,
      'The 24 V DC nominal of industrial control power, the supply voltage IEC 61131-2 rates PLC inputs and outputs for, and the class of the catalogue DIN-rail supply supply.railwick-din-24v-5a (its ratedVoltageV).',
    ),
    acScale('ac120-240', region.splitPhase),
    acScale('ac208y120', region.threePhaseCommercial),
    acScale('ac480y277', region.threePhaseIndustrial),
  ];
  return Object.freeze(Object.fromEntries(scales.map((s) => [s.band, Object.freeze(s)])));
}

/** The NEC region's voltage scales. */
export const VOLTAGE_SCALES = voltageScales();

/**
 * The voltage scale of each `NOMINAL_BANDS` index (`null` for band 0 and for any band without a
 * scale): resolve once per bands table, then index by the snapshot's band byte.
 */
export function scalesByBand(
  bands: readonly string[],
  scales: Readonly<Record<string, VoltageScale>> = VOLTAGE_SCALES,
): readonly (VoltageScale | null)[] {
  return bands.map((name, index) =>
    index === 0 || !Object.prototype.hasOwnProperty.call(scales, name) ? null : scales[name],
  );
}

/** The current overlay's scale: logarithmic, independent of the band (current follows the load, not the supply). */
export interface CurrentScale {
  /** Bin 0 is below this: no visible flow (gmin-level and leakage currents). */
  readonly minA: ScaleValue;
  /** The top of the in-range bins. */
  readonly maxA: ScaleValue;
}

export const CURRENT_SCALE: CurrentScale = Object.freeze<CurrentScale>({
  minA: {
    value: 1e-3,
    unit: 'A',
    kind: 'game-design',
    source:
      'Game-design: 1 mA, the smallest current the overlay shows as flowing; below it (leakage, gmin) nothing moves.',
  },
  maxA: {
    value: 100,
    unit: 'A',
    kind: 'game-design',
    source:
      'Game-design: 100 A, five decades above the minimum, past any P2 bench load (a 5 W lamp draws about 0.4 A, its cold inrush about 6 A) and a fault short, which reads over range.',
  },
});

/** A voltage as a continuous bin coordinate: 0 at 0 V, {@link OVERLAY_BINS} at full scale. */
export function voltageCoordinate(volts: number, scale: VoltageScale): number {
  return (Math.abs(volts) * OVERLAY_BINS) / scale.fullScaleV.value;
}

/**
 * A current as a continuous bin coordinate: linear below the minimum (bin 0), then bins 1 to 31
 * logarithmic from the minimum to the maximum, and {@link OVERLAY_BINS} at the maximum.
 */
export function currentCoordinate(amps: number, scale: CurrentScale = CURRENT_SCALE): number {
  const a = Math.abs(amps);
  const min = scale.minA.value;
  if (a < min) return a / min;
  return 1 + ((OVERLAY_BINS - 1) * Math.log10(a / min)) / Math.log10(scale.maxA.value / min);
}

/** The bin of a coordinate, with no hysteresis: 0 to 31 in range, {@link OVER_RANGE_BIN} at or above full scale. */
export function binOf(coordinate: number): number {
  return coordinate >= OVERLAY_BINS ? OVER_RANGE_BIN : Math.max(0, Math.floor(coordinate));
}

/**
 * The bin of a coordinate with half-step hysteresis (ADR 0011 §9.2): the previous bin is kept while
 * the coordinate stays within half a bin of it, so a value sitting on a boundary doesn't flicker
 * (and doesn't ask for a frame on every snapshot). `previous` may be any step; only a bin holds.
 */
export function binWithHysteresis(coordinate: number, previous: number): number {
  if (previous >= 0 && previous <= OVER_RANGE_BIN && coordinate >= previous - 0.5) {
    if (previous === OVER_RANGE_BIN || coordinate < previous + 1.5) return previous;
  }
  return binOf(coordinate);
}

// --- colours (renderer-local looks) ------------------------------------------------------------

/** Control points of the in-range ramp: a viridis-like sequential map, readable with the common colour-vision deficiencies. */
const RAMP = [0x440154, 0x3b528b, 0x21918c, 0x5ec962, 0xfde725] as const;
/** Over range: a hue the ramp never reaches. */
export const OVER_RANGE_COLOUR = 0xff3df5;
/** Band 0 (no scale): a light neutral, solid. */
export const NO_SCALE_COLOUR = 0xa7adb4;
/** No reading: a dark neutral, drawn thinner and with diamond markers, so it isn't colour-only. */
export const UNKNOWN_COLOUR = 0x50555c;
/** Terminals highlighted by the netlist inspector (view state). */
export const HIGHLIGHT_COLOUR = 0xffb000;

const channel = (c: number, shift: number) => (c >> shift) & 0xff;

/** The colour of a display step: a ramp colour for bins 0 to 31, then over range, no scale and unknown. */
export function stepColour(step: number): number {
  if (step === STEP_UNKNOWN) return UNKNOWN_COLOUR;
  if (step === STEP_NO_SCALE) return NO_SCALE_COLOUR;
  if (step >= OVER_RANGE_BIN) return OVER_RANGE_COLOUR;
  const t = (Math.max(0, step) / (OVERLAY_BINS - 1)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(t));
  const f = t - i;
  let out = 0;
  for (const shift of [16, 8, 0]) {
    const a = channel(RAMP[i], shift);
    const b = channel(RAMP[i + 1], shift);
    out |= Math.round(a + (b - a) * f) << shift;
  }
  return out;
}

/** `#rrggbb` of a colour, for the legend. */
export const cssColour = (colour: number): string => `#${colour.toString(16).padStart(6, '0')}`;

// --- legend ----------------------------------------------------------------------------------

/** One labelled point on a legend bar. */
export interface LegendTick {
  /** The bin the label sits at (0 to {@link OVERLAY_BINS}). */
  readonly bin: number;
  readonly label: string;
}

/** A legend scale: a bar of {@link OVERLAY_BINS} ramp colours with labelled ticks, plus over range. */
export interface LegendScale {
  readonly title: string;
  readonly ticks: readonly LegendTick[];
  /** The over-range swatch's label (`over 16 V`). */
  readonly overRange: string;
  /** The ramp, low to high, as CSS colours. */
  readonly colours: readonly string[];
}

/** Three significant figures, no trailing zeros, with `unit` (`7.5 V`, `277 V`, `0.01 A` → `10 mA`). */
export function formatQuantity(value: number, unit: 'V' | 'A'): string {
  if (value === 0) return `0 ${unit}`;
  const milli = Math.abs(value) < 1;
  const v = milli ? value * 1000 : value;
  return `${Number(v.toPrecision(3))} ${milli ? 'm' : ''}${unit}`;
}

const RAMP_CSS: readonly string[] = Array.from({ length: OVERLAY_BINS }, (_, bin) => cssColour(stepColour(bin)));

/** The legend of a voltage scale: ticks at each quarter, the nominal at three quarters. */
export function voltageLegend(scale: VoltageScale): LegendScale {
  const full = scale.fullScaleV.value;
  return {
    title: `|V| to the island reference, ${scale.title} scale`,
    ticks: [0, 1, 2, 3, 4].map((q) => ({
      bin: (q * OVERLAY_BINS) / 4,
      label: formatQuantity((full * q) / 4, 'V') + (q === 3 ? ' (nominal)' : ''),
    })),
    overRange: `over ${formatQuantity(full, 'V')}`,
    colours: RAMP_CSS,
  };
}

/** The legend of the current scale: a tick at each decade. */
export function currentLegend(scale: CurrentScale = CURRENT_SCALE): LegendScale {
  const ticks: LegendTick[] = [];
  for (let a = scale.minA.value; a <= scale.maxA.value * 1.000001; a *= 10) {
    ticks.push({ bin: Math.round(currentCoordinate(a, scale)), label: formatQuantity(a, 'A') });
  }
  return {
    title: '|I| along each lead (log scale)',
    ticks,
    overRange: `over ${formatQuantity(scale.maxA.value, 'A')}`,
    colours: RAMP_CSS,
  };
}

// --- current animation -------------------------------------------------------------------------

/** Game-design: how far apart current arrows are along a lead (mm), and at most how many a lead gets. */
export const ARROW_SPACING_MM = 60;
export const MAX_ARROWS_PER_LEAD = 12;

/** How many arrows a lead of `lengthMm` carries: one per spacing, at least one, at most {@link MAX_ARROWS_PER_LEAD}. */
export function arrowCount(lengthMm: number): number {
  return Math.max(1, Math.min(MAX_ARROWS_PER_LEAD, Math.floor(lengthMm / ARROW_SPACING_MM)));
}

/**
 * Game-design: the arrows' speed along a lead, in mm per second, from the current bin: still at bin 0
 * (no visible flow), 20 mm/s at bin 1, rising linearly to 200 mm/s over range. Speed shows magnitude
 * only; it is not a drift velocity.
 */
export function arrowSpeedMmPerS(bin: number): number {
  if (bin <= 0 || bin > OVER_RANGE_BIN) return 0;
  return 20 + (180 * (bin - 1)) / (OVER_RANGE_BIN - 1);
}

/**
 * Where arrow `k` of `count` sits along a lead, as a fraction 0…1 from its start, at animation phase
 * `phaseMm` (advanced by speed × time, wrapping at one spacing). With `phaseMm` 0 (reduced motion, a
 * paused sim) the arrows are evenly spaced and still.
 */
export function arrowFraction(k: number, count: number, phaseMm: number, lengthMm: number): number {
  const spacing = lengthMm / count;
  const at = (k + 0.5) * spacing + (phaseMm % spacing);
  return (at % lengthMm) / lengthMm;
}

/**
 * AC current has no direction to show (rendering caveats): its markers sway half a spacing about
 * their rest points instead of travelling, at a rate from the bin. Returns the offset in mm for a
 * sway phase in radians-free units (cycles).
 */
export function swayOffsetMm(cycles: number, lengthMm: number, count: number): number {
  const spacing = lengthMm / count;
  // A triangle wave (no transcendental needed): 0 → +¼ → 0 → −¼ of a spacing per cycle.
  const c = cycles - Math.floor(cycles);
  const tri = c < 0.25 ? c : c < 0.75 ? 0.5 - c : c - 1;
  return tri * spacing;
}
