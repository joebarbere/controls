import { BUILTIN_CATALOG } from './builtin';
import type { ToolDefinition } from './families';
import { AWG_GAUGES } from './gauge';
import { DRIVE_TYPES, drivesFit, ENTRY_TYPES } from './registries';

/*
 * The hand tools of F3.4 part 1 (`content/tools/`, D10, ADR 0015 "Tool capabilities"). Hole and die
 * ids are save format per tool entry version (a termination records them), so this spec pins them:
 * renaming or removing one is a new entry version, never an edit.
 */

const tool = (id: string): ToolDefinition => {
  const found = BUILTIN_CATALOG.tool({ id, version: 1 });
  if (!found) throw new Error(`${id} is not in the built-in catalogue`);
  return found;
};
const caps = (t: ToolDefinition) => t.capabilities.map((c) => `${c.step}:${c.maxAwg ?? 'any'}`);
/** Solid diameter (mm) from the AWG definition, NBS Handbook 100 §2: d = 0.127 × 92^((36 − n)/39). */
const d = (n: number) => 0.127 * 92 ** ((36 - n) / 39);

describe('the built-in hand tools (F3.4 part 1)', () => {
  it('are the nine P3 part 1 tools at version 1, in the tool family', () => {
    expect(BUILTIN_CATALOG.tools.map((t) => [t.id, t.version, t.kind])).toStrictEqual([
      ['tool.calderyn-ts-03', 1, 'torqueDriver'],
      ['tool.calderyn-ts-15', 1, 'torqueDriver'],
      ['tool.penmarrow-lp-12', 1, 'labelMaker'],
      ['tool.veltmark-cr-2210', 1, 'crimper'],
      ['tool.veltmark-dc-8', 1, 'cutter'],
      ['tool.veltmark-nd-516', 1, 'nutDriver'],
      ['tool.veltmark-sd-2', 1, 'screwdriver'],
      ['tool.veltmark-ws-1018', 1, 'stripper'],
      ['tool.veltmark-ws-nm12', 1, 'stripper'],
    ]);
    for (const t of BUILTIN_CATALOG.tools) expect(BUILTIN_CATALOG.family(t)).toBe('tool');
  });

  it('use fictional brands only (realism charter)', () => {
    expect([...new Set(BUILTIN_CATALOG.tools.map((t) => t.brand))].sort()).toStrictEqual([
      'Calderyn',
      'Penmarrow',
      'Veltmark',
    ]);
  });

  it('declare capabilities, not kinds: both strippers cut; only the NM stripper splits a jacket', () => {
    expect(caps(tool('tool.veltmark-ws-1018'))).toStrictEqual(['strip:10', 'cut:10']);
    expect(caps(tool('tool.veltmark-ws-nm12'))).toStrictEqual(['strip:12', 'stripJacket:12', 'cut:12']);
    expect(caps(tool('tool.veltmark-dc-8'))).toStrictEqual(['cut:8']);
    expect(caps(tool('tool.veltmark-sd-2'))).toStrictEqual(['drive:any']);
    expect(caps(tool('tool.calderyn-ts-03'))).toStrictEqual(['drive:any', 'torque:any']);
    expect(caps(tool('tool.calderyn-ts-15'))).toStrictEqual(['drive:any', 'torque:any']);
    expect(caps(tool('tool.veltmark-cr-2210'))).toStrictEqual(['crimp:10']);
    expect(caps(tool('tool.veltmark-nd-516'))).toStrictEqual(['drive:any']);
    expect(caps(tool('tool.penmarrow-lp-12'))).toStrictEqual(['label:any']);
  });

  it('pin the stripper hole ids (save format): each hole is marked solid n and stranded n + 2, the next even size', () => {
    const holes = tool('tool.veltmark-ws-1018').holes;
    expect(holes.map((h) => h.id)).toStrictEqual([
      'sol10',
      'sol12',
      'sol14',
      'sol16',
      'sol18',
      'str12',
      'str14',
      'str16',
      'str18',
      'str20',
    ]);
    const solid = holes.filter((h) => h.stranding === 'solid').map((h) => h.awg);
    const stranded = holes.filter((h) => h.stranding === 'stranded').map((h) => h.awg);
    expect(stranded).toStrictEqual(solid.map((awg) => awg + 2));
    for (const h of holes) expect(h.id).toBe(`${h.stranding === 'solid' ? 'sol' : 'str'}${h.awg}`);
    expect(Math.min(...holes.map((h) => h.awg))).toBe(10); // the strip capability reaches the largest hole
    expect(tool('tool.veltmark-ws-nm12').holes.map((h) => h.id)).toStrictEqual(['sol12', 'sol14', 'str14', 'str16']);
  });

  it('pair stranded n with solid n − 2 because 7 strands of equal area are 3/√7 ≈ 1.134 × the solid diameter', () => {
    // Seven equal round strands of total area A: each strand d_s = d/√7, the concentric bundle 3 d_s = 3d/√7.
    const factor = 3 / Math.sqrt(7);
    expect(factor).toBeCloseTo(1.134, 3);
    // 12 AWG: d = 0.127 × 92^(24/39) ≈ 2.053 mm solid, so ≈ 2.328 mm stranded, between solid 11 (2.305)
    // and solid 10 (2.588): it fits the solid-10 hole.
    const stranded12 = d(12) * factor;
    expect(stranded12).toBeCloseTo(2.33, 2);
    expect(d(11)).toBeCloseTo(2.305, 3);
    expect(d(10)).toBeCloseTo(2.588, 3);
    expect(stranded12).toBeGreaterThan(d(11));
    expect(stranded12).toBeLessThan(d(10));
  });

  it('pin the crimper die ids (save format): the red, blue and yellow insulated-terminal code', () => {
    expect(tool('tool.veltmark-cr-2210').dies).toStrictEqual([
      { id: 'red', label: 'Red 22–18', awgRange: { smallest: 22, largest: 18 } },
      { id: 'blue', label: 'Blue 16–14', awgRange: { smallest: 16, largest: 14 } },
      { id: 'yellow', label: 'Yellow 12–10', awgRange: { smallest: 12, largest: 10 } },
    ]);
  });

  it('give the torque screwdrivers ±6 % ranges that reach every marked terminal torque in the catalogue', () => {
    const low = tool('tool.calderyn-ts-03').torque;
    const high = tool('tool.calderyn-ts-15').torque;
    expect(low).toStrictEqual({ minNm: 0.3, maxNm: 1.2, accuracyFraction: 0.06 });
    expect(high).toStrictEqual({ minNm: 1, maxNm: 5, accuracyFraction: 0.06 });
    const marked = (id: string, terminal: string) =>
      BUILTIN_CATALOG.device({ id, version: 1 })?.terminals.find((t) => t.id === terminal)?.methods[0]?.torqueNm ?? NaN;
    const inside = (nm: number, r: typeof high) => r !== null && nm >= r.minNm && nm <= r.maxNm;
    // The breaker's 4 N·m lies in the 1-5 N·m driver's range; the DIN supply's 0.5 N·m in the 0.3-1.2 one's.
    expect(inside(marked('breaker.saltmere-1p-15a', 'load'), high)).toBe(true);
    expect(inside(marked('supply.railwick-din-24v-5a', 'pos'), low)).toBe(true);
    expect(inside(marked('supply.railwick-din-24v-5a', 'pos'), high)).toBe(false);
    // Every marked torque in the catalogue is reachable by one of them.
    const torques = BUILTIN_CATALOG.devices.flatMap((dev) =>
      dev.terminals.flatMap((t) => t.methods.flatMap((m) => (m.torqueNm === null ? [] : [m.torqueNm]))),
    );
    for (const nm of torques) expect(inside(nm, low) || inside(nm, high)).toBe(true);
  });

  it('cap the diagonal cutters at 8 AWG solid copper (3.26 mm); 6 AWG (4.11 mm) is beyond them', () => {
    expect(d(8)).toBeCloseTo(3.264, 3);
    expect(d(6)).toBeCloseTo(4.115, 3);
    expect(AWG_GAUGES.find((g) => g.awg === 8)?.diameterMm).toBeCloseTo(d(8), 4);
    expect(tool('tool.veltmark-dc-8').capabilities).toStrictEqual([{ step: 'cut', maxAwg: 8 }]);
  });

  it('give every driver its drive types, and every screw in the catalogue a driver that fits it', () => {
    expect(
      BUILTIN_CATALOG.tools.filter((t) => t.drives.length > 0).map((t) => [t.id, t.drives.join('+')]),
    ).toStrictEqual([
      ['tool.calderyn-ts-03', 'slotted+phillips+pozidriv+square'],
      ['tool.calderyn-ts-15', 'slotted+phillips+pozidriv+square'],
      ['tool.veltmark-nd-516', 'hex'],
      ['tool.veltmark-sd-2', 'slotted+phillips'],
    ]);
    for (const t of BUILTIN_CATALOG.tools) {
      for (const drive of t.drives) expect(Object.keys(DRIVE_TYPES)).toContain(drive);
    }
    const screws = BUILTIN_CATALOG.devices.flatMap((dev) =>
      dev.terminals.flatMap((t) => t.methods.filter((m) => m.torqueNm !== null).map((m) => m.drives)),
    );
    expect(screws.length).toBeGreaterThan(0);
    const plain = tool('tool.veltmark-sd-2');
    const nut = tool('tool.veltmark-nd-516');
    for (const drives of screws) {
      expect(drivesFit(plain.drives, drives)).toBe(true);
      expect(drivesFit(nut.drives, drives)).toBe(false); // a nut driver never turns a terminal screw
    }
    // Entries opened by driving need a blade: the screwdriver can, the nut driver can't.
    for (const type of Object.values(ENTRY_TYPES).filter((e) => e.opens.includes('drive'))) {
      expect(type.drives).toStrictEqual(['slotted']);
      expect(drivesFit(plain.drives, type.drives)).toBe(true);
      expect(drivesFit(nut.drives, type.drives)).toBe(false);
    }
  });
});
