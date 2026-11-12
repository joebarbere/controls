import { BUILTIN_CATALOG } from './builtin';
import { AWG_GAUGES, awgInRange, awgName, AwgRange, gaugeRow, MAX_AWG, MIN_AWG, parseAwgName } from './gauge';
import { LeadParams } from './model-kinds';

/*
 * The one gauge table (catalogue v2): every row recomputed from the AWG definition (NBS Handbook 100
 * §2), d = 0.127 mm × 92^((36 − n)/39) and A = π d²/4. `**` is fine here: tests aren't simulator code.
 */

const diameterMm = (n: number) => 0.127 * 92 ** ((36 - n) / 39);
const areaMm2 = (n: number) => (Math.PI * diameterMm(n) ** 2) / 4;
const relative = (a: number, b: number) => Math.abs(a - b) / b;

describe('the AWG gauge table', () => {
  it('runs from 4/0 (−3) to 40 in designation order, one row each', () => {
    expect(AWG_GAUGES.map((r) => r.awg)).toStrictEqual(
      Array.from({ length: MAX_AWG - MIN_AWG + 1 }, (_, i) => MIN_AWG + i),
    );
    expect(Object.isFrozen(AWG_GAUGES)).toBe(true);
  });

  it('every diameter and area is the formula, rounded to six significant figures (≤ 1e-5 relative)', () => {
    for (const row of AWG_GAUGES) {
      expect(relative(row.diameterMm, diameterMm(row.awg)), row.name).toBeLessThan(1e-5);
      expect(relative(row.areaMm2, areaMm2(row.awg)), row.name).toBeLessThan(1e-5);
    }
  });

  it('areaUm2 is pinned: integer µm², the six-figure area × 10⁶ rounded once (ADR 0018 §4.4; never changes)', () => {
    // A twist-on splice's total-size check reads these; changing one changes what a replay refuses.
    expect(AWG_GAUGES.map((r) => r.areaUm2)).toStrictEqual([
      107219000, 85028800, 67430900, 53475100, 42407700, 33630800, 26670500, 21150600, 16773200, 13301800, 10548800,
      8365560, 6634190, 5261150, 4172290, 3308770, 2623980, 2080910, 1650230, 1308700, 1037840, 823047, 652706, 517619,
      410491, 325534, 258160, 204730, 162359, 128756, 102108, 80976, 64216, 50926, 40386, 32028, 25399, 20142, 15974,
      12668, 10046, 7967, 6318, 5010,
    ]);
    for (const row of AWG_GAUGES) {
      expect(Number.isInteger(row.areaUm2), row.name).toBe(true);
      expect(Math.abs(row.areaUm2 - row.areaMm2 * 1e6), row.name).toBeLessThanOrEqual(0.5);
    }
  });

  it('the anchors: 36 AWG is 0.005 in and 4/0 is 0.46 in, with 39 steps between', () => {
    expect(gaugeRow(36)?.diameterMm).toBeCloseTo(0.005 * 25.4, 6);
    expect(gaugeRow(-3)?.diameterMm).toBeCloseTo(0.46 * 25.4, 3);
  });

  it('hand-calculated areas (P3 pre-audit), within 0.5 %', () => {
    // 18 AWG: d = 0.127 × 92^(18/39) = 1.02369 mm; A = π × 1.02369² / 4 = 0.8231 mm².
    // 14 AWG: d = 0.127 × 92^(22/39) = 1.62773 mm; A = 2.0809 mm².
    // 12 AWG: d = 0.127 × 92^(24/39) = 2.05253 mm; A = 3.3088 mm².
    //  4 AWG: d = 0.127 × 92^(32/39) = 5.18940 mm; A = 21.151 mm².
    // 4/0:    d = 0.127 × 92^(39/39) = 11.684 mm;  A = 107.22 mm².
    const goldens: [string, number][] = [
      ['18', 0.8231],
      ['14', 2.0809],
      ['12', 3.3088],
      ['4', 21.151],
      ['4/0', 107.22],
    ];
    for (const [name, area] of goldens) {
      const row = gaugeRow(parseAwgName(name) as number);
      expect(relative(row?.areaMm2 ?? 0, area), name).toBeLessThan(0.005);
    }
  });

  it('a smaller designation is a larger conductor (area strictly decreasing)', () => {
    for (let i = 1; i < AWG_GAUGES.length; i++) {
      expect(AWG_GAUGES[i].areaMm2).toBeLessThan(AWG_GAUGES[i - 1].areaMm2);
    }
  });

  it('the test lead is 18 AWG: its area is the table row (no second source of truth)', () => {
    const lead = LeadParams.parse(BUILTIN_CATALOG.device({ id: 'lead.quillfern-test-1m', version: 1 })?.model.params);
    expect(relative(lead.conductorAreaM2 * 1e6, gaugeRow(18)?.areaMm2 ?? 0)).toBeLessThan(1e-5);
  });

  it('names and parses designations: 1/0 = 0, 4/0 = −3', () => {
    expect([-3, -2, -1, 0, 1, 14, 40].map(awgName)).toStrictEqual(['4/0', '3/0', '2/0', '1/0', '1', '14', '40']);
    for (const row of AWG_GAUGES) expect(parseAwgName(row.name)).toBe(row.awg);
    for (const bad of ['0', '5/0', '41', '014', '-3', '', '1/0 ']) expect(parseAwgName(bad), bad).toBeUndefined();
    expect(gaugeRow(-4)).toBeUndefined();
    expect(gaugeRow(41)).toBeUndefined();
    expect(gaugeRow(1.5)).toBeUndefined();
  });

  it('ranges compare integers: smallest is the thinnest, largest the thickest', () => {
    const range = AwgRange.parse({ smallest: 14, largest: 10 });
    expect([16, 14, 12, 10, 8].map((n) => awgInRange(n, range))).toStrictEqual([false, true, true, true, false]);
    expect(awgInRange(-3, AwgRange.parse({ smallest: 4, largest: -3 }))).toBe(true);
    expect(AwgRange.safeParse({ smallest: 10, largest: 14 }).success).toBe(false);
    expect(AwgRange.safeParse({ smallest: 14, largest: -4 }).success).toBe(false);
  });
});
