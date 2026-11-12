import { RegionId } from '@controls/save-format';
import { BUILTIN_CATALOG } from './builtin';
import { matchesColourRule, NEC_REGION, REGION_PROFILES, regionProfile, type RegionValue, voltageBand } from './region';

/** Region profiles (plan F2.2 part 2): every region has one, and every value is sourced and consistent. */
describe('region profiles', () => {
  it('has a profile for every RegionId, under its own id', () => {
    for (const id of RegionId.options) {
      expect(regionProfile(id).id).toBe(id);
      expect(REGION_PROFILES[id]).toBe(regionProfile(id));
    }
    expect(regionProfile('nec')).toBe(NEC_REGION);
  });

  it('NEC is 60 Hz with 120/240 split-phase, 208Y/120 and 480Y/277', () => {
    expect(NEC_REGION.frequencyHz.value).toBe(60);
    const systems = [NEC_REGION.splitPhase, NEC_REGION.threePhaseCommercial, NEC_REGION.threePhaseIndustrial];
    expect(systems.map((s) => [s.name, s.phases, s.lineToNeutralV.value, s.lineToLineV.value])).toStrictEqual([
      ['120/240 V', 1, 120, 240],
      ['208Y/120 V', 3, 120, 208],
      ['480Y/277 V', 3, 277, 480],
    ]);
  });

  it('nominal line-to-line voltages are the rounded multiple of line-to-neutral (2 split-phase, √3 three-phase)', () => {
    const split = NEC_REGION.splitPhase;
    expect(split.lineToLineV.value).toBe(2 * split.lineToNeutralV.value);
    for (const system of [NEC_REGION.threePhaseCommercial, NEC_REGION.threePhaseIndustrial]) {
      const exact = system.lineToNeutralV.value * Math.sqrt(3);
      // The nominal system designation rounds the exact value to the nearest volt.
      expect(Math.abs(system.lineToLineV.value - exact)).toBeLessThan(0.5);
    }
  });

  it('every value has a unit, a kind and a source', () => {
    const values: RegionValue[] = [];
    for (const profile of Object.values(REGION_PROFILES)) {
      values.push(profile.frequencyHz);
      for (const system of [profile.splitPhase, profile.threePhaseCommercial, profile.threePhaseIndustrial]) {
        values.push(system.lineToNeutralV, system.lineToLineV);
      }
      for (const range of Object.values(profile.voltageRanges)) values.push(range.min, range.max);
    }
    for (const value of values) {
      expect(Number.isFinite(value.value) && value.value > 0).toBe(true);
      expect(['Hz', 'V', '1']).toContain(value.unit);
      expect(value.kind).toBe('real-world');
      expect(value.source.length).toBeGreaterThan(40);
      // Realism charter: cite standards by name, never quote the NEC.
      expect(value.source).not.toMatch(/NFPA 70|NEC Table/);
    }
  });

  it('has the ANSI C84.1 ranges (F2.4): A inside B, utilization below service, on a 120 V base', () => {
    const r = NEC_REGION.voltageRanges;
    const at120 = (range: (typeof r)['serviceA']) => voltageBand(range, 120).map((v) => Math.round(v * 1e9) / 1e9);
    expect(at120(r.serviceA)).toStrictEqual([114, 126]);
    expect(at120(r.utilizationA)).toStrictEqual([108, 125]);
    expect(at120(r.serviceB)).toStrictEqual([110, 127]);
    expect(at120(r.utilizationB)).toStrictEqual([104, 127]);
    for (const [a, b] of [
      [r.serviceA, r.serviceB],
      [r.utilizationA, r.utilizationB],
    ]) {
      expect(b.min.value).toBeLessThan(a.min.value);
      expect(b.max.value).toBeGreaterThanOrEqual(a.max.value);
    }
    expect(r.utilizationA.min.value).toBeLessThan(r.serviceA.min.value);
    // Scaled to the other systems: Range A service at 480 V is ±5 %.
    expect(voltageBand(r.serviceA, 480).map((v) => Math.round(v))).toStrictEqual([456, 504]);
  });
});

describe('NEC conductor colour rules (catalogue v2)', () => {
  const rules = NEC_REGION.conductorColours;
  const c = (base: string, stripe: string | null = null) => ({ base, stripe });

  it('every colour id they name is in the built-in colour table', () => {
    const ids = [
      ...[rules.grounded, rules.equipmentGrounding].flatMap((r) => [
        ...r.patterns.flatMap((p) => [p.base, p.stripe]),
        ...r.excludedBases,
      ]),
      ...rules.notForUngrounded.colours,
      ...rules.ungrounded.flatMap((u) => u.colours),
      rules.highLeg.colour,
    ].filter((id): id is string => id !== null);
    for (const id of ids) expect(BUILTIN_CATALOG.colour(id), id).toBeDefined();
  });

  it('grounded: white or grey, or a white or grey stripe on anything but green (Art. 200.6)', () => {
    const accepted = [c('white'), c('grey'), c('black', 'white'), c('red', 'grey')];
    expect(accepted.every((x) => matchesColourRule(rules.grounded, x))).toBe(true);
    const refused = [c('green', 'white'), c('black'), c('white', 'red')];
    expect(refused.some((x) => matchesColourRule(rules.grounded, x))).toBe(false);
  });

  it('EGC: bare, green, or green with a yellow stripe (Art. 250.119)', () => {
    const egc = rules.equipmentGrounding;
    expect([c('bare'), c('green'), c('green', 'yellow')].every((x) => matchesColourRule(egc, x))).toBe(true);
    expect([c('yellow', 'green'), c('white')].some((x) => matchesColourRule(egc, x))).toBe(false);
  });

  it('ungrounded colours are labelled convention, for systems the profile names, avoiding reserved colours', () => {
    const systems = [NEC_REGION.splitPhase, NEC_REGION.threePhaseCommercial, NEC_REGION.threePhaseIndustrial];
    expect(rules.ungrounded.map((u) => [u.system, u.colours, u.basis])).toStrictEqual([
      ['120/240 V', ['black', 'red'], 'convention'],
      ['208Y/120 V', ['black', 'red', 'blue'], 'convention'],
      ['480Y/277 V', ['brown', 'orange', 'yellow'], 'convention'],
    ]);
    for (const u of rules.ungrounded) {
      const system = systems.find((s) => s.name === u.system);
      expect(system, u.system).toBeDefined();
      expect(u.colours).toHaveLength(system?.phases === 1 ? 2 : 3);
      expect(u.source).toMatch(/^Industry convention, not a code rule/);
      for (const id of u.colours) expect(rules.notForUngrounded.colours).not.toContain(id);
    }
  });

  it('cites NFPA 70-2023 article numbers and reproduces no code text', () => {
    const sources = [
      rules.grounded.source,
      rules.equipmentGrounding.source,
      rules.notForUngrounded.source,
      rules.highLeg.source,
    ];
    expect(sources.map((s) => /NFPA 70-2023/.test(s) && /Art\. \d{3}\.\d+/.test(s))).toStrictEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(sources.join(' ')).not.toMatch(/\bshall\b/);
  });
});
