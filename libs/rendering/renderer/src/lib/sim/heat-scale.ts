import { BUILTIN_CATALOG, type Catalog, type CatalogSource, coversPath, type TableDocument } from '@controls/catalog';
import { CONNECTION_AMBIENT_K, CONNECTION_OVERHEAT_RISE_K } from '@controls/sim-protocol';
import {
  binWithHysteresis,
  cssColour,
  type LegendScale,
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
 * **Every temperature on it is sourced, and none is new.** The scale is piecewise linear through four
 * knots, each a constant the engine or the catalogue already carries with its source:
 *
 * - the ambient, `CONNECTION_AMBIENT_K` (sim-protocol's copy of sim-core's `AMBIENT_TEMPERATURE_K`);
 * - the insulation rating: the lowest dry rating (`ratedTempDryK`) among the catalogue's
 *   `insulation` rows, so every conductor past this point is past some insulation's rating (every
 *   P3 row is 90 °C);
 * - the overheat point, ambient + `CONNECTION_OVERHEAT_RISE_K` (the engine's `terminationOverheat`
 *   threshold, anchored to NBS BSS 128);
 * - the top: the highest melting point (`meltingPointK`) among the catalogue's `materials` rows
 *   (copper, an ITS-90 fixed point). At or above it reads over range. Other metals' melting points
 *   (aluminium) are legend marks inside the scale.
 *
 * Which bin each knot sits at is game-design ({@link HEAT_KNOT_BINS}): the normal service range gets
 * the most resolution. {@link heatScale} throws if the knots aren't strictly increasing (a catalogue
 * insulation rated at or above the overheat point needs a new scale design), and a spec runs it on
 * the built-in catalogue.
 */

/** A knot of the heat scale: a sourced temperature and the bin it sits at. */
export interface HeatKnot {
  /** What the legend calls it (`ambient`, `insulation rating`, …). */
  readonly name: string;
  readonly temperatureK: ScaleValue;
  /** Its bin coordinate (0 to {@link OVERLAY_BINS}); the last knot is the top of the scale. */
  readonly bin: number;
}

/** A labelled temperature inside the scale that isn't a knot (another metal's melting point). */
export interface HeatMark {
  readonly name: string;
  readonly temperatureK: ScaleValue;
}

export interface HeatScale {
  /** Ambient, insulation rating, overheat, top: strictly increasing in temperature and bin. */
  readonly knots: readonly HeatKnot[];
  readonly marks: readonly HeatMark[];
}

/**
 * Game-design: where the inner knots sit. Ambient is bin 0 and the top is the over-range boundary
 * ({@link OVERLAY_BINS}); the insulation rating at bin 12 and the overheat point at bin 16 give the
 * service range (ambient to the rating, 70 K on the P3 catalogue) about 6 K a bin, and the half of the
 * bar above the overheat point the long climb to melting (about 60 K a bin): a loose termination
 * reads in the upper half while its conductor stays in the lower.
 */
export const HEAT_KNOT_BINS: Readonly<{ rating: ScaleValue; overheat: ScaleValue }> = Object.freeze({
  rating: {
    value: 12,
    unit: 'bin',
    kind: 'game-design',
    source:
      'Game-design: the lowest insulation rating sits at bin 12 of 32, so the service range (ambient to the rating) has three eighths of the bar and reads in fine steps.',
  },
  overheat: {
    value: 16,
    unit: 'bin',
    kind: 'game-design',
    source:
      'Game-design: the overheat point (ambient + 100 K) sits at the middle of the bar, so everything past the engine’s terminationOverheat threshold is in the upper half, up to melting.',
  },
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

/** The source of a table row field, from the table's own sources (`rows.<key>.<field>` or a `*` cover). */
function rowSource(table: TableDocument, key: string, field: string): CatalogSource | undefined {
  const path = `rows.${key}.${field}`;
  return table.sources.find((s) => s.covers.some((c) => coversPath(c, path)));
}

interface RowValue {
  readonly value: number;
  readonly source: CatalogSource | undefined;
  readonly table: string;
  readonly key: string;
}

/** Every numeric `field` of `tableName`'s rows, over all its versions. */
function rowValues(catalog: Pick<Catalog, 'tables'>, tableName: string, field: string): RowValue[] {
  const out: RowValue[] = [];
  for (const table of catalog.tables) {
    if (table.table !== tableName) continue;
    for (const [key, row] of Object.entries(table.rows)) {
      const value = row[field];
      if (typeof value !== 'number') continue;
      out.push({ value, source: rowSource(table, key, field), table: `${table.table}@${table.version}`, key });
    }
  }
  return out;
}

const sourced = (row: RowValue, field: string): ScaleValue => ({
  value: row.value,
  unit: 'K',
  kind: row.source?.kind ?? 'real-world',
  source: `Catalogue table ${row.table} row ${row.key} ${field}${row.source ? ` (source ${row.source.id}: ${row.source.citation})` : ''}`,
});

/** A metal's short name for the legend (`copper`, `aluminium`): its row key's leading lower-case word. */
const metalName = (row: RowValue): string => /^[a-z]+/.exec(row.key)?.[0] ?? row.key;

/**
 * The heat scale of `catalog`'s tables (the built-in catalogue by default). Throws if the catalogue has
 * no insulation rating or melting point, or if the knots aren't strictly increasing.
 */
export function heatScale(catalog: Pick<Catalog, 'tables'> = BUILTIN_CATALOG): HeatScale {
  const ratings = rowValues(catalog, 'insulation', 'ratedTempDryK');
  const melts = rowValues(catalog, 'materials', 'meltingPointK');
  if (ratings.length === 0 || melts.length === 0) {
    throw new Error('heatScale: the catalogue has no insulation rating or no melting point');
  }
  const rating = ratings.reduce((low, r) => (r.value < low.value ? r : low));
  const top = melts.reduce((high, r) => (r.value > high.value ? r : high));
  const knots: HeatKnot[] = [
    { name: 'ambient', temperatureK: AMBIENT, bin: 0 },
    {
      name: 'insulation rating',
      temperatureK: sourced(rating, 'ratedTempDryK'),
      bin: HEAT_KNOT_BINS.rating.value,
    },
    { name: 'overheat', temperatureK: OVERHEAT, bin: HEAT_KNOT_BINS.overheat.value },
    { name: `${metalName(top)} melts`, temperatureK: sourced(top, 'meltingPointK'), bin: OVERLAY_BINS },
  ];
  for (let k = 1; k < knots.length; k++) {
    if (!(knots[k].temperatureK.value > knots[k - 1].temperatureK.value) || !(knots[k].bin > knots[k - 1].bin)) {
      throw new Error(
        `heatScale: knot ${knots[k].name} (${knots[k].temperatureK.value} K) is not above ${knots[k - 1].name} (${knots[k - 1].temperatureK.value} K)`,
      );
    }
  }
  const seen = new Set<string>([metalName(top)]);
  const marks: HeatMark[] = [];
  for (const m of [...melts].sort((x, y) => x.value - y.value)) {
    const name = metalName(m);
    if (seen.has(name) || m.value <= OVERHEAT.value || m.value >= top.value) continue;
    seen.add(name);
    marks.push({ name: `${name} melts`, temperatureK: sourced(m, 'meltingPointK') });
  }
  return Object.freeze({ knots: Object.freeze(knots), marks: Object.freeze(marks) });
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

/**
 * A temperature's heat step, with the overlays' half-step hysteresis against `previous`. A temperature
 * that isn't a positive finite number is no reading ({@link STEP_UNKNOWN}), never cold.
 */
export function heatStep(temperatureK: number, previous: number, scale: HeatScale = HEAT_SCALE): number {
  if (!(temperatureK > 0) || !Number.isFinite(temperatureK)) return STEP_UNKNOWN;
  return binWithHysteresis(heatCoordinate(temperatureK, scale), previous);
}

/** The colour of a heat step: the heat ramp for bins 0 to 31, then over range (melting) and unknown. */
export function heatStepColour(step: number): number {
  if (step === STEP_UNKNOWN) return UNKNOWN_COLOUR;
  if (step >= OVERLAY_BINS) return OVER_RANGE_COLOUR;
  return rampColour(HEAT_RAMP, step);
}

/** `293 K (20 °C)`: kelvin to the nearest whole kelvin (as the inspector shows it), with Celsius. */
export function formatTemperature(kelvin: number): string {
  return `${Math.round(kelvin)} K (${Math.round(kelvin - 273.15)} °C)`;
}

const HEAT_RAMP_CSS: readonly string[] = Array.from({ length: OVERLAY_BINS }, (_, bin) =>
  cssColour(heatStepColour(bin)),
);

/** The heat overlay's legend: a tick at each knot below the top and at each mark, the top as over range. */
export function heatLegend(scale: HeatScale = HEAT_SCALE): LegendScale {
  const top = scale.knots[scale.knots.length - 1];
  const ticks = [
    ...scale.knots
      .slice(0, -1)
      .map((k) => ({ bin: k.bin, label: `${formatTemperature(k.temperatureK.value)} ${k.name}` })),
    ...scale.marks.map((m) => ({
      bin: Math.round(heatCoordinate(m.temperatureK.value, scale) * 100) / 100,
      label: `${formatTemperature(m.temperatureK.value)} ${m.name}`,
    })),
  ].sort((a, b) => a.bin - b.bin);
  return {
    title: 'Conductor temperature: the hottest node in each half (its end or its body)',
    ticks,
    overRange: `${formatTemperature(top.temperatureK.value)} and above: ${top.name}`,
    colours: HEAT_RAMP_CSS,
  };
}
