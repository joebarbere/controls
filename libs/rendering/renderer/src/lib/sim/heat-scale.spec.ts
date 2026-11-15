import { BUILTIN_CATALOG, type TableDocument } from '@controls/catalog';
import {
  CONNECTION_AMBIENT_K,
  CONNECTION_INSULATION_DAMAGE_MARGIN_K,
  CONNECTION_OVERHEAT_RISE_K,
  CONNECTION_OXIDATION_ONSET_K,
} from '@controls/sim-protocol';
import fc from 'fast-check';
import {
  formatTemperature,
  HEAT_HYSTERESIS_K,
  HEAT_KNOT_BINS,
  HEAT_LEGEND,
  HEAT_SCALE,
  heatCoordinate,
  heatLegend,
  heatScale,
  heatStep,
  heatStepColour,
  heatTemperatureAt,
} from './heat-scale';
import {
  cssColour,
  OVER_RANGE_BIN,
  OVER_RANGE_COLOUR,
  OVERLAY_BINS,
  STEP_UNKNOWN,
  stepColour,
  UNKNOWN_COLOUR,
} from './overlay-scale';

const table = (name: string) => BUILTIN_CATALOG.tables.filter((t) => t.table === name);

/** The built-in tables with every insulation row's dry rating set to `ratingK`. */
const withRating = (ratingK: number): TableDocument[] =>
  BUILTIN_CATALOG.tables.map((t) =>
    t.table !== 'insulation'
      ? t
      : {
          ...t,
          rows: Object.fromEntries(Object.entries(t.rows).map(([k, r]) => [k, { ...r, ratedTempDryK: ratingK }])),
        },
  );

describe('the heat scale (F3.6 part 3)', () => {
  it('takes every named point from a sourced engine or catalogue constant, each a knot at a whole bin', () => {
    expect(HEAT_SCALE.knots.map((k) => [k.name, k.temperatureK.value, k.bin])).toStrictEqual([
      ['ambient', CONNECTION_AMBIENT_K, 0],
      ['lowest insulation rating in the catalogue', 363.15, HEAT_KNOT_BINS.rating.value],
      ['termination overheat', CONNECTION_AMBIENT_K + CONNECTION_OVERHEAT_RISE_K, HEAT_KNOT_BINS.overheat.value],
      ['insulation damage (lowest rating + 40 K)', 363.15 + CONNECTION_INSULATION_DAMAGE_MARGIN_K, 18],
      ['contact oxidation onset', CONNECTION_OXIDATION_ONSET_K, HEAT_KNOT_BINS.oxidation.value],
      ['aluminium melts', 933.473, 27], // 20 + 12 × (933.473 − 422.15) / (1357.77 − 422.15) = 26.56 → 27
      ['copper melts', 1357.77, OVERLAY_BINS],
    ]);
    expect(HEAT_SCALE.omitted).toStrictEqual([]);
    const ratings = table('insulation').flatMap((t) => Object.values(t.rows).map((r) => r['ratedTempDryK'] as number));
    const melts = table('materials').flatMap((t) => Object.values(t.rows).map((r) => r['meltingPointK'] as number));
    expect(HEAT_SCALE.knots[1].temperatureK.value).toBe(Math.min(...ratings));
    expect(HEAT_SCALE.knots.at(-1)?.temperatureK.value).toBe(Math.max(...melts));
    const source = (name: string) => HEAT_SCALE.knots.find((k) => k.name === name)?.temperatureK;
    expect(source('ambient')?.source).toContain('AMBIENT_TEMPERATURE_K');
    expect(source('termination overheat')?.source).toContain('TERMINATION_OVERHEAT_RISE_K');
    expect(source('contact oxidation onset')?.source).toContain('OXIDATION_ONSET_K');
    expect(source('insulation damage (lowest rating + 40 K)')?.source).toContain('INSULATION_DAMAGE_MARGIN_K');
    expect(source('lowest insulation rating in the catalogue')?.source).toContain('ul-type-ratings');
    expect(source('lowest insulation rating in the catalogue')?.kind).toBe('real-world');
    expect(source('copper melts')?.source).toContain('ITS-90');
    for (const bin of Object.values(HEAT_KNOT_BINS)) expect(bin.kind).toBe('game-design');
    expect(HEAT_HYSTERESIS_K.kind).toBe('game-design');
  });

  it('maps temperatures piecewise linearly through the knots, with over range at the top', () => {
    for (const k of HEAT_SCALE.knots) {
      expect(heatCoordinate(k.temperatureK.value)).toBe(k.bin);
      expect(heatTemperatureAt(k.bin)).toBe(k.temperatureK.value);
    }
    expect(heatCoordinate(250)).toBe(0); // never below ambient in the engine; clamped if it were
    expect(heatCoordinate((293.15 + 363.15) / 2)).toBeCloseTo(6, 12);
    expect(heatStep(1357.77, STEP_UNKNOWN)).toBe(OVER_RANGE_BIN);
    expect(heatStep(5000, STEP_UNKNOWN)).toBe(OVER_RANGE_BIN);
    // The bad-termination scenario's figures (wire.info golden): a 394 K loose end, a 303 K conductor.
    expect(heatStep(393.822, STEP_UNKNOWN)).toBe(16);
    expect(heatStep(303.033, STEP_UNKNOWN)).toBe(1);
  });

  it('is monotone, and its inverse round-trips', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 200, max: 3000, noNaN: true }),
        fc.double({ min: 0, max: 500, noNaN: true }),
        (t, d) => {
          const c = heatCoordinate(t);
          expect(heatCoordinate(t + d)).toBeGreaterThanOrEqual(c);
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(OVERLAY_BINS);
          if (t > CONNECTION_AMBIENT_K && t < 1357.77) expect(heatTemperatureAt(c)).toBeCloseTo(t, 9);
        },
      ),
    );
  });

  it('changes colour within the hysteresis of every named point, warming from ambient and cooling back', () => {
    // The realism review's F1: half-bin hysteresis held a loose end at 393.8 K below the overheat mark.
    const stepK = 0.05;
    const h = HEAT_HYSTERESIS_K.value;
    const named = HEAT_SCALE.knots.slice(1);
    const up = new Map<number, number>(); // knot bin -> first temperature reading at or above it
    let step = heatStep(CONNECTION_AMBIENT_K, STEP_UNKNOWN);
    for (let t = CONNECTION_AMBIENT_K; t <= 1400; t += stepK) {
      step = heatStep(t, step);
      for (const k of named) if (step >= k.bin && !up.has(k.bin)) up.set(k.bin, t);
    }
    for (const k of named) {
      const at = up.get(k.bin) as number;
      expect(at).toBeGreaterThanOrEqual(k.temperatureK.value - 1e-9);
      expect(at).toBeLessThanOrEqual(k.temperatureK.value + h + stepK);
    }
    const down = new Map<number, number>(); // knot bin -> first temperature reading below it
    for (let t = 1400; t >= CONNECTION_AMBIENT_K; t -= stepK) {
      step = heatStep(t, step);
      for (const k of named) if (step < k.bin && !down.has(k.bin)) down.set(k.bin, t);
    }
    for (const k of named) {
      const at = down.get(k.bin) as number;
      expect(at).toBeLessThanOrEqual(k.temperatureK.value + 1e-9);
      expect(at).toBeGreaterThanOrEqual(k.temperatureK.value - h - stepK);
    }
    // The golden loose end, warming from just below the overheat point: past the mark at once.
    expect(heatStep(393.822, heatStep(392, STEP_UNKNOWN))).toBe(16);
    // Holding: a node resting on a boundary doesn't flicker.
    expect(heatStep(393.4, 16)).toBe(16);
    expect(heatStep(392.9, 16)).toBe(16);
    expect(heatStep(392.6, 16)).toBe(15);
  });

  it('never reads an absent temperature as cold: zero, negative and non-finite are no reading', () => {
    for (const t of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(heatStep(t, 3)).toBe(STEP_UNKNOWN);
    expect(heatStepColour(STEP_UNKNOWN)).toBe(UNKNOWN_COLOUR);
    expect(heatStepColour(0)).not.toBe(UNKNOWN_COLOUR); // cold is a real colour
  });

  it('colours with its own ramp: distinct from the voltage and current ramp, magenta at melting', () => {
    const colours = Array.from({ length: OVERLAY_BINS }, (_, bin) => heatStepColour(bin));
    expect(new Set(colours).size).toBe(OVERLAY_BINS);
    expect(colours.includes(UNKNOWN_COLOUR)).toBe(false);
    expect(colours.includes(OVER_RANGE_COLOUR)).toBe(false);
    expect(heatStepColour(OVER_RANGE_BIN)).toBe(OVER_RANGE_COLOUR);
    expect(colours.filter((c, bin) => c === stepColour(bin))).toStrictEqual([]);
    const luminance = (c: number) => 0.2126 * ((c >> 16) & 0xff) + 0.7152 * ((c >> 8) & 0xff) + 0.0722 * (c & 0xff);
    for (let bin = 1; bin < OVERLAY_BINS; bin++) {
      expect(luminance(colours[bin])).toBeGreaterThan(luminance(colours[bin - 1]));
    }
  });

  it('has a legend in text: each named point, kelvin first (as the inspector shows it) with Celsius', () => {
    expect(HEAT_LEGEND.ticks.map((t) => [t.bin, t.label])).toStrictEqual([
      [0, '293 K (20 °C) ambient'],
      [12, '363 K (90 °C) lowest insulation rating in the catalogue'],
      [16, '393 K (120 °C) termination overheat'],
      [18, '403 K (130 °C) insulation damage (lowest rating + 40 K)'],
      [20, '422 K (149 °C) contact oxidation onset'],
      [27, '933 K (660 °C) aluminium melts'],
    ]);
    expect(HEAT_LEGEND.overRange).toBe('1358 K (1085 °C) and above: copper melts');
    expect(HEAT_LEGEND.colours).toHaveLength(OVERLAY_BINS);
    expect(HEAT_LEGEND.colours[0]).toBe(cssColour(heatStepColour(0)));
    expect(HEAT_LEGEND.omitted).toStrictEqual([]);
    expect(formatTemperature(303.033)).toBe('303 K (30 °C)');
  });

  it('omits a catalogue point that does not fit, with a reason, instead of failing', () => {
    // A 125 °C insulation: above the overheat point, so the rating is left out; its damage point too.
    const hot = heatScale({ tables: withRating(398.15) });
    expect(hot.knots.map((k) => k.name)).toStrictEqual([
      'ambient',
      'termination overheat',
      'contact oxidation onset',
      'aluminium melts',
      'copper melts',
    ]);
    expect(hot.omitted).toHaveLength(2);
    expect(hot.omitted[0]).toContain('lowest insulation rating (125 °C)');
    expect(hot.omitted[1]).toContain('insulation damage (165 °C)');
    expect(heatLegend(hot).omitted).toBe(hot.omitted);
    expect(heatStep(400, STEP_UNKNOWN, hot)).toBe(16); // still a working scale
    // A 60 °C insulation fits: its damage point (100 °C) is below the overheat point, so only that goes.
    const cool = heatScale({ tables: withRating(333.15) });
    expect(cool.knots[1].temperatureK.value).toBe(333.15);
    expect(cool.omitted).toStrictEqual([
      "insulation damage (100 °C) is not between the termination overheat point and the oxidation onset, so it isn't marked",
    ]);
  });

  it('throws only for a catalogue that gives no scale at all, or a value without a source', () => {
    expect(() => heatScale({ tables: [] })).toThrow(/no insulation rating/);
    const unsourced = BUILTIN_CATALOG.tables.map((t) =>
      t.table !== 'insulation'
        ? t
        : {
            ...t,
            sources: t.sources.map((s) => ({ ...s, covers: s.covers.filter((c) => !c.includes('ratedTempDryK')) })),
          },
    );
    expect(() => heatScale({ tables: unsourced })).toThrow(/ratedTempDryK has no source/);
    // A metal melting below the oxidation onset breaks the fixed points.
    const lowMelt = BUILTIN_CATALOG.tables.map((t) =>
      t.table !== 'materials'
        ? t
        : { ...t, rows: Object.fromEntries(Object.entries(t.rows).map(([k, r]) => [k, { ...r, meltingPointK: 400 }])) },
    );
    expect(() => heatScale({ tables: lowMelt })).toThrow(/is not above contact oxidation onset/);
  });
});
