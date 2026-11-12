import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_CATALOG } from './builtin';
import { conductorPhysics, conductorResistanceOhm } from './conductor';
import type { DeviceDefinition } from './device';
import type { CableDefinition } from './families';
import { gaugeRow } from './gauge';

/*
 * F3.1 part 2: NM-B cable assemblies (content/cables/) and the conductor entries they pin
 * (content/devices/conductor.sorrelby-*). Product data come from one maker's public NM-B sheet with no
 * ampacity column (sources in each entry), under the fictional brand Sorrelby. Resistance is derived
 * from part 1's function, never stored; no ampacity is stored (NM-B's 60 °C limit, Art. 334.80, is P4's).
 */

const contentDir = join(import.meta.dirname, '../../../../../content');
const cables = BUILTIN_CATALOG.cables;
const nmConductors = BUILTIN_CATALOG.devices.filter((d) => d.brand === 'Sorrelby');
const deviceOf = (ref: { id: string; version: number }): DeviceDefinition => {
  const device = BUILTIN_CATALOG.device(ref);
  if (!device) throw new Error(`${ref.id}@${ref.version} missing`);
  return device;
};
const spec = (d: DeviceDefinition) => {
  if (d.conductor === null) throw new Error(`${d.id} has no conductor data`);
  return d.conductor;
};
const physicsOf = (d: DeviceDefinition) => {
  const physics = conductorPhysics(BUILTIN_CATALOG, d);
  if (!physics) throw new Error(d.id);
  return physics;
};
/** Resistance per metre at T₀ = 20 °C (Ω/m), through part 1's `conductorResistanceOhm`. */
const ohmPerMetre = (d: DeviceDefinition) => conductorResistanceOhm(physicsOf(d), 1000, 293.15);
const rel = (a: number, b: number) => Math.abs(a / b - 1);
/** The circuit conductors' size and count, from the id (`cable.sorrelby-nmb-14-2` → 14, 2). */
const sizeOf = (c: CableDefinition) => {
  const [awg, count] = c.id.replace('cable.sorrelby-nmb-', '').split('-').map(Number);
  return { awg, count };
};

describe('the F3.1 part 2 NM-B cables', () => {
  it('are NM-B 14/2, 14/3, 12/2, 12/3, 10/2, 10/3, 8/3 and 6/3 with ground, version 1, one file each', () => {
    expect(cables.map((c) => `${c.id}@${c.version}`)).toStrictEqual([
      'cable.sorrelby-nmb-10-2@1',
      'cable.sorrelby-nmb-10-3@1',
      'cable.sorrelby-nmb-12-2@1',
      'cable.sorrelby-nmb-12-3@1',
      'cable.sorrelby-nmb-14-2@1',
      'cable.sorrelby-nmb-14-3@1',
      'cable.sorrelby-nmb-6-3@1',
      'cable.sorrelby-nmb-8-3@1',
    ]);
    const names = readdirSync(join(contentDir, 'cables')).sort();
    expect(names).toStrictEqual(cables.map((c) => `${c.id}.v${c.version}.json`));
  });

  it('use one fictional brand, Sorrelby, for the cables and the conductors they pin', () => {
    for (const c of cables) expect(c.brand, c.id).toBe('Sorrelby');
    for (const d of nmConductors) expect(d.id.startsWith('conductor.sorrelby-'), d.id).toBe(true);
  });

  it('list ungrounded conductors, then the grounded one, then the bare EGC, indices in order', () => {
    for (const c of cables) {
      const { awg, count } = sizeOf(c);
      const roles = c.conductors.map((m) => `${m.index}:${m.role}:${m.colour.base}:${m.insulated}`);
      expect(roles, c.id).toStrictEqual(
        count === 2
          ? ['0:ungrounded:black:true', '1:grounded:white:true', '2:egc:bare:false']
          : ['0:ungrounded:black:true', '1:ungrounded:red:true', '2:grounded:white:true', '3:egc:bare:false'],
      );
      // Every insulated member pins the same NM conductor of the cable's size; the EGC a bare entry.
      for (const member of c.conductors) {
        const conductor = spec(deviceOf(member.conductor));
        expect(conductor.material.key, c.id).toBe('copperAnnealed');
        expect(member.colour.stripe, c.id).toBeNull();
        if (member.insulated)
          expect([conductor.awg, conductor.insulation?.key], c.id).toStrictEqual([awg, 'thhnThwn2']);
        else
          expect([conductor.insulation, conductor.colours], c.id).toStrictEqual([
            null,
            [{ base: 'bare', stripe: null }],
          ]);
      }
    }
  });

  it('the EGC is the circuit size at 14–10 AWG and 10 AWG in 8/3 and 6/3 (the sheet read), never larger', () => {
    const egc = cables.map((c) => {
      const ground = c.conductors.find((m) => m.role === 'egc');
      if (!ground) throw new Error(c.id);
      return `${sizeOf(c).awg}/${sizeOf(c).count}:${spec(deviceOf(ground.conductor)).awg}`;
    });
    expect(egc).toStrictEqual(['10/2:10', '10/3:10', '12/2:12', '12/3:12', '14/2:14', '14/3:14', '6/3:10', '8/3:10']);
  });

  it('jacket: the nmbJacket row, the size colour (white 14, yellow 12, orange 10, black 8 and 6), 30 mil', () => {
    const colourBySize: Record<number, string> = { 14: 'white', 12: 'yellow', 10: 'orange', 8: 'black', 6: 'black' };
    for (const c of cables) {
      expect(c.jacket.material, c.id).toStrictEqual({ table: 'insulation', version: 1, key: 'nmbJacket' });
      expect(c.jacket.colour, c.id).toBe(colourBySize[sizeOf(c).awg]);
      expect(c.jacket.thicknessMm, c.id).toBe(0.762);
    }
  });

  it('the outer size is the sheet’s, converted from inches (25.4 mm/in) within 0.5 %', () => {
    // Hand conversion of the sheet's approximate dimensions (inches), height × width or the diameter:
    //   14/2 0.185 × 0.370 → 4.699 × 9.398 mm; 14/3 0.185 × 0.450 → 4.699 × 11.430;
    //   12/2 0.200 × 0.400 → 5.080 × 10.160;   12/3 0.200 × 0.520 → 5.080 × 13.208;
    //   10/2 0.225 × 0.490 → 5.715 × 12.446;   10/3 0.250 × 0.650 → 6.350 × 16.510;
    //   8/3 ⌀ 0.530 → 13.462;                  6/3 ⌀ 0.575 → 14.605.
    const expected: Record<string, [number, number]> = {
      '14-2': [4.699, 9.398],
      '14-3': [4.699, 11.43],
      '12-2': [5.08, 10.16],
      '12-3': [5.08, 13.208],
      '10-2': [5.715, 12.446],
      '10-3': [6.35, 16.51],
      '8-3': [13.462, 13.462],
      '6-3': [14.605, 14.605],
    };
    for (const c of cables) {
      const [h, w] = expected[c.id.replace('cable.sorrelby-nmb-', '')];
      expect(rel(c.jacket.heightMm, h), c.id).toBeLessThan(0.005);
      expect(rel(c.jacket.widthMm, w), c.id).toBeLessThan(0.005);
    }
  });

  it('the jacket holds its conductors: at least the geometric minimum, at most 20 % above it (paper, fill)', () => {
    // d_ins = d + 2 (t_PVC + t_nylon) from the pinned entries (stranded taken at the solid diameter, as
    // conductorPhysics does), d_g the bare EGC, t the jacket wall.
    //   Flat (two conductors, and the flat three-conductor sheet sizes 14/3–10/3): the conductors side by
    //   side with the EGC between, width = n · d_ins + d_g + 2t, height = d_ins + 2t.
    //   Round (8/3, 6/3): three insulated conductors in a triangle, the EGC tangent to two of them in the
    //   outer groove; the smallest circle around them is the triangle's own, radius R_t = d_ins/√3 + d_ins/2,
    //   unless the EGC reaches past it (x_g + r_g > R_t, with x_g = d_ins/(2√3) + √((d_ins/2 + r_g)² − (d_ins/2)²)),
    //   then the circle through the far conductor's and the EGC's outer points, D = R_t + x_g + r_g.
    //   14/2: d_ins = 1.62773 + 2 × 0.483 = 2.59373; width 2 × 2.59373 + 1.62773 + 1.524 = 8.3392 (sheet 9.398, +12.7 %).
    //   6/3:  d_ins = 4.11538 + 2 × 0.889 = 5.89338; R_t = 6.34901; x_g + r_g = 6.04477 < R_t; D = 12.6980 + 1.524 = 14.2220 (sheet 14.605, +2.7 %).
    const minimum = (c: CableDefinition) => {
      const t = c.jacket.thicknessMm;
      const insulated = c.conductors.filter((m) => m.insulated).map((m) => spec(deviceOf(m.conductor)));
      const ground = c.conductors.find((m) => !m.insulated);
      if (!ground) throw new Error(c.id);
      const dg = gaugeRow(spec(deviceOf(ground.conductor)).awg)?.diameterMm ?? NaN;
      const c0 = insulated[0];
      const dIns =
        (gaugeRow(c0.awg)?.diameterMm ?? NaN) + 2 * ((c0.insulationThicknessMm ?? 0) + (c0.jacketThicknessMm ?? 0));
      if (c.jacket.widthMm !== c.jacket.heightMm) {
        return { w: insulated.length * dIns + dg + 2 * t, h: dIns + 2 * t };
      }
      const rt = dIns / Math.sqrt(3) + dIns / 2;
      const s = dIns / 2;
      const rg = dg / 2;
      const reach = dIns / (2 * Math.sqrt(3)) + Math.sqrt((s + rg) ** 2 - s ** 2) + rg;
      const d = (reach > rt ? rt + reach : 2 * rt) + 2 * t;
      return { w: d, h: d };
    };
    const at = (id: string) => minimum(cables.find((c) => c.id === id) as CableDefinition);
    expect(at('cable.sorrelby-nmb-14-2').w).toBeCloseTo(8.3392, 3);
    expect(at('cable.sorrelby-nmb-6-3').w).toBeCloseTo(14.222, 3);
    for (const c of cables) {
      const min = minimum(c);
      for (const [stored, least] of [
        [c.jacket.widthMm, min.w],
        [c.jacket.heightMm, min.h],
      ]) {
        expect(stored, c.id).toBeGreaterThanOrEqual(least);
        expect(stored / least, c.id).toBeLessThanOrEqual(1.2);
      }
    }
  });

  it('two-conductor cables are flat, 8/3 and 6/3 round, as the sheet gives them', () => {
    expect(cables.filter((c) => c.jacket.widthMm === c.jacket.heightMm).map((c) => c.id)).toStrictEqual([
      'cable.sorrelby-nmb-6-3',
      'cable.sorrelby-nmb-8-3',
    ]);
  });

  it('store no ampacity anywhere (NEC 310.16 values are never content; Art. 334.80 is a P4 rule)', () => {
    const files = [
      ...readdirSync(join(contentDir, 'cables')).map((n) => join(contentDir, 'cables', n)),
      ...nmConductors.map((d) => join(contentDir, 'devices', `${d.id}.v${d.version}.json`)),
    ];
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(/ampacity"\s*:|"amp/i);
  });
});

describe('the NM-B conductor entries (Sorrelby)', () => {
  it('are THHN-type 14–10 AWG solid and 8 and 6 AWG 7-strand, and bare solid 14, 12 and 10 AWG EGCs', () => {
    expect(
      nmConductors.map((d) => {
        const c = spec(d);
        return `${d.id} ${c.insulation?.key ?? 'bare'} ${c.stranding}/${c.strandCount} ${d.model.params['layFactor']}`;
      }),
    ).toStrictEqual([
      'conductor.sorrelby-bare-10-solid bare solid/1 1',
      'conductor.sorrelby-bare-12-solid bare solid/1 1',
      'conductor.sorrelby-bare-14-solid bare solid/1 1',
      'conductor.sorrelby-nm-10-solid thhnThwn2 solid/1 1',
      'conductor.sorrelby-nm-12-solid thhnThwn2 solid/1 1',
      'conductor.sorrelby-nm-14-solid thhnThwn2 solid/1 1',
      'conductor.sorrelby-nm-6-stranded thhnThwn2 stranded/7 1.02',
      'conductor.sorrelby-nm-8-stranded thhnThwn2 stranded/7 1.02',
    ]);
    expect(nmConductors.every((d) => d.version === 1 && d.category === 'conductor')).toBe(true);
  });

  it('insulated ones have the THHN walls of the same size (the Tallowmere entries) and come in black, white, red', () => {
    for (const d of nmConductors.filter((n) => spec(n).insulation !== null)) {
      const c = spec(d);
      const thhn = spec(deviceOf({ id: `conductor.tallowmere-thhn-${c.awg}-${c.stranding}`, version: 1 }));
      expect([c.insulationThicknessMm, c.jacketThicknessMm], d.id).toStrictEqual([
        thhn.insulationThicknessMm,
        thhn.jacketThicknessMm,
      ]);
      expect(
        c.colours.map((k) => k.base),
        d.id,
      ).toStrictEqual(['black', 'white', 'red']);
    }
  });

  it('resistance per metre at 20 °C matches the hand calculation within 0.5 %', () => {
    // R′ = ρ₀ · k_lay / A, ρ₀ = 1/58 Ω·mm²/m = 1.724138e-8 Ω·m (copperAnnealed), A = π/4 · d²,
    // d = 0.127 mm · 92^((36 − n)/39) (AWG definition):
    //   14 AWG: d = 1.62773 mm, A = 2.08091 mm², R′ = 1.724138e-8 / 2.08091e-6        = 8.28551 mΩ/m
    //   12 AWG: d = 2.05253 mm, A = 3.30877 mm², R′ = 1.724138e-8 / 3.30877e-6        = 5.21081 mΩ/m
    //   10 AWG: d = 2.58819 mm, A = 5.26115 mm², R′ = 1.724138e-8 / 5.26115e-6        = 3.27711 mΩ/m
    //    8 AWG: d = 3.26364 mm, A = 8.36556 mm², R′ = 1.724138e-8 × 1.02 / 8.36556e-6 = 2.10221 mΩ/m
    //    6 AWG: d = 4.11538 mm, A = 13.3018 mm², R′ = 1.724138e-8 × 1.02 / 13.3018e-6 = 1.32210 mΩ/m
    const expected: Record<string, number> = {
      'conductor.sorrelby-nm-14-solid': 8.28551e-3,
      'conductor.sorrelby-bare-14-solid': 8.28551e-3,
      'conductor.sorrelby-nm-12-solid': 5.21081e-3,
      'conductor.sorrelby-bare-12-solid': 5.21081e-3,
      'conductor.sorrelby-nm-10-solid': 3.27711e-3,
      'conductor.sorrelby-bare-10-solid': 3.27711e-3,
      'conductor.sorrelby-nm-8-stranded': 2.10221e-3,
      'conductor.sorrelby-nm-6-stranded': 1.3221e-3,
    };
    expect(Object.keys(expected).sort()).toStrictEqual(nmConductors.map((d) => d.id));
    for (const d of nmConductors) expect(rel(ohmPerMetre(d), expected[d.id]), d.id).toBeLessThan(0.005);
  });

  it('every cable’s conductors, by hand: 30 m of 14/2 is 0.497131 Ω out and back (the plan’s 0.248565 Ω each way)', () => {
    // 30 m × 8.28551 mΩ/m = 0.248565 Ω per conductor (the P3 voltage-drop golden); the loop is twice that.
    const nm14 = deviceOf({ id: 'conductor.sorrelby-nm-14-solid', version: 1 });
    const one = conductorResistanceOhm(physicsOf(nm14), 30_000, 293.15);
    expect(rel(one, 0.248565)).toBeLessThan(0.005);
    expect(rel(2 * one, 0.497131)).toBeLessThan(0.005);
    // Each cable's members: the insulated ones equal, the EGC never below them (never larger).
    for (const c of cables) {
      const [first, ...rest] = c.conductors.map((m) => ohmPerMetre(deviceOf(m.conductor)));
      const egc = rest.pop() as number;
      for (const r of rest) expect(r, c.id).toBe(first);
      expect(egc, c.id).toBeGreaterThanOrEqual(first);
    }
  });
});
