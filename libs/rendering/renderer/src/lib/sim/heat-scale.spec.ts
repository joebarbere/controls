import { BUILTIN_CATALOG, type TableDocument } from '@controls/catalog';
import { CONNECTION_AMBIENT_K, CONNECTION_OVERHEAT_RISE_K } from '@controls/sim-protocol';
import fc from 'fast-check';
import {
  formatTemperature,
  HEAT_KNOT_BINS,
  HEAT_SCALE,
  heatCoordinate,
  heatLegend,
  heatScale,
  heatStep,
  heatStepColour,
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

describe('the heat scale (F3.6 part 3)', () => {
  it('takes every knot from a sourced engine or catalogue constant, never a new one', () => {
    const [ambient, rating, overheat, top] = HEAT_SCALE.knots;
    expect(HEAT_SCALE.knots.map((k) => [k.name, k.temperatureK.value, k.bin])).toStrictEqual([
      ['ambient', CONNECTION_AMBIENT_K, 0],
      ['insulation rating', 363.15, HEAT_KNOT_BINS.rating.value],
      ['overheat', CONNECTION_AMBIENT_K + CONNECTION_OVERHEAT_RISE_K, HEAT_KNOT_BINS.overheat.value],
      ['copper melts', 1357.77, OVERLAY_BINS],
    ]);
    // The rating is the lowest dry rating of the catalogue's insulation rows; the top its highest melting point.
    const ratings = table('insulation').flatMap((t) => Object.values(t.rows).map((r) => r['ratedTempDryK'] as number));
    const melts = table('materials').flatMap((t) => Object.values(t.rows).map((r) => r['meltingPointK'] as number));
    expect(rating.temperatureK.value).toBe(Math.min(...ratings));
    expect(top.temperatureK.value).toBe(Math.max(...melts));
    // Every knot cites where it comes from; catalogue knots cite their table's own source.
    for (const k of HEAT_SCALE.knots) expect(k.temperatureK.source.length).toBeGreaterThan(20);
    expect(ambient.temperatureK.source).toContain('AMBIENT_TEMPERATURE_K');
    expect(overheat.temperatureK.source).toContain('TERMINATION_OVERHEAT_RISE_K');
    expect(rating.temperatureK.source).toContain('ul-type-ratings');
    expect(rating.temperatureK.kind).toBe('real-world');
    expect(top.temperatureK.source).toContain('ITS-90');
    expect(HEAT_KNOT_BINS.rating.kind).toBe('game-design');
    expect(HEAT_KNOT_BINS.overheat.kind).toBe('game-design');
    // Aluminium melts inside the scale: a mark, not a knot.
    expect(HEAT_SCALE.marks.map((m) => [m.name, m.temperatureK.value])).toStrictEqual([['aluminium melts', 933.473]]);
  });

  it('maps temperatures piecewise linearly through the knots, with over range at the top', () => {
    expect(heatCoordinate(CONNECTION_AMBIENT_K)).toBe(0);
    expect(heatCoordinate(250)).toBe(0); // never below ambient in the engine; clamped if it were
    expect(heatCoordinate(363.15)).toBe(12);
    expect(heatCoordinate((293.15 + 363.15) / 2)).toBeCloseTo(6, 12);
    expect(heatCoordinate(393.15)).toBe(16);
    expect(heatCoordinate(1357.77)).toBe(OVERLAY_BINS);
    expect(heatStep(1357.77, STEP_UNKNOWN)).toBe(OVER_RANGE_BIN);
    expect(heatStep(5000, STEP_UNKNOWN)).toBe(OVER_RANGE_BIN);
    // The bad-termination scenario's figures (wire.info golden): a 394 K loose end, a 303 K conductor.
    expect(heatStep(393.822, STEP_UNKNOWN)).toBe(16);
    expect(heatStep(303.033, STEP_UNKNOWN)).toBe(1);
  });

  it('is monotone: a hotter node never reads a lower bin', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 200, max: 3000, noNaN: true }),
        fc.double({ min: 0, max: 500, noNaN: true }),
        (t, d) => {
          expect(heatCoordinate(t + d)).toBeGreaterThanOrEqual(heatCoordinate(t));
          const c = heatCoordinate(t);
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(OVERLAY_BINS);
        },
      ),
    );
  });

  it('holds a bin within half a bin (the overlays’ hysteresis), so a steady node never flickers', () => {
    const at = (bin: number) => {
      // The temperature at coordinate `bin` in the first segment (6 K a bin on the P3 catalogue).
      return 293.15 + ((363.15 - 293.15) * bin) / 12;
    };
    expect(heatStep(at(5.1), STEP_UNKNOWN)).toBe(5);
    expect(heatStep(at(4.6), 5)).toBe(5);
    expect(heatStep(at(6.4), 5)).toBe(5);
    expect(heatStep(at(6.6), 5)).toBe(6);
    expect(heatStep(at(4.4), 5)).toBe(4);
  });

  it('never reads an absent temperature as cold: zero, negative and non-finite are no reading', () => {
    for (const t of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(heatStep(t, 3)).toBe(STEP_UNKNOWN);
    expect(heatStepColour(STEP_UNKNOWN)).toBe(UNKNOWN_COLOUR);
    // Cold (bin 0) is a real colour, not the unknown grey.
    expect(heatStepColour(0)).not.toBe(UNKNOWN_COLOUR);
  });

  it('colours with its own ramp: distinct from the voltage and current ramp, magenta at melting', () => {
    const colours = Array.from({ length: OVERLAY_BINS }, (_, bin) => heatStepColour(bin));
    expect(new Set(colours).size).toBe(OVERLAY_BINS);
    expect(colours.includes(UNKNOWN_COLOUR)).toBe(false);
    expect(colours.includes(OVER_RANGE_COLOUR)).toBe(false);
    expect(heatStepColour(OVER_RANGE_BIN)).toBe(OVER_RANGE_COLOUR);
    expect(colours.filter((c, bin) => c === stepColour(bin))).toStrictEqual([]);
    // Brighter as it gets hotter (relative luminance rises along the ramp).
    const luminance = (c: number) => 0.2126 * ((c >> 16) & 0xff) + 0.7152 * ((c >> 8) & 0xff) + 0.0722 * (c & 0xff);
    for (let bin = 1; bin < OVERLAY_BINS; bin++) {
      expect(luminance(colours[bin])).toBeGreaterThan(luminance(colours[bin - 1]));
    }
  });

  it('has a legend in text: each knot and mark, kelvin first (as the inspector shows it) with Celsius', () => {
    const legend = heatLegend();
    expect(legend.ticks.map((t) => t.label)).toStrictEqual([
      '293 K (20 °C) ambient',
      '363 K (90 °C) insulation rating',
      '393 K (120 °C) overheat',
      '933 K (660 °C) aluminium melts',
    ]);
    expect(legend.ticks.map((t) => t.bin)).toStrictEqual([0, 12, 16, 24.96]);
    expect(legend.overRange).toBe('1358 K (1085 °C) and above: copper melts');
    expect(legend.colours).toHaveLength(OVERLAY_BINS);
    expect(legend.colours[0]).toBe(cssColour(heatStepColour(0)));
    expect(formatTemperature(303.033)).toBe('303 K (30 °C)');
  });

  it('refuses a catalogue whose insulation rating is not below the overheat point', () => {
    const hot = (rating: number): TableDocument[] =>
      BUILTIN_CATALOG.tables.map((t) =>
        t.table !== 'insulation'
          ? t
          : {
              ...t,
              rows: Object.fromEntries(Object.entries(t.rows).map(([k, r]) => [k, { ...r, ratedTempDryK: rating }])),
            },
      );
    expect(() => heatScale({ tables: hot(398.15) })).toThrow(/overheat .* is not above insulation rating/);
    expect(heatScale({ tables: hot(333.15) }).knots[1].temperatureK.value).toBe(333.15);
    expect(() => heatScale({ tables: [] })).toThrow(/no insulation rating/);
  });
});
