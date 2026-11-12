import { BUILTIN_CATALOG } from './builtin';
import { conductorPhysics, conductorResistanceOhm } from './conductor';
import { awgName } from './gauge';

/*
 * F3.1 part 1's conductor entries (content/devices/conductor.*): THHN/THWN-2 copper 14 AWG to 4/0,
 * MTW 18 to 10 AWG and two aluminium XHHW-2 sizes, under fictional brands. The values are product
 * data from public specification sheets without ampacity columns (sources in each entry); every
 * derived value (area, resistance, ampacity) is computed, never stored.
 */

const conductors = BUILTIN_CATALOG.devices.filter((d) => d.model.kind === 'conductor');
const summary = (d: (typeof conductors)[number]) => {
  const c = d.conductor;
  if (c === null) throw new Error(`${d.id} has no conductor data`);
  return c;
};

describe('the F3.1 conductor entries', () => {
  it('are THHN/THWN-2 14 AWG–4/0 (solid where made), MTW 18–10 AWG and aluminium XHHW-2 4 AWG and 4/0', () => {
    expect(
      conductors.map((d) => {
        const c = summary(d);
        return `${c.insulation?.key} ${c.material.key} ${awgName(c.awg)} ${c.stranding}/${c.strandCount}`;
      }),
    ).toStrictEqual([
      'xhhw2 aluminiumAa8000 4/0 stranded/19',
      'xhhw2 aluminiumAa8000 4 stranded/7',
      'mtw copperAnnealed 10 stranded/19',
      'mtw copperAnnealed 12 stranded/19',
      'mtw copperAnnealed 14 stranded/19',
      'mtw copperAnnealed 16 stranded/26',
      'mtw copperAnnealed 18 stranded/16',
      'thhnThwn2 copperAnnealed 1/0 stranded/19',
      'thhnThwn2 copperAnnealed 10 solid/1',
      'thhnThwn2 copperAnnealed 10 stranded/19',
      'thhnThwn2 copperAnnealed 12 solid/1',
      'thhnThwn2 copperAnnealed 12 stranded/19',
      'thhnThwn2 copperAnnealed 14 solid/1',
      'thhnThwn2 copperAnnealed 14 stranded/19',
      'thhnThwn2 copperAnnealed 2/0 stranded/19',
      'thhnThwn2 copperAnnealed 2 stranded/19',
      'thhnThwn2 copperAnnealed 3/0 stranded/19',
      'thhnThwn2 copperAnnealed 4/0 stranded/19',
      'thhnThwn2 copperAnnealed 4 stranded/19',
      'thhnThwn2 copperAnnealed 6 stranded/19',
      'thhnThwn2 copperAnnealed 8 stranded/19',
    ]);
    expect(conductors.every((d) => d.version === 1 && d.category === 'conductor')).toBe(true);
  });

  it('use fictional brands only: Tallowmere (copper THHN/THWN-2 and MTW) and Quorvale (aluminium XHHW-2)', () => {
    for (const d of conductors) {
      expect(d.brand, d.id).toBe(summary(d).material.key === 'aluminiumAa8000' ? 'Quorvale' : 'Tallowmere');
      expect(d.id.startsWith(`conductor.${d.brand.toLowerCase()}-`), d.id).toBe(true);
    }
  });

  it('a solid conductor has lay factor 1, a stranded one 1.02 (NBS Handbooks 100 and 109)', () => {
    for (const d of conductors) {
      expect(d.model.params, d.id).toStrictEqual({ layFactor: summary(d).stranding === 'solid' ? 1 : 1.02 });
    }
  });

  it('aluminium starts at 12 AWG (NFPA 70-2023 Art. 310.3(A), by number): no smaller aluminium entry', () => {
    for (const d of conductors) {
      if (summary(d).material.key === 'aluminiumAa8000') expect(summary(d).awg, d.id).toBeLessThanOrEqual(12);
    }
  });

  it('THHN has a nylon jacket layer over its PVC; MTW and XHHW-2 are single layers', () => {
    for (const d of conductors) {
      const c = summary(d);
      expect(c.jacketThicknessMm !== null, d.id).toBe(c.insulation?.key === 'thhnThwn2');
    }
    // The THHN walls by size class (15/20/30/40/50 mil PVC under 4/4/5/6/7 mil nylon, rounded to mm).
    const walls = conductors
      .filter((d) => summary(d).insulation?.key === 'thhnThwn2')
      .map((d) => `${awgName(summary(d).awg)} ${summary(d).insulationThicknessMm}+${summary(d).jacketThicknessMm}`);
    expect(new Set(walls)).toStrictEqual(
      new Set([
        '1/0 1.27+0.178',
        '10 0.508+0.102',
        '12 0.381+0.102',
        '14 0.381+0.102',
        '2/0 1.27+0.178',
        '2 1.016+0.152',
        '3/0 1.27+0.178',
        '4/0 1.27+0.178',
        '4 1.016+0.152',
        '6 0.762+0.127',
        '8 0.762+0.127',
      ]),
    );
  });

  it('the derived aluminium resistance agrees with the XHHW-2 maker’s published 20 °C figure within 3 %', () => {
    // Cross-check only (never stored): the datasheet the entries cite gives 1.39 Ω/km (4 AWG) and 0.274 Ω/km
    // (4/0) at 20 °C. Derived: 2.8264e-8 Ω·m × 1.02 / 21.1506e-6 m² = 1.36305 Ω/km (−1.9 %);
    // 2.8264e-8 × 1.02 / 107.219e-6 = 0.26888 Ω/km (−1.9 %). The maker's figures sit a little higher, as
    // a minimum-conductivity alloy or a maximum-resistance column would.
    const perKm = (id: string) => {
      const entry = BUILTIN_CATALOG.device({ id, version: 1 });
      const physics = entry && conductorPhysics(BUILTIN_CATALOG, entry);
      if (!physics) throw new Error(id);
      return conductorResistanceOhm(physics, 1_000_000, 293.15);
    };
    expect(perKm('conductor.quorvale-xhhw2-al-4-compact')).toBeCloseTo(1.36305, 4);
    expect(perKm('conductor.quorvale-xhhw2-al-4-0-compact')).toBeCloseTo(0.26888, 4);
    expect(Math.abs(perKm('conductor.quorvale-xhhw2-al-4-compact') / 1.39 - 1)).toBeLessThan(0.03);
    expect(Math.abs(perKm('conductor.quorvale-xhhw2-al-4-0-compact') / 0.274 - 1)).toBeLessThan(0.03);
  });

  it('every entry lists colours from the colour table; XHHW-2 is black only', () => {
    for (const d of conductors) {
      const c = summary(d);
      for (const colour of c.colours) expect(BUILTIN_CATALOG.colourIds, d.id).toContain(colour.base);
      if (c.insulation?.key === 'xhhw2') expect(c.colours).toStrictEqual([{ base: 'black', stripe: null }]);
    }
  });
});
