import { BUILTIN_CATALOG } from './builtin';
import type { ToolDefinition } from './families';
import { AWG_GAUGES } from './gauge';

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

describe('the built-in hand tools (F3.4 part 1)', () => {
  it('are the seven P3 part 1 tools, one per kind, at version 1, in the tool family', () => {
    expect(BUILTIN_CATALOG.tools.map((t) => [t.id, t.version, t.kind])).toStrictEqual([
      ['tool.calderyn-ts-15', 1, 'torqueDriver'],
      ['tool.penmarrow-lp-12', 1, 'labelMaker'],
      ['tool.veltmark-cr-2210', 1, 'crimper'],
      ['tool.veltmark-dc-8', 1, 'cutter'],
      ['tool.veltmark-nd-516', 1, 'nutDriver'],
      ['tool.veltmark-sd-2', 1, 'screwdriver'],
      ['tool.veltmark-ws-1018', 1, 'stripper'],
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

  it('declare capabilities, not kinds: the strippers can also cut and split an NM jacket', () => {
    expect(caps(tool('tool.veltmark-ws-1018'))).toStrictEqual(['strip:10', 'cut:10', 'stripJacket:12']);
    expect(caps(tool('tool.veltmark-dc-8'))).toStrictEqual(['cut:8']);
    expect(caps(tool('tool.veltmark-sd-2'))).toStrictEqual(['drive:any']);
    expect(caps(tool('tool.calderyn-ts-15'))).toStrictEqual(['drive:any', 'torque:any']);
    expect(caps(tool('tool.veltmark-cr-2210'))).toStrictEqual(['crimp:10']);
    expect(caps(tool('tool.veltmark-nd-516'))).toStrictEqual(['drive:any']);
    expect(caps(tool('tool.penmarrow-lp-12'))).toStrictEqual(['label:any']);
  });

  it('pin the stripper hole ids (save format): each physical hole is marked solid n and stranded n + 2', () => {
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
    // The strip capability reaches the largest hole.
    expect(Math.min(...holes.map((h) => h.awg))).toBe(10);
  });

  it('pin the crimper die ids (save format): the red, blue and yellow insulated-terminal code', () => {
    expect(tool('tool.veltmark-cr-2210').dies).toStrictEqual([
      { id: 'red', label: 'Red 22–18', awgRange: { smallest: 22, largest: 18 } },
      { id: 'blue', label: 'Blue 16–14', awgRange: { smallest: 16, largest: 14 } },
      { id: 'yellow', label: 'Yellow 12–10', awgRange: { smallest: 12, largest: 10 } },
    ]);
  });

  it('give the torque screwdriver a 1-5 N·m range at ±6 %, its minimum 20 % of its maximum', () => {
    const torque = tool('tool.calderyn-ts-15').torque;
    expect(torque).toStrictEqual({ minNm: 1, maxNm: 5, accuracyFraction: 0.06 });
    // 1 / 5 = 0.2: the low end of the verified band (20 % to 100 % of the maximum).
    expect((torque?.minNm ?? 0) / (torque?.maxNm ?? 1)).toBeCloseTo(0.2, 12);
    // It reaches the 4 N·m marked on the breaker's load screw; the 0.5 N·m DIN supply is below it.
    const marked = (id: string, terminal: string) =>
      BUILTIN_CATALOG.device({ id, version: 1 })?.terminals.find((t) => t.id === terminal)?.methods[0]?.torqueNm;
    expect(marked('breaker.saltmere-1p-15a', 'load')).toBe(4);
    expect(marked('supply.railwick-din-24v-5a', 'pos')).toBe(0.5);
  });

  it('cap the diagonal cutters at 8 AWG: 3.26 mm solid copper, inside the class’s 3-4 mm soft-wire capacity', () => {
    // d(8) = 0.127 mm × 92^((36 − 8)/39) = 0.127 × 92^0.71795 ≈ 0.127 × 25.70 ≈ 3.264 mm;
    // d(6) = 0.127 × 92^(30/39) ≈ 4.115 mm, past the top of the band, so 6 AWG isn't cut.
    const d = (n: number) => 0.127 * 92 ** ((36 - n) / 39);
    expect(d(8)).toBeCloseTo(3.264, 3);
    expect(d(6)).toBeCloseTo(4.115, 3);
    expect(AWG_GAUGES.find((g) => g.awg === 8)?.diameterMm).toBeCloseTo(d(8), 4);
    expect(tool('tool.veltmark-dc-8').capabilities).toStrictEqual([{ step: 'cut', maxAwg: 8 }]);
  });
});
