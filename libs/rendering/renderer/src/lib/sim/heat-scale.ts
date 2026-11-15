import { BUILTIN_CATALOG, type Catalog, type CatalogSource, coversPath, type TableDocument } from '@controls/catalog';
import {
  CONNECTION_AMBIENT_K,
  CONNECTION_INSULATION_DAMAGE_MARGIN_K,
  CONNECTION_OVERHEAT_RISE_K,
  CONNECTION_OXIDATION_ONSET_K,
} from '@controls/sim-protocol';
import {
  binOf,
  cssColour,
  type LegendScale,
  OVER_RANGE_BIN,
  OVER_RANGE_COLOUR,
  OVERLAY_BINS,
  rampColour,
  type ScaleValue,
  STEP_UNKNOWN,
  UNKNOWN_COLOUR,
} from './overlay-scale';

/*
 * The heat overlay's scale (plan F3.6 part 3, D15): a conductor or lead temperature as a display
 * step, on the overlays' 32 bins plus over range, with the legend. Pure (lint-fenced: no three, DOM or
 * clock), so it is unit-tested in Node.
 *
 * **Every temperature on it is sourced, and none is new.** The scale is piecewise linear through
 * named points, each a constant the engine or the catalogue already carries with its source, and
 * **every named point is a knot at a whole bin**, so crossing it is a bin boundary:
 *
 * - the ambient, `CONNECTION_AMBIENT_K` (sim-protocol's copy of sim-core's `AMBIENT_TEMPERATURE_K`);
 * - the lowest insulation rating: the lowest dry rating (`ratedTempDryK`) among the catalogue's
 *   `insulation` rows (every P3 row is 90 °C). One scale serves every wire, so a wire with a higher
 *   rating reads "past the rating" early; a mixed-rating catalogue needs a per-wire normalised scale;
 * - the termination overheat point, ambient + `CONNECTION_OVERHEAT_RISE_K` (the engine's
 *   `terminationOverheat` threshold, anchored to NBS BSS 128);
 * - insulation damage, that lowest rating + `CONNECTION_INSULATION_DAMAGE_MARGIN_K` (where the engine
 *   sets `insulationDamaged`);
 * - the contact oxidation onset, `CONNECTION_OXIDATION_ONSET_K` (degradation starts, ADR 0018 §5);
 * - other metals' melting points (aluminium), at the whole bin nearest their linear place;
 * - the top: the highest melting point (`meltingPointK`) among the catalogue's `materials` rows
 *   (copper, an ITS-90 fixed point). At or above it reads over range.
 *
 * Which bin each fixed point sits at is game-design ({@link HEAT_KNOT_BINS}). The ambient, the
 * overheat point, the oxidation onset and the top must rise ({@link heatScale} throws otherwise); a
 * catalogue point that doesn't fit between its neighbours (an insulation rated at or above the
 * overheat point, a metal melting below the oxidation onset) is **omitted** with a reason the legend
 * shows, never a crash.
 *
 * **Hysteresis is in kelvin, not bins** ({@link HEAT_HYSTERESIS_K}; a deviation from ADR 0011 §9.2's
 * half-bin rule, for heat only). Above the overheat point a bin is tens of kelvin wide, so half-bin
 * hysteresis would hold a colour for tens of kelvin past a named point (a loose end at 393.8 K would
 * still read below the 393.15 K overheat mark). Crossing a named point changes the step within
 * {@link HEAT_HYSTERESIS_K} of it, both ways.
 */

/** A named point of the heat scale: a sourced temperature and the whole bin it sits at. */
export interface HeatKnot {
  /** What the legend calls it (`ambient`, `termination overheat`, …). */
  readonly name: string;
  readonly temperatureK: ScaleValue;
  /** Its bin (0 to {@link OVERLAY_BINS}, whole); the last knot is the top of the scale. */
  readonly bin: number;
}

export interface HeatScale {
  /** Strictly increasing in temperature and bin, from ambient (bin 0) to the top ({@link OVERLAY_BINS}). */
  readonly knots: readonly HeatKnot[];
  /** Catalogue points left out because they don't fit between their neighbours, with why (legend text). */
  readonly omitted: readonly string[];
}

const binValue = (value: number, source: string): ScaleValue => ({ value, unit: 'bin', kind: 'game-design', source });

/**
 * Game-design: where the fixed knots sit. Ambient is bin 0 and the top is the over-range boundary
 * ({@link OVERLAY_BINS}). The lowest insulation rating at bin 12 gives the service range (70 K on the
 * P3 catalogue) about 6 K a bin; the termination overheat point at 16 puts everything past the
 * engine's warning in the upper half; insulation damage at 18 and the oxidation onset at 20 give the
 * 10 K and 19 K between them two bins each; the remaining 12 bins climb to melting (about 78 K a bin).
 */
export const HEAT_KNOT_BINS = Object.freeze({
  rating: binValue(
    12,
    'Game-design: the lowest insulation rating at bin 12 of 32, so the service range reads in fine steps.',
  ),
  overheat: binValue(16, 'Game-design: the termination overheat point (ambient + 100 K) at the middle of the bar.'),
  insulationDamage: binValue(
    18,
    'Game-design: insulation damage (lowest rating + 40 K) two bins above the overheat point.',
  ),
  oxidation: binValue(20, 'Game-design: the contact oxidation onset two bins above insulation damage.'),
});

/**
 * Game-design: the heat steps' hysteresis. A step holds while its temperature stays within this of
 * the step's own temperature range, so a node sitting on a boundary doesn't flicker; 0.5 K is below
 * the readouts' whole-kelvin precision, and engine temperatures move smoothly (thermal time constants
 * of seconds), so it never needs more.
 */
export const HEAT_HYSTERESIS_K: ScaleValue = Object.freeze({
  value: 0.5,
  unit: 'K',
  kind: 'game-design',
  source:
    'Game-design: half a kelvin, below the readouts’ whole-kelvin precision, so a named point’s crossing shows within 0.5 K either way while a node resting on a boundary doesn’t flicker.',
});

/** The heat ramp's control points (renderer-local looks): an inferno-like map, dark violet through red and orange to pale yellow. */
const HEAT_RAMP = [0x420a68, 0x932667, 0xdd513a, 0xfca50a, 0xfcffa4] as const;

const AMBIENT: ScaleValue = {
  value: CONNECTION_AMBIENT_K,
  unit: 'K',
  kind: 'game-design',
  source:
    'sim-core AMBIENT_TEMPERATURE_K (game-design: the workshop at 20 °C, the IACS reference temperature), copied as sim-protocol CONNECTION_AMBIENT_K; every conductor, lead and termination heats from it (ADR 0018 §3).',
};

const OVERHEAT: ScaleValue = {
  value: CONNECTION_AMBIENT_K + CONNECTION_OVERHEAT_RISE_K,
  unit: 'K',
  kind: 'game-design',
  source:
    'Ambient + sim-core TERMINATION_OVERHEAT_RISE_K (100 K; game-design anchored to NBS BSS 128’s 100 °C connection temperature-rise criterion, ADR 0018 §6), copied as sim-protocol CONNECTION_OVERHEAT_RISE_K: the engine’s terminationOverheat threshold.',
};

const OXIDATION: ScaleValue = {
  value: CONNECTION_OXIDATION_ONSET_K,
  unit: 'K',
  kind: 'game-design',
  source:
    'sim-core OXIDATION_ONSET_K (149 °C; game-design anchored to CPSC Publication 516’s fire-hazard screw temperature, ADR 0018 §5), copied as sim-protocol CONNECTION_OXIDATION_ONSET_K: a termination degrades above it.',
};

/** The source of a table row field, from the table's own sources (`rows.<key>.<field>` or a `*` cover). */
function rowSource(table: TableDocument, key: string, field: string): CatalogSource | undefined {
  const path = `rows.${key}.${field}`;
  return table.sources.find((s) => s.covers.some((c) => coversPath(c, path)));
}

interface RowValue {
  readonly value: number;
  readonly source: CatalogSource;
  readonly table: string;
  readonly key: string;
}

/** Every numeric `field` of `tableName`'s rows, over all its versions. Throws for a value without a source. */
function rowValues(catalog: Pick<Catalog, 'tables'>, tableName: string, field: string): RowValue[] {
  const out: RowValue[] = [];
  for (const table of catalog.tables) {
    if (table.table !== tableName) continue;
    for (const [key, row] of Object.entries(table.rows)) {
      const value = row[field];
      if (typeof value !== 'number') continue;
      const source = rowSource(table, key, field);
      const at = `${table.table}@${table.version}`;
      if (source === undefined) throw new Error(`heatScale: table ${at} row ${key} ${field} has no source`);
      out.push({ value, source, table: at, key });
    }
  }
  return out;
}

const sourced = (row: RowValue, field: string, value = row.value, extra = ''): ScaleValue => ({
  value,
  unit: 'K',
  kind: row.source.kind,
  source: `Catalogue table ${row.table} row ${row.key} ${field}${extra} (source ${row.source.id}: ${row.source.citation})`,
});

/** A metal's short name for the legend (`copper`, `aluminium`): its row key's leading lower-case word. */
const metalName = (row: RowValue): string => /^[a-z]+/.exec(row.key)?.[0] ?? row.key;

const celsius = (kelvin: number) => `${Math.round(kelvin - 273.15)} °C`;

/**
 * The heat scale of `catalog`'s tables (the built-in catalogue by default). Throws only if the
 * catalogue has no insulation rating or melting point, a row value has no source, or the fixed points
 * (ambient, overheat, oxidation onset, the top melting point) don't rise; catalogue points that don't
 * fit are omitted ({@link HeatScale.omitted}).
 */
export function heatScale(catalog: Pick<Catalog, 'tables'> = BUILTIN_CATALOG): HeatScale {
  const ratings = rowValues(catalog, 'insulation', 'ratedTempDryK');
  const melts = rowValues(catalog, 'materials', 'meltingPointK');
  if (ratings.length === 0 || melts.length === 0) {
    throw new Error('heatScale: the catalogue has no insulation rating or no melting point');
  }
  const rating = ratings.reduce((low, r) => (r.value < low.value ? r : low));
  const top = melts.reduce((high, r) => (r.value > high.value ? r : high));
  const topKnot: HeatKnot = {
    name: `${metalName(top)} melts`,
    temperatureK: sourced(top, 'meltingPointK'),
    bin: OVERLAY_BINS,
  };
  const fixed: HeatKnot[] = [
    { name: 'ambient', temperatureK: AMBIENT, bin: 0 },
    { name: 'termination overheat', temperatureK: OVERHEAT, bin: HEAT_KNOT_BINS.overheat.value },
    { name: 'contact oxidation onset', temperatureK: OXIDATION, bin: HEAT_KNOT_BINS.oxidation.value },
    topKnot,
  ];
  for (let k = 1; k < fixed.length; k++) {
    if (!(fixed[k].temperatureK.value > fixed[k - 1].temperatureK.value)) {
      throw new Error(
        `heatScale: ${fixed[k].name} (${fixed[k].temperatureK.value} K) is not above ${fixed[k - 1].name} (${fixed[k - 1].temperatureK.value} K)`,
      );
    }
  }
  const [ambient, overheat, oxidation] = fixed;
  const omitted: string[] = [];
  const knots: HeatKnot[] = [ambient];
  // The lowest insulation rating, between ambient and the overheat point.
  const ratingK = rating.value;
  if (ratingK > ambient.temperatureK.value && ratingK < overheat.temperatureK.value) {
    knots.push({
      name: 'lowest insulation rating in the catalogue',
      temperatureK: sourced(rating, 'ratedTempDryK'),
      bin: HEAT_KNOT_BINS.rating.value,
    });
  } else {
    omitted.push(
      `the lowest insulation rating (${celsius(ratingK)}) is not between ambient and the termination overheat point, so it isn't marked`,
    );
  }
  knots.push(overheat);
  // Insulation damage (lowest rating + 40 K), between the overheat point and the oxidation onset.
  const damageK = ratingK + CONNECTION_INSULATION_DAMAGE_MARGIN_K;
  if (damageK > overheat.temperatureK.value && damageK < oxidation.temperatureK.value) {
    knots.push({
      name: 'insulation damage (lowest rating + 40 K)',
      temperatureK: sourced(
        rating,
        'ratedTempDryK',
        damageK,
        ' + sim-core INSULATION_DAMAGE_MARGIN_K (40 K, game-design anchored to an XHHW-2 emergency rating, ADR 0018 §6; copied as sim-protocol CONNECTION_INSULATION_DAMAGE_MARGIN_K)',
      ),
      bin: HEAT_KNOT_BINS.insulationDamage.value,
    });
  } else {
    omitted.push(
      `insulation damage (${celsius(damageK)}) is not between the termination overheat point and the oxidation onset, so it isn't marked`,
    );
  }
  knots.push(oxidation);
  // Other metals' melting points: at the whole bin nearest their linear place above the oxidation onset.
  const seen = new Set<string>([metalName(top)]);
  const lo = oxidation.temperatureK.value;
  const hi = top.value;
  const loBin = HEAT_KNOT_BINS.oxidation.value;
  for (const m of [...melts].sort((x, y) => x.value - y.value)) {
    const name = metalName(m);
    if (seen.has(name)) continue;
    seen.add(name);
    const bin = Math.round(loBin + ((OVERLAY_BINS - loBin) * (m.value - lo)) / (hi - lo));
    const last = knots[knots.length - 1];
    if (!(m.value > lo && m.value < hi) || bin <= last.bin || bin >= OVERLAY_BINS) {
      omitted.push(`${name}'s melting point (${celsius(m.value)}) doesn't fit on the scale, so it isn't marked`);
      continue;
    }
    knots.push({ name: `${name} melts`, temperatureK: sourced(m, 'meltingPointK'), bin });
  }
  knots.push(topKnot);
  return Object.freeze({ knots: Object.freeze(knots), omitted: Object.freeze(omitted) });
}

/** The built-in catalogue's heat scale. */
export const HEAT_SCALE = heatScale();

/**
 * A temperature as a continuous bin coordinate: linear between knots, 0 at or below ambient,
 * {@link OVERLAY_BINS} (over range) at or above the top. Allocation-free.
 */
export function heatCoordinate(temperatureK: number, scale: HeatScale = HEAT_SCALE): number {
  const knots = scale.knots;
  if (temperatureK <= knots[0].temperatureK.value) return knots[0].bin;
  for (let k = 1; k < knots.length; k++) {
    const hi = knots[k];
    if (temperatureK < hi.temperatureK.value) {
      const lo = knots[k - 1];
      const f = (temperatureK - lo.temperatureK.value) / (hi.temperatureK.value - lo.temperatureK.value);
      return lo.bin + (hi.bin - lo.bin) * f;
    }
  }
  return OVERLAY_BINS;
}

/** The temperature at bin coordinate `bin` (0 to {@link OVERLAY_BINS}): the inverse of {@link heatCoordinate}. */
export function heatTemperatureAt(bin: number, scale: HeatScale = HEAT_SCALE): number {
  const knots = scale.knots;
  if (bin <= knots[0].bin) return knots[0].temperatureK.value;
  for (let k = 1; k < knots.length; k++) {
    const hi = knots[k];
    if (bin <= hi.bin) {
      const lo = knots[k - 1];
      const f = (bin - lo.bin) / (hi.bin - lo.bin);
      return lo.temperatureK.value + (hi.temperatureK.value - lo.temperatureK.value) * f;
    }
  }
  return knots[knots.length - 1].temperatureK.value;
}

/**
 * A temperature's heat step, with kelvin hysteresis against `previous` ({@link HEAT_HYSTERESIS_K}):
 * the previous bin holds while the temperature stays within the hysteresis of that bin's own range.
 * A temperature that isn't a positive finite number is no reading ({@link STEP_UNKNOWN}), never cold.
 * Allocation-free.
 */
export function heatStep(temperatureK: number, previous: number, scale: HeatScale = HEAT_SCALE): number {
  if (!(temperatureK > 0) || !Number.isFinite(temperatureK)) return STEP_UNKNOWN;
  const bin = binOf(heatCoordinate(temperatureK, scale));
  if (previous === bin || previous < 0 || previous > OVER_RANGE_BIN) return bin;
  const h = HEAT_HYSTERESIS_K.value;
  const low = heatTemperatureAt(previous, scale) - h;
  const high = previous >= OVER_RANGE_BIN ? Number.POSITIVE_INFINITY : heatTemperatureAt(previous + 1, scale) + h;
  return temperatureK >= low && temperatureK <= high ? previous : bin;
}

/** The colour of a heat step: the heat ramp for bins 0 to 31, then over range (melting) and unknown. */
export function heatStepColour(step: number): number {
  if (step === STEP_UNKNOWN) return UNKNOWN_COLOUR;
  if (step >= OVERLAY_BINS) return OVER_RANGE_COLOUR;
  return rampColour(HEAT_RAMP, step);
}

/** `293 K (20 °C)`: kelvin to the nearest whole kelvin (as the inspector shows it), with Celsius. */
export function formatTemperature(kelvin: number): string {
  return `${Math.round(kelvin)} K (${celsius(kelvin)})`;
}

const HEAT_RAMP_CSS: readonly string[] = Array.from({ length: OVERLAY_BINS }, (_, bin) =>
  cssColour(heatStepColour(bin)),
);

/** The heat legend: the scale's bar and ticks, plus the catalogue points the scale had to leave out. */
export interface HeatLegendScale extends LegendScale {
  readonly omitted: readonly string[];
}

/** The heat overlay's legend: a tick at each named point below the top, the top as over range. */
export function heatLegend(scale: HeatScale = HEAT_SCALE): HeatLegendScale {
  const top = scale.knots[scale.knots.length - 1];
  return Object.freeze({
    title: 'Conductor temperature: the hottest node in each half (its end or its body)',
    ticks: scale.knots
      .slice(0, -1)
      .map((k) => ({ bin: k.bin, label: `${formatTemperature(k.temperatureK.value)} ${k.name}` })),
    overRange: `${formatTemperature(top.temperatureK.value)} and above: ${top.name}`,
    colours: HEAT_RAMP_CSS,
    omitted: scale.omitted,
  });
}

/** The built-in catalogue's heat legend. */
export const HEAT_LEGEND = heatLegend();
