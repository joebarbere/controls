import { BUILTIN_CATALOG } from './builtin';
import type { ToolDefinition } from './families';
import { AWG_GAUGES } from './gauge';
import {
  DRIVE_TYPES,
  drivesFit,
  ENTRY_TYPES,
  HOLE_FIT_TOLERANCE_MM,
  holeFitsTradeSize,
  KNOCKOUT_HOLES,
  knockoutHoleMm,
  type TradeSize,
} from './registries';

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
  it('are the nine P3 part 1 tools and the ten part 2 tools at version 1, in the tool family', () => {
    expect(BUILTIN_CATALOG.tools.map((t) => [t.id, t.version, t.kind])).toStrictEqual([
      ['tool.calderyn-ts-03', 1, 'torqueDriver'],
      ['tool.calderyn-ts-15', 1, 'torqueDriver'],
      ['tool.corriden-hs-14', 1, 'holeSaw'],
      ['tool.corriden-hs-18', 1, 'holeSaw'],
      ['tool.corriden-hs-22', 1, 'holeSaw'],
      ['tool.corriden-hs-28', 1, 'holeSaw'],
      ['tool.corriden-sa-12', 1, 'drill'],
      ['tool.corriden-sa-14', 1, 'drill'],
      ['tool.corriden-sa-16', 1, 'drill'],
      ['tool.corriden-sa-18', 1, 'drill'],
      ['tool.penmarrow-lp-12', 1, 'labelMaker'],
      ['tool.veltmark-cr-2210', 1, 'crimper'],
      ['tool.veltmark-dc-8', 1, 'cutter'],
      ['tool.veltmark-fr-1524', 1, 'fishTape'],
      ['tool.veltmark-kp-3', 1, 'knockoutPunch'],
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
      'Corriden',
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

/*
 * F3.4 part 2: wood-boring bits, hole saws, the knockout punch set and the fish tape. Hand calculations:
 *
 * - a nominal size in inches is exactly × 25.4 mm (NIST SP 811): 3/4 → 19.05, 7/8 → 22.225, 1 → 25.4,
 *   1-1/8 → 28.575, 1-3/8 → 34.925, 1-3/4 → 44.45;
 * - the bored-hole limit (IRC R602.6 by number) is 40 % of the 88.9 mm stud depth = 35.56 mm;
 * - a bore is centred at mid-depth 88.9 / 2 = 44.45 mm, so a bit of diameter D leaves 44.45 − D / 2 to the
 *   face; a nail plate is needed under 31.75 mm (NFPA 70 Art. 300.4(A)(1) by number), i.e. for D > 25.4;
 * - a knockout hole is its published inches × 25.4: 0.885 → 22.479, 1.115 → 28.321, 1.362 → 34.5948,
 *   1.701 → 43.2054 mm; a hole saw fits a trade size within 1/16 in = 1.5875 mm (game-design);
 * - 50 ft = 50 × 12 × 25.4 = 15 240 mm.
 */
describe('the F3.4 part 2 tools: bits, hole saws, punch and fish tape', () => {
  const bore = (id: string) => tool(id).boreDiameterMm ?? NaN;
  const STUD_DEPTH_MM = 88.9;
  const BORED_HOLE_MAX_MM = 0.4 * STUD_DEPTH_MM; // 35.56
  const edgeMm = (diameterMm: number) => STUD_DEPTH_MM / 2 - diameterMm / 2;

  it('bore their nominal inch sizes, converted exactly', () => {
    const sizes: [string, number][] = [
      ['tool.corriden-sa-12', 0.75],
      ['tool.corriden-sa-14', 0.875],
      ['tool.corriden-sa-16', 1],
      ['tool.corriden-sa-18', 1.125],
      ['tool.corriden-hs-14', 0.875],
      ['tool.corriden-hs-18', 1.125],
      ['tool.corriden-hs-22', 1.375],
      ['tool.corriden-hs-28', 1.75],
    ];
    for (const [id, inches] of sizes) expect(bore(id)).toBeCloseTo(inches * 25.4, 9);
    expect([19.05, 22.225, 25.4, 28.575].map((mm, i) => bore(sizes[i][0]) - mm)).toStrictEqual([0, 0, 0, 0]);
  });

  it('split at the stud limits: 3/4, 7/8 and 1 in bits (at most 25.4 mm) need no nail plate; 1-1/8 in does; 1-3/4 in is over the bored-hole limit', () => {
    expect(BORED_HOLE_MAX_MM).toBeCloseTo(35.56, 9);
    // The nail-plate threshold: 44.45 − D / 2 ≥ 31.75 ⇔ D ≤ 25.4 mm.
    expect(STUD_DEPTH_MM / 2 - 31.75).toBeCloseTo(25.4 / 2, 9);
    for (const id of ['tool.corriden-sa-12', 'tool.corriden-sa-14', 'tool.corriden-sa-16']) {
      expect(bore(id)).toBeLessThanOrEqual(25.4);
    }
    expect(bore('tool.corriden-sa-18')).toBeGreaterThan(25.4);
    // 3/4 in leaves 44.45 − 9.525 = 34.925 mm; 7/8 in 33.3375; 1 in exactly 31.75; 1-1/8 in 30.1625.
    expect(edgeMm(bore('tool.corriden-sa-12'))).toBeCloseTo(34.925, 9);
    expect(edgeMm(bore('tool.corriden-sa-14'))).toBeCloseTo(33.3375, 9);
    expect(edgeMm(bore('tool.corriden-sa-16'))).toBeCloseTo(31.75, 9);
    expect(edgeMm(bore('tool.corriden-sa-18'))).toBeCloseTo(30.1625, 9);
    expect(bore('tool.corriden-hs-22')).toBeLessThanOrEqual(BORED_HOLE_MAX_MM); // 34.925 ≤ 35.56
    expect(bore('tool.corriden-hs-28')).toBeGreaterThan(BORED_HOLE_MAX_MM); // 44.45 > 35.56
  });

  it('give bits bore only; hole saws bore and open entries; the punch opens entries; the tape pulls', () => {
    for (const id of ['tool.corriden-sa-12', 'tool.corriden-sa-14', 'tool.corriden-sa-16', 'tool.corriden-sa-18']) {
      expect(caps(tool(id))).toStrictEqual(['bore:any']);
    }
    for (const id of ['tool.corriden-hs-14', 'tool.corriden-hs-18', 'tool.corriden-hs-22', 'tool.corriden-hs-28']) {
      expect(caps(tool(id))).toStrictEqual(['bore:any', 'openEntry:any']);
    }
    expect(caps(tool('tool.veltmark-kp-3'))).toStrictEqual(['openEntry:any']);
    expect(tool('tool.veltmark-kp-3').punches).toStrictEqual(['1/2', '3/4', '1']);
    expect(caps(tool('tool.veltmark-fr-1524'))).toStrictEqual(['pull:any']);
    // A drill site opens only by openEntry: a wood bit can't cut a steel box wall.
    expect(ENTRY_TYPES['drillSite'].opens).toStrictEqual(['openEntry']);
  });

  it('take the knockout holes from the punch class, and fit each hole saw to exactly one trade size', () => {
    expect(knockoutHoleMm('1/2')).toBeCloseTo(22.479, 9);
    expect(knockoutHoleMm('3/4')).toBeCloseTo(28.321, 9);
    expect(knockoutHoleMm('1')).toBeCloseTo(34.5948, 9);
    expect(knockoutHoleMm('1-1/4')).toBeCloseTo(43.2054, 9);
    expect(HOLE_FIT_TOLERANCE_MM).toBe(25.4 / 16);
    const sizes = Object.keys(KNOCKOUT_HOLES) as TradeSize[];
    const fits = (id: string) => sizes.filter((size) => holeFitsTradeSize(bore(id), size));
    // 22.225 − 22.479 = −0.254; 28.575 − 28.321 = 0.254; 34.925 − 34.5948 = 0.3302; 44.45 − 43.2054 = 1.2446.
    expect(fits('tool.corriden-hs-14')).toStrictEqual(['1/2']);
    expect(fits('tool.corriden-hs-18')).toStrictEqual(['3/4']);
    expect(fits('tool.corriden-hs-22')).toStrictEqual(['1']);
    expect(fits('tool.corriden-hs-28')).toStrictEqual(['1-1/4']);
    // The tolerance's edge is inclusive and exact: K ± 1.5875 mm fits, K ± 1.5885 mm doesn't.
    for (const size of sizes) {
      const k = knockoutHoleMm(size);
      expect(holeFitsTradeSize(k + HOLE_FIT_TOLERANCE_MM, size)).toBe(true);
      expect(holeFitsTradeSize(k - HOLE_FIT_TOLERANCE_MM, size)).toBe(true);
      expect(holeFitsTradeSize(k + HOLE_FIT_TOLERANCE_MM + 0.001, size)).toBe(false);
      expect(holeFitsTradeSize(k - HOLE_FIT_TOLERANCE_MM - 0.001, size)).toBe(false);
    }
    // Wood bits are never close enough to open anything (and can't openEntry anyway): 3/4 in is 3.4 mm under 1/2.
    expect(fits('tool.corriden-sa-12')).toStrictEqual([]);
    // Every entry in the catalogue with a trade size can be opened by a punch or a hole saw.
    const openers = BUILTIN_CATALOG.tools.filter((t) => t.capabilities.some((c) => c.step === 'openEntry'));
    const entries = BUILTIN_CATALOG.devices.flatMap((dev) => dev.enclosure?.entries ?? []);
    for (const entry of entries.filter((e) => e.tradeSize !== null)) {
      const size = entry.tradeSize as TradeSize;
      expect(
        openers.some(
          (t) => t.punches.includes(size) || (t.boreDiameterMm !== null && holeFitsTradeSize(t.boreDiameterMm, size)),
        ),
      ).toBe(true);
    }
  });

  it('give the fish tape 50 ft (15 240 mm) and four quarter bends', () => {
    expect(50 * 12 * 25.4).toBeCloseTo(15240, 9);
    expect(tool('tool.veltmark-fr-1524').pull).toStrictEqual({ lengthMm: 15240, maxBendDeg: 360 });
    for (const t of BUILTIN_CATALOG.tools) {
      expect(t.pull !== null).toBe(t.capabilities.some((c) => c.step === 'pull'));
    }
  });
});
