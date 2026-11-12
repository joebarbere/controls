import fc from 'fast-check';
import { WIRING_TEST_CATALOG } from '../../testing';
import {
  autoTermination,
  crimpBase,
  nickBase,
  resolveTermination,
  SCREWDRIVER_TORQUE_SPREAD,
  type TerminationArgs,
  type TerminationTools,
  terminationStepKey,
  terminationStreams,
} from './resolve';

/*
 * resolveTermination (ADR 0015): pure, each step from its own stream, keyed by the termination id.
 * The golden vectors (arguments, seed, termination id → outcome, bit-exact) freeze it at v0.4.0; the
 * game-design numbers are provisional until F3.3 part 1 (ADR 0018), which re-pins them in its PR.
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
function tools(hole: string, clamp = torque, die: string | null = null): TerminationTools {
  const h = stripper.holes.find((x) => x.id === hole);
  const d = crimper.dies.find((x) => x.id === die);
  if (!h) throw new Error(hole);
  return {
    strip: { tool: stripper, hole: h },
    accessory: d && ferrule ? { accessory: ferrule, tool: crimper, die: d } : null,
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
      outcome(2, 0.39648767961189146, 0.7955975450575352),
      outcome(3, 0, 3.7347340434789658),
      outcome(4, 0, 3.821195868700743, {
        ref: { id: 'ferrule.test-14', version: 1 },
        crimpQuality: 0.09572002535918725,
      }),
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
      outcome(6, 0.26396166809136046, 2.9075579479336735),
    ]);
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
        args('h16st', { tool: ref(screwdriver), torqueNm: null }),
        screw,
        solid14,
        tools('h16st', screwdriver),
        fixed(u),
      );
    const driver = (u: number) =>
      resolveTermination(
        9,
        args('h14st', { tool: ref(torque), torqueNm: 6 }, { ref: ref(ferrule), tool: ref(crimper), die: 'sq-10' }),
        screw,
        stranded14,
        tools('h14st', torque, 'sq-10'),
        fixed(u),
      );
    const low = plain(lowest);
    expect(low.nickedStrandFraction).toBeCloseTo(0.35 * 0.75, 12); // a 16 AWG stranded hole on 14 AWG solid
    expect(low.torqueNm).toBeCloseTo(4 * 0.6, 12);
    expect(plain(highest).torqueNm).toBeLessThan(4 * 1.4);
    expect(plain(highest).nickedStrandFraction).toBeLessThan(0.35 * 1.25);
    const bottom = driver(lowest);
    expect(bottom.torqueNm).toBeCloseTo(6 * 0.94, 12);
    expect(bottom.accessory?.crimpQuality).toBeCloseTo(0.1, 12);
    const top = driver(highest);
    expect(top.torqueNm).toBeLessThan(6 * 1.06);
    expect(top.accessory?.crimpQuality).toBeGreaterThan(0.1 * 0.9); // (1 − s, 1]
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

  it('properties: pure; outcomes in range; the right hole nicks nothing; a torque driver within its accuracy', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.constantFrom('h10s', 'h12s', 'h14s', 'h14st', 'h16st'),
        fc.double({ min: 0.5, max: 6, noNaN: true }),
        fc.boolean(),
        (seed, id, hole, setting, plain) => {
          const clamp = plain ? { tool: ref(screwdriver), torqueNm: null } : { tool: ref(torque), torqueNm: setting };
          const run = () =>
            resolveTermination(
              id,
              args(hole, clamp),
              screw,
              solid14,
              tools(hole, plain ? screwdriver : torque),
              terminationStreams(seed, id),
            );
          const outcome = run();
          expect(run()).toStrictEqual(outcome);
          expect(outcome.nickedStrandFraction).toBeGreaterThanOrEqual(0);
          expect(outcome.nickedStrandFraction).toBeLessThanOrEqual(1);
          if (hole === 'h14s' || hole === 'h12s' || hole === 'h10s') expect(outcome.nickedStrandFraction).toBe(0);
          const t = outcome.torqueNm as number;
          if (plain) {
            expect(t).toBeGreaterThanOrEqual(4 * (1 - SCREWDRIVER_TORQUE_SPREAD));
            expect(t).toBeLessThan(4 * (1 + SCREWDRIVER_TORQUE_SPREAD));
          } else {
            expect(Math.abs(t - setting)).toBeLessThanOrEqual(setting * 0.06 + 1e-12);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('nicks grow with each gauge step a hole is too small; the right die crimps fully', () => {
    const hole = (awg: number, stranding: 'solid' | 'stranded') => ({ id: 'h', awg, stranding });
    expect(nickBase(hole(14, 'solid'), solid14)).toBe(0);
    expect(nickBase(hole(12, 'solid'), solid14)).toBe(0);
    expect(nickBase(hole(16, 'solid'), solid14)).toBeCloseTo(0.3, 12);
    expect(nickBase(hole(14, 'stranded'), solid14)).toBeCloseTo(0.05, 12);
    expect(nickBase(hole(40, 'solid'), solid14)).toBe(1);
    const die = (id: string, smallest: number, largest: number) => ({ id, label: id, awgRange: { smallest, largest } });
    expect(crimpBase(ferrule, die('sq-14', 16, 14), stranded14)).toBe(1);
    expect(crimpBase(ferrule, die('sq-10', 12, 10), stranded14)).toBeCloseTo(0.1, 12);
  });
});
