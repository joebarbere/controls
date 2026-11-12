import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_CATALOG } from './builtin';
import { gaugeRow } from './gauge';

/*
 * The termination accessories (content/accessories/, F3.1 part 2 alongside the NM-B cables; consumed by
 * F3.3 part 1's crimp term): insulated ferrules and insulated ring and fork lugs under the fictional brand
 * Thimbleby. Twist-on wire nuts are not accessories: ADR 0018 §4.4 makes them `splice.twistOn` devices
 * whose `combination` bounds are a terminal method field, both added by F3.3 part 1.
 */

const contentDir = join(import.meta.dirname, '../../../../../content');
const accessories = BUILTIN_CATALOG.accessories;
const ferrules = accessories.filter((a) => a.kind === 'ferrule');
const lugs = accessories.filter((a) => a.kind !== 'ferrule');
const rel = (a: number, b: number) => Math.abs(a / b - 1);

/** The insulated-terminal colour code, and the crimper dies of the same ids (tool.veltmark-cr-2210, F3.4 part 1). */
const DIE_RANGES: Record<string, { smallest: number; largest: number }> = {
  red: { smallest: 22, largest: 18 },
  blue: { smallest: 16, largest: 14 },
  yellow: { smallest: 12, largest: 10 },
};

describe('the termination accessories', () => {
  it('are five ferrules (18–10 AWG) and seven insulated lugs, version 1, one file each, brand Thimbleby', () => {
    expect(accessories.map((a) => `${a.id}@${a.version}:${a.kind}`)).toStrictEqual([
      'ferrule.thimbleby-10@1:ferrule',
      'ferrule.thimbleby-12@1:ferrule',
      'ferrule.thimbleby-14@1:ferrule',
      'ferrule.thimbleby-16@1:ferrule',
      'ferrule.thimbleby-18@1:ferrule',
      'lug.thimbleby-fork-blue-8@1:forkLug',
      'lug.thimbleby-fork-red-8@1:forkLug',
      'lug.thimbleby-fork-yellow-10@1:forkLug',
      'lug.thimbleby-ring-blue-10@1:ringLug',
      'lug.thimbleby-ring-blue-8@1:ringLug',
      'lug.thimbleby-ring-red-8@1:ringLug',
      'lug.thimbleby-ring-yellow-10@1:ringLug',
    ]);
    expect(readdirSync(join(contentDir, 'accessories')).sort()).toStrictEqual(
      accessories.map((a) => `${a.id}.v${a.version}.json`),
    );
    for (const a of accessories) expect(a.brand, a.id).toBe('Thimbleby');
  });

  it('a ferrule fits one stranded size, crimped in the square die, its nominal size at or above the AWG area', () => {
    // The ferrule maker's mm² size for each AWG; the conductor's area (AWG definition) must fit in it:
    //   18 AWG 0.823 ≤ 1.0, 16 AWG 1.309 ≤ 1.5, 14 AWG 2.081 ≤ 2.5, 12 AWG 3.309 ≤ 4, 10 AWG 5.261 ≤ 6 mm².
    const nominalMm2: Record<number, number> = { 18: 1.0, 16: 1.5, 14: 2.5, 12: 4, 10: 6 };
    const sleeveMm: Record<number, number> = { 18: 8, 16: 8, 14: 8, 12: 10, 10: 12 };
    for (const f of ferrules) {
      const awg = f.awgRange.smallest;
      expect(f.awgRange.largest, f.id).toBe(awg);
      expect([f.stranding, f.dies, f.studDiameterMm], f.id).toStrictEqual([['stranded'], ['square'], null]);
      expect(f.barrelLengthMm, f.id).toBe(sleeveMm[awg]);
      const area = gaugeRow(awg)?.areaMm2 ?? NaN;
      expect(area, f.id).toBeLessThanOrEqual(nominalMm2[awg]);
      expect(area, f.id).toBeGreaterThan(0.75 * nominalMm2[awg]);
    }
  });

  it('a lug’s range and die follow the colour code; its die is the crimper die of the same colour', () => {
    for (const lug of lugs) {
      expect(lug.dies.length, lug.id).toBe(1);
      const die = lug.dies[0];
      expect(lug.id, lug.id).toContain(`-${die}-`);
      expect(lug.awgRange, lug.id).toStrictEqual(DIE_RANGES[die]);
      expect(lug.stranding, lug.id).toStrictEqual(['solid', 'stranded']);
      expect(lug.barrelLengthMm, lug.id).toBe(die === 'yellow' ? 13 : 10);
    }
  });

  // Runs once the crimper (F3.4 part 1) is in the built-in catalogue.
  const crimper = BUILTIN_CATALOG.tools.find((t) => t.id === 'tool.veltmark-cr-2210');
  it.runIf(crimper !== undefined)('every lug die exists on the crimper with the same AWG range', () => {
    for (const lug of lugs) {
      const die = crimper?.dies.find((d) => d.id === lug.dies[0]);
      expect(die?.awgRange, lug.id).toStrictEqual(lug.awgRange);
    }
  });

  it('a lug’s stud is a Unified numbered screw: 0.060 in + 0.013 in × N, within 0.5 %', () => {
    // #8: 0.060 + 0.013 × 8 = 0.164 in × 25.4 = 4.1656 mm (stored 4.17);
    // #10: 0.060 + 0.013 × 10 = 0.190 in × 25.4 = 4.8260 mm (stored 4.83).
    const studMm = (n: number) => (0.06 + 0.013 * n) * 25.4;
    expect(studMm(8)).toBeCloseTo(4.1656, 4);
    expect(studMm(10)).toBeCloseTo(4.826, 4);
    for (const lug of lugs) {
      const n = Number(lug.id.split('-').at(-1));
      expect(rel(lug.studDiameterMm ?? NaN, studMm(n)), lug.id).toBeLessThan(0.005);
    }
  });
});
