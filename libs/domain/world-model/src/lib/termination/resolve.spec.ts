import fc from 'fast-check';
import { WIRING_TEST_CATALOG } from '../../testing';
import {
  autoTermination,
  crimpBase,
  nickBase,
  nickCap,
  resolveTermination,
  SCREWDRIVER_TORQUE_MEAN_FRACTION,
  SCREWDRIVER_TORQUE_SPREAD,
  type TerminationArgs,
  type TerminationTools,
  terminationStepKey,
  terminationStreams,
} from './resolve';

/*
 * resolveTermination (ADR 0015): pure, each step from its own stream, keyed by the termination id.
 * The golden vectors (arguments, seed, termination id → outcome, bit-exact) freeze it at v0.4.0. They
 * were re-pinned by F3.3 part 1 (ADR 0018), which decided the game-design numbers: the geometric nick
 * cap, the under-crimp at 0.25 and 0.3 per AWG step, and the plain screwdriver biased low.
 */

const catalog = WIRING_TEST_CATALOG;
const tool = (id: string) => {
  const found = catalog.tool({ id, version: 1 });
  if (!found) throw new Error(id);
  return found;
};
const stripper = tool('tool.test-stripper');
const torque = tool('tool.test-torque');
const screwdriver = tool('tool.test-screwdriver');
const crimper = tool('tool.test-crimper');
const ferrule = catalog.accessory({ id: 'ferrule.test-14', version: 1 });
const breaker = catalog.device({ id: 'breaker.saltmere-1p-15a', version: 1 });
const screw = breaker?.terminals.find((t) => t.id === 'line')?.methods[0];
if (!screw || !ferrule) throw new Error('test catalogue');

const solid14 = { awg: 14, stranding: 'solid' } as const;
const stranded14 = { awg: 14, stranding: 'stranded' } as const;
const ref = (t: { id: string; version: number }) => ({ id: t.id, version: t.version });

function args(
  hole: string,
  clamp: TerminationArgs['clamp'],
  accessory: TerminationArgs['accessory'] = null,
): TerminationArgs {
  return { method: 'screw', strip: { tool: ref(stripper), hole, lengthMm: 12 }, accessory, clamp };
}
function tools(hole: string, clamp = torque, die: string | null = null, accessory = ferrule): TerminationTools {
  const h = stripper.holes.find((x) => x.id === hole);
  const d = crimper.dies.find((x) => x.id === die);
  if (!h || !accessory) throw new Error(hole);
  return {
    strip: { tool: stripper, hole: h },
    accessory: d ? { accessory, tool: crimper, die: d } : null,
    clamp,
  };
}

describe('resolveTermination', () => {
  it("'auto' is the ideal outcome: the first method at nominal strip and torque, no nicks, no accessory", () => {
    expect(resolveTermination(5, 'auto', screw, solid14, null, terminationStreams(1, 5))).toStrictEqual({
      id: 5,
      method: 'screw',
      auto: true,
      stripLengthMm: 13,
      nickedStrandFraction: 0,
      torqueNm: 4,
      accessory: null,
    });
    expect(autoTermination(5, screw)).toStrictEqual(
      resolveTermination(5, 'auto', screw, solid14, null, terminationStreams(9, 9)),
    );
  });

  it('golden vectors (seed, termination id → outcome), bit-exact', () => {
    /*
     * Hand calculation (the draws u are each stream's first `nextFloat`; areas from AWG_GAUGES):
     *
     * 1. h14s on 14 solid, torque driver at 4 N·m (±6 %): no nick; 4 · (1 + 0.06 (2u − 1)), u = 0.4524.
     * 2. h16st on 14 solid, driver at 0.8: model 2 × 0.15 + 0.05 = 0.35; the cap is the area outside a
     *    16 AWG stranded hole, 1 − (1.3087 × 9/7) / 2.08091 = 0.191405, so the base is 0.191405 and the
     *    spread (× 1.133) is capped back to it: 0.191405 (the old ±25 % spread on 0.35 gave 0.396).
     * 3. h14s, plain screwdriver: 4 · (0.8 + 0.5 (2u − 1)) with 2u − 1 = −0.16582: 2.8684 N·m (r 0.717).
     * 4. h14st + ferrule on 14 stranded, die sq-10 (not the ferrule's, 2 AWG steps outside 12–10):
     *    max(0, 0.25 − 2 × 0.3) = 0, an open crimp; driver at 4 N·m.
     * 5. spring cage, ferrule on its own die: crimp 1, no torque.
     * 6. h16st + plain screwdriver: nick 0.191405 × (1 − 0.25 + 0.5u) = 0.14435 (u = 0.0083); torque
     *    4 · (0.8 + 0.5 · (−0.68278)) = 1.8344 N·m (r 0.459, just seated).
     * 7. h14s + plain screwdriver, seed 7, id 4: 2u − 1 = −0.88684, 4 · (0.8 − 0.44342) = 1.4263 N·m,
     *    r = 0.3566 < 0.4: a hand-tightened landing in ADR 0018's loose regime (1.65 mΩ, 5.5 × R₀).
     */
    const cases = [
      resolveTermination(
        1,
        args('h14s', { tool: ref(torque), torqueNm: 4 }),
        screw,
        solid14,
        tools('h14s'),
        terminationStreams(7, 1),
      ),
      resolveTermination(
        2,
        args('h16st', { tool: ref(torque), torqueNm: 0.8 }),
        screw,
        solid14,
        tools('h16st'),
        terminationStreams(7, 2),
      ),
      resolveTermination(
        3,
        args('h14s', { tool: ref(screwdriver), torqueNm: null }),
        screw,
        solid14,
        tools('h14s', screwdriver),
        terminationStreams(7, 3),
      ),
      resolveTermination(
        4,
        args('h14st', { tool: ref(torque), torqueNm: 4 }, { ref: ref(ferrule), tool: ref(crimper), die: 'sq-10' }),
        screw,
        stranded14,
        tools('h14st', torque, 'sq-10'),
        terminationStreams(0xffffffff, 4),
      ),
    ];
    const springTerminal = catalog.device({ id: 'tb.test-2', version: 1 })?.terminals.find((t) => t.id === '1');
    const spring = springTerminal?.methods[0];
    if (!spring) throw new Error('spring cage');
    cases.push(
      // A spring cage (no clamp torque, clamp both null) with a ferrule on the right die.
      resolveTermination(
        5,
        {
          method: 'springCage',
          strip: { tool: ref(stripper), hole: 'h14st', lengthMm: 10 },
          accessory: { ref: ref(ferrule), tool: ref(crimper), die: 'sq-14' },
          clamp: { tool: null, torqueNm: null },
        },
        spring,
        stranded14,
        { ...tools('h14st', torque, 'sq-14'), clamp: null },
        terminationStreams(7, 5),
      ),
      // A plain screwdriver after a hole that nicks: both the strip and the clamp step draw.
      resolveTermination(
        6,
        args('h16st', { tool: ref(screwdriver), torqueNm: null }),
        screw,
        solid14,
        tools('h16st', screwdriver),
        terminationStreams(7, 6),
      ),
      // A plain screwdriver that lands below the seat fraction.
      resolveTermination(
        4,
        args('h14s', { tool: ref(screwdriver), torqueNm: null }),
        screw,
        solid14,
        tools('h14s', screwdriver),
        terminationStreams(7, 4),
      ),
    );
    const outcome = (
      id: number,
      nickedStrandFraction: number,
      torqueNm: number | null,
      accessory: object | null = null,
    ) => ({
      id,
      method: 'screw',
      auto: false,
      stripLengthMm: 12,
      nickedStrandFraction,
      torqueNm,
      accessory,
    });
    expect(cases.slice(0, 4)).toStrictEqual([
      outcome(1, 0, 3.977147615849972),
      outcome(2, 0.19140458467003085, 0.7955975450575352),
      outcome(3, 0, 2.8684175543487074),
      outcome(4, 0, 3.821195868700743, { ref: { id: 'ferrule.test-14', version: 1 }, crimpQuality: 0 }),
    ]);
    expect(cases.slice(4)).toStrictEqual([
      {
        id: 5,
        method: 'springCage',
        auto: false,
        stripLengthMm: 10,
        nickedStrandFraction: 0,
        torqueNm: null,
        accessory: { ref: { id: 'ferrule.test-14', version: 1 }, crimpQuality: 1 },
      },
      outcome(6, 0.14435278128524395, 1.8344474349170925),
      outcome(4, 0, 1.4263191789388658),
    ]);
    expect((cases[6].torqueNm as number) / 4).toBeLessThan(0.4);
  });

  it('stays in range at the streams’ extremes (injected draws of 0 and 1 − 2⁻³²)', () => {
    const fixed = (u: number) => {
      const stream = { nextFloat: () => u } as unknown as ReturnType<ReturnType<typeof terminationStreams>['strip']>;
      return { strip: () => stream, crimp: () => stream, clamp: () => stream };
    };
    const lowest = 0;
    const highest = 1 - 2 ** -32;
    const plain = (u: number) =>
      resolveTermination(
        9,
        args('h16s', { tool: ref(screwdriver), torqueNm: null }),
        screw,
        solid14,
        { ...tools('h14s', screwdriver), strip: { tool: stripper, hole: { id: 'h16s', awg: 16, stranding: 'solid' } } },
        fixed(u),
      );
    // An accessory whose list lacks the (in-range) die: an under-crimp at 0.25, with its spread.
    const unlisted = { ...ferrule, dies: [] };
    const driver = (u: number) =>
      resolveTermination(
        9,
        args('h14st', { tool: ref(torque), torqueNm: 6 }, { ref: ref(ferrule), tool: ref(crimper), die: 'sq-14' }),
        screw,
        stranded14,
        tools('h14st', torque, 'sq-14', unlisted),
        fixed(u),
      );
    // A 16 AWG solid hole on 14 AWG solid: base min(0.3, cap 0.371) = 0.3, spread [0.75, 1.25).
    const low = plain(lowest);
    expect(low.nickedStrandFraction).toBeCloseTo(0.3 * 0.75, 12);
    expect(low.torqueNm).toBeCloseTo(4 * 0.3, 12);
    expect(plain(highest).torqueNm).toBeLessThan(4 * 1.3);
    // The top of the spread (0.375) is capped at the hole's geometric reach.
    expect(plain(highest).nickedStrandFraction).toBe(nickCap({ id: 'h', awg: 16, stranding: 'solid' }, solid14));
    const bottom = driver(lowest);
    expect(bottom.torqueNm).toBeCloseTo(6 * 0.94, 12);
    expect(bottom.accessory?.crimpQuality).toBeCloseTo(0.25, 12);
    const top = driver(highest);
    expect(top.torqueNm).toBeLessThan(6 * 1.06);
    expect(top.accessory?.crimpQuality).toBeGreaterThan(0.25 * 0.9); // (1 − s, 1]
  });

  it('draws each step from its own stream, keyed termination:<id>:<step>', () => {
    expect(terminationStepKey(12, 'strip')).toBe('termination:12:strip');
    expect(terminationStepKey(12, 'crimp')).toBe('termination:12:crimp');
    expect(terminationStepKey(12, 'clamp')).toBe('termination:12:clamp');
    // The clamp outcome doesn't depend on whether the strip step drew (a nick) or not.
    const a = resolveTermination(
      3,
      args('h14s', { tool: ref(screwdriver), torqueNm: null }),
      screw,
      solid14,
      tools('h14s', screwdriver),
      terminationStreams(7, 3),
    );
    const b = resolveTermination(
      3,
      args('h16st', { tool: ref(screwdriver), torqueNm: null }),
      screw,
      solid14,
      tools('h16st', screwdriver),
      terminationStreams(7, 3),
    );
    expect(a.nickedStrandFraction).toBe(0);
    expect(b.nickedStrandFraction).toBeGreaterThan(0);
    expect(b.torqueNm).toBe(a.torqueNm);
  });

  it('properties: pure; outcomes in range; nicks never past the hole’s reach; a torque driver within its accuracy', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.constantFrom('h10s', 'h12s', 'h14s', 'h14st', 'h16st'),
        fc.constantFrom(solid14, stranded14),
        fc.double({ min: 0.5, max: 6, noNaN: true }),
        fc.boolean(),
        (seed, id, hole, conductor, setting, plain) => {
          const clamp = plain ? { tool: ref(screwdriver), torqueNm: null } : { tool: ref(torque), torqueNm: setting };
          const t = tools(hole, plain ? screwdriver : torque);
          const run = () =>
            resolveTermination(id, args(hole, clamp), screw, conductor, t, terminationStreams(seed, id));
          const outcome = run();
          expect(run()).toStrictEqual(outcome);
          expect(outcome.nickedStrandFraction).toBeGreaterThanOrEqual(0);
          expect(outcome.nickedStrandFraction).toBeLessThanOrEqual(nickCap(t.strip.hole, conductor));
          if (hole === 'h12s' || hole === 'h10s') expect(outcome.nickedStrandFraction).toBe(0);
          // The stranded 14 hole is wider than a solid 14 conductor: it nicks nothing.
          if (conductor === solid14 && (hole === 'h14s' || hole === 'h14st')) {
            expect(outcome.nickedStrandFraction).toBe(0);
          }
          const torqueNm = outcome.torqueNm as number;
          if (plain) {
            expect(torqueNm).toBeGreaterThanOrEqual(4 * (SCREWDRIVER_TORQUE_MEAN_FRACTION - SCREWDRIVER_TORQUE_SPREAD));
            expect(torqueNm).toBeLessThan(4 * (SCREWDRIVER_TORQUE_MEAN_FRACTION + SCREWDRIVER_TORQUE_SPREAD));
          } else {
            expect(Math.abs(torqueNm - setting)).toBeLessThanOrEqual(setting * 0.06 + 1e-12);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('a plain screwdriver is biased low: about 1 in 10 below the seat fraction, about 7 in 10 below the mark', () => {
    let loose = 0;
    let under = 0;
    const n = 2000;
    for (let id = 1; id <= n; id++) {
      const outcome = resolveTermination(
        id,
        args('h14s', { tool: ref(screwdriver), torqueNm: null }),
        screw,
        solid14,
        tools('h14s', screwdriver),
        terminationStreams(11, id),
      );
      const r = (outcome.torqueNm as number) / 4;
      if (r < 0.4) loose++;
      if (r < 1) under++;
    }
    expect(loose / n).toBeGreaterThan(0.07);
    expect(loose / n).toBeLessThan(0.13);
    expect(under / n).toBeGreaterThan(0.66);
    expect(under / n).toBeLessThan(0.74);
  });

  it('nicks: per gauge step, never past the geometric cap 1 − (d_hole/d_cond)² (stranded 3/√7 wider)', () => {
    const hole = (awg: number, stranding: 'solid' | 'stranded') => ({ id: 'h', awg, stranding });
    expect(nickBase(hole(14, 'solid'), solid14)).toBe(0);
    expect(nickBase(hole(12, 'solid'), solid14)).toBe(0);
    // 16 solid on 14 solid: the model's 0.3 is under the reach 1 − 1.3087/2.08091 = 0.37109.
    expect(nickCap(hole(16, 'solid'), solid14)).toBeCloseTo(0.3710924547, 9);
    expect(nickBase(hole(16, 'solid'), solid14)).toBeCloseTo(0.3, 12);
    // The 14 stranded hole on 14 solid (physically the 12 solid hole) is wider: nothing (was 0.05).
    expect(nickCap(hole(14, 'stranded'), solid14)).toBe(0);
    expect(nickBase(hole(14, 'stranded'), solid14)).toBe(0);
    // The 14 solid hole on 14 stranded reaches 1 − 7/9 = 0.2222; the mismatch model's 0.05 is under it.
    expect(nickCap(hole(14, 'solid'), stranded14)).toBeCloseTo(2 / 9, 12);
    expect(nickBase(hole(14, 'solid'), stranded14)).toBeCloseTo(0.05, 12);
    // 16 stranded on 14 solid: the model's 0.35 is capped at 1 − (1.3087 × 9/7)/2.08091 = 0.191405.
    expect(nickBase(hole(16, 'stranded'), solid14)).toBe(0.19140458467003085);
    // A far-too-small hole is capped at its reach, below 1.
    expect(nickBase(hole(40, 'solid'), solid14)).toBeCloseTo(1 - 0.00501036 / 2.08091, 12);
  });

  it('crimps: the right die closes fully; an unlisted die under-crimps at 0.25; 0.3 per AWG step outside the die', () => {
    const die = (id: string, smallest: number, largest: number) => ({ id, label: id, awgRange: { smallest, largest } });
    expect(crimpBase(ferrule, die('sq-14', 16, 14), stranded14)).toBe(1);
    expect(crimpBase({ ...ferrule, dies: [] }, die('sq-14', 16, 14), stranded14)).toBe(0.25);
    expect(crimpBase(ferrule, die('sq-14', 16, 15), stranded14)).toBeCloseTo(0.7, 12);
    expect(crimpBase(ferrule, die('sq-14', 16, 16), stranded14)).toBeCloseTo(0.4, 12);
    expect(crimpBase(ferrule, die('sq-10', 12, 10), stranded14)).toBe(0);
  });
});
