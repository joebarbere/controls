import { RegionId } from '@controls/save-format';
import { NEC_REGION, REGION_PROFILES, regionProfile, type RegionValue, voltageBand } from './region';

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
