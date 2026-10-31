import { BUILTIN_CATALOG, NEC_REGION } from '@controls/catalog';
import { NOMINAL_BANDS } from '@controls/sim-protocol';
import {
  arrowCount,
  arrowFraction,
  arrowSpeedMmPerS,
  binOf,
  binWithHysteresis,
  CURRENT_SCALE,
  currentCoordinate,
  currentLegend,
  formatQuantity,
  MAX_ARROWS_PER_LEAD,
  NO_SCALE_COLOUR,
  OVER_RANGE_BIN,
  OVER_RANGE_COLOUR,
  OVERLAY_BINS,
  scalesByBand,
  STEP_NO_SCALE,
  STEP_UNKNOWN,
  stepColour,
  swayOffsetMm,
  UNKNOWN_COLOUR,
  VOLTAGE_SCALES,
  voltageCoordinate,
  voltageLegend,
} from './overlay-scale';

describe('voltage scales', () => {
  it('has a scale for each real band, every value sourced', () => {
    expect(Object.keys(VOLTAGE_SCALES)).toStrictEqual(['dc12', 'dc24', 'ac120-240', 'ac208y120', 'ac480y277']);
    for (const scale of Object.values(VOLTAGE_SCALES)) {
      for (const v of [scale.nominalV, scale.fullScaleV]) {
        expect(v.source.length, scale.band).toBeGreaterThan(40);
        expect(v.unit).toBe('V');
      }
      expect(scale.fullScaleV.kind).toBe('game-design');
      expect(scale.nominalV.kind).toBe('real-world');
      expect(scale.fullScaleV.value).toBeCloseTo((scale.nominalV.value * 4) / 3, 12);
    }
  });

  it('takes the AC bands from the region profile, line to line', () => {
    expect(VOLTAGE_SCALES['ac120-240'].nominalV.value).toBe(NEC_REGION.splitPhase.lineToLineV.value);
    expect(VOLTAGE_SCALES['ac208y120'].nominalV.value).toBe(208);
    expect(VOLTAGE_SCALES['ac480y277'].nominalV.value).toBe(480);
    expect(VOLTAGE_SCALES['ac480y277'].title).toBe('480Y/277 V AC');
    expect(VOLTAGE_SCALES['ac480y277'].nominalV.source).toBe(NEC_REGION.threePhaseIndustrial.lineToLineV.source);
  });

  it('keeps a healthy supply in range: ANSI C84.1 range B maximum is under full scale', () => {
    const rangeBMax = NEC_REGION.voltageRanges.serviceB.max.value;
    for (const scale of Object.values(VOLTAGE_SCALES)) {
      expect(binOf(voltageCoordinate(scale.nominalV.value * rangeBMax, scale))).toBeLessThan(OVER_RANGE_BIN);
    }
  });

  it('the DC bands agree with the catalogue nameplates they cite', () => {
    const battery = BUILTIN_CATALOG.device({ id: 'battery.ferrovane-12v-7ah', version: 1 });
    const psu = BUILTIN_CATALOG.device({ id: 'supply.railwick-din-24v-5a', version: 1 });
    expect(battery?.model.params['nominalVoltageV']).toBe(VOLTAGE_SCALES['dc12'].nominalV.value);
    expect(psu?.model.params['ratedVoltageV']).toBe(VOLTAGE_SCALES['dc24'].nominalV.value);
  });
});

describe('band 0 means no scale', () => {
  it('band 0 and bands without a scale resolve to null, never to a scale', () => {
    expect(scalesByBand(['none', 'dc12', 'mystery', 'ac208y120'])).toStrictEqual([
      null,
      VOLTAGE_SCALES['dc12'],
      null,
      VOLTAGE_SCALES['ac208y120'],
    ]);
    // Even a table that names a real scale at index 0 gets no scale there.
    expect(scalesByBand(['dc12'])).toStrictEqual([null]);
  });

  it('today every NOMINAL_BANDS entry other than `none` has a scale (a new band needs a row here)', () => {
    expect(NOMINAL_BANDS[0]).toBe('none');
    NOMINAL_BANDS.slice(1).forEach((band) => expect(VOLTAGE_SCALES[band], band).toBeDefined());
  });

  it('no-scale and unknown are not bins and have their own colours', () => {
    expect(STEP_NO_SCALE).toBeGreaterThan(OVER_RANGE_BIN);
    expect(STEP_UNKNOWN).toBeGreaterThan(OVER_RANGE_BIN);
    expect(stepColour(STEP_NO_SCALE)).toBe(NO_SCALE_COLOUR);
    expect(stepColour(STEP_UNKNOWN)).toBe(UNKNOWN_COLOUR);
    const ramp = Array.from({ length: OVERLAY_BINS + 1 }, (_, bin) => stepColour(bin));
    expect(ramp).not.toContain(NO_SCALE_COLOUR);
    expect(ramp).not.toContain(UNKNOWN_COLOUR);
    expect(stepColour(0)).not.toBe(UNKNOWN_COLOUR); // 0 V is a colour of its own, never "no reading"
  });
});

describe('bins and hysteresis', () => {
  const scale = VOLTAGE_SCALES['dc12']; // 16 V full scale: 0.5 V a bin

  it('maps 0 V to bin 0, nominal to bin 24, full scale and above to over range', () => {
    expect(binOf(voltageCoordinate(0, scale))).toBe(0);
    expect(binOf(voltageCoordinate(0.49, scale))).toBe(0);
    expect(binOf(voltageCoordinate(12, scale))).toBe(24);
    expect(binOf(voltageCoordinate(-12, scale))).toBe(24); // a magnitude
    expect(binOf(voltageCoordinate(15.99, scale))).toBe(31);
    expect(binOf(voltageCoordinate(16, scale))).toBe(OVER_RANGE_BIN);
    expect(binOf(voltageCoordinate(1e6, scale))).toBe(OVER_RANGE_BIN);
  });

  it('keeps the previous bin within half a step, and moves past it', () => {
    expect(binWithHysteresis(24.0, 23)).toBe(23); // half a bin above 23's top
    expect(binWithHysteresis(24.49, 23)).toBe(23);
    expect(binWithHysteresis(24.5, 23)).toBe(24);
    expect(binWithHysteresis(22.5, 23)).toBe(23);
    expect(binWithHysteresis(22.49, 23)).toBe(22);
    expect(binWithHysteresis(40, OVER_RANGE_BIN)).toBe(OVER_RANGE_BIN);
    expect(binWithHysteresis(31.6, OVER_RANGE_BIN)).toBe(OVER_RANGE_BIN);
    expect(binWithHysteresis(31.4, OVER_RANGE_BIN)).toBe(31);
    // A previous step that isn't a bin never holds.
    expect(binWithHysteresis(5.2, STEP_UNKNOWN)).toBe(5);
    expect(binWithHysteresis(5.2, STEP_NO_SCALE)).toBe(5);
  });

  it('a value dithering across a boundary changes the bin once, not every snapshot', () => {
    let bin = binOf(voltageCoordinate(12, scale));
    let changes = 0;
    for (const v of [12.02, 11.98, 12.03, 11.97, 12.01, 11.99]) {
      const next = binWithHysteresis(voltageCoordinate(v, scale), bin);
      if (next !== bin) changes++;
      bin = next;
    }
    expect(changes).toBe(0);
  });

  it('current: linear below 1 mA (bin 0), log bins 1–31 to 100 A, then over range', () => {
    expect(binOf(currentCoordinate(0))).toBe(0);
    expect(binOf(currentCoordinate(1e-12))).toBe(0); // gmin-level: nothing flows
    expect(binOf(currentCoordinate(0.999e-3))).toBe(0);
    expect(binOf(currentCoordinate(1e-3))).toBe(1);
    expect(currentCoordinate(1)).toBeCloseTo(1 + (31 * 3) / 5, 12);
    expect(binOf(currentCoordinate(-0.42))).toBe(binOf(currentCoordinate(0.42)));
    expect(binOf(currentCoordinate(99.9))).toBe(31);
    expect(binOf(currentCoordinate(100))).toBe(OVER_RANGE_BIN);
    expect(CURRENT_SCALE.minA.kind).toBe('game-design');
  });
});

describe('colours and the legend', () => {
  it('the ramp runs from dark violet to yellow, and over range is a hue the ramp never reaches', () => {
    expect(stepColour(0)).toBe(0x440154);
    expect(stepColour(OVERLAY_BINS - 1)).toBe(0xfde725);
    expect(stepColour(OVER_RANGE_BIN)).toBe(OVER_RANGE_COLOUR);
    const ramp = new Set(Array.from({ length: OVERLAY_BINS }, (_, bin) => stepColour(bin)));
    expect(ramp.size).toBe(OVERLAY_BINS); // every bin distinguishable
    expect(ramp.has(OVER_RANGE_COLOUR)).toBe(false);
  });

  it('labels a voltage scale in text, nominal marked, so the legend is not colour-only', () => {
    expect(voltageLegend(VOLTAGE_SCALES['dc12'])).toMatchObject({
      title: '|V| to the island reference, 12 V DC scale',
      ticks: [
        { bin: 0, label: '0 V' },
        { bin: 8, label: '4 V' },
        { bin: 16, label: '8 V' },
        { bin: 24, label: '12 V (nominal)' },
        { bin: 32, label: '16 V' },
      ],
      overRange: 'over 16 V',
    });
    expect(voltageLegend(VOLTAGE_SCALES['ac208y120']).ticks[3].label).toBe('208 V (nominal)');
    expect(voltageLegend(VOLTAGE_SCALES['ac208y120']).ticks[4].label).toBe('277 V');
    expect(voltageLegend(VOLTAGE_SCALES['dc12']).colours).toHaveLength(OVERLAY_BINS);
  });

  it('labels the current scale at each decade', () => {
    const legend = currentLegend();
    expect(legend.ticks.map((t) => t.label)).toStrictEqual(['1 mA', '10 mA', '100 mA', '1 A', '10 A', '100 A']);
    expect(legend.ticks.map((t) => t.bin)).toStrictEqual([1, 7, 13, 20, 26, 32]);
    expect(legend.overRange).toBe('over 100 A');
  });

  it('formats quantities to three significant figures', () => {
    expect(formatQuantity(0, 'V')).toBe('0 V');
    expect(formatQuantity(277.333, 'V')).toBe('277 V');
    expect(formatQuantity(5.333, 'V')).toBe('5.33 V');
    expect(formatQuantity(0.01, 'A')).toBe('10 mA');
  });
});

describe('current arrows', () => {
  it('count one per 60 mm, at least one and at most twelve', () => {
    expect(arrowCount(10)).toBe(1);
    expect(arrowCount(1000)).toBe(MAX_ARROWS_PER_LEAD);
    expect(arrowCount(300)).toBe(5);
  });

  it('stand still at bin 0 and speed up with the bin', () => {
    expect(arrowSpeedMmPerS(0)).toBe(0);
    expect(arrowSpeedMmPerS(STEP_UNKNOWN)).toBe(0);
    expect(arrowSpeedMmPerS(1)).toBe(20);
    expect(arrowSpeedMmPerS(OVER_RANGE_BIN)).toBe(200);
    expect(arrowSpeedMmPerS(16)).toBeGreaterThan(arrowSpeedMmPerS(8));
  });

  it('are evenly spaced at phase 0 and wrap along the lead', () => {
    expect([0, 1, 2, 3].map((k) => arrowFraction(k, 4, 0, 400))).toStrictEqual([0.125, 0.375, 0.625, 0.875]);
    expect(arrowFraction(3, 4, 50, 400)).toBe(0); // 350 + 50 wraps to the start
    expect(arrowFraction(0, 4, 100, 400)).toBe(0.125); // a whole spacing later, back where it started
  });

  it('AC sways about its rest point with no net travel', () => {
    const offsets = [0, 0.25, 0.5, 0.75, 1].map((c) => swayOffsetMm(c, 400, 4));
    expect(offsets).toStrictEqual([0, 25, 0, -25, 0]);
  });
});
