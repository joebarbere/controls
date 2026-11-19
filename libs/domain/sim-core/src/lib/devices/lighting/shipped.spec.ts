import { AC_SOURCE, end } from '../../../testing/bench';
import {
  A19_60W,
  acSourceAt,
  DIMMER,
  LAMPHOLDER,
  LED_A19,
  LED_FIXTURE,
  PULL_CHAIN,
  socket,
  SWITCH_3WAY,
  SWITCH_4WAY,
} from '../../../testing/lighting';
import { SourceHost } from '../../../testing/sources';
import type { NetlistBranch } from '../../netlist/types';
import { dimmerRmsFraction } from './dimmer';

/*
 * The shipped F4.1 part 1 entries (content/devices, `lighting-entries.spec.ts`) on the benches the
 * models' goldens use, beside the test-only entries the models were built on (`testing/lighting.ts`).
 * The shipped values the simulator reads are the test entries' (switches ideal; a keyless holder that
 * maps its socket onto its screws; the P3 120 V filament at 60 W; E26 contacts of 2 mΩ; the LED driver
 * at 9 W, PF 0.9, 90/95 V), so every reading matches to rounding. Two differ on purpose and are checked
 * against their own hand values: the 100 W bulb (40 ms; 144 Ω hot, 0.8333 A on 120 V) and the 15 W wall
 * light (16.667 VA).
 *
 * Hand values. 60 W on 120 V settles at about 0.5 A (240 Ω hot). A 3-way pair lights the lamp exactly
 * when the positions agree; a 4-way between them crosses that: lit exactly when (S1 = S2) XOR crossed.
 * The dimmer at 0.5 puts the curve's 0.707107 of the undimmed voltage on a resistive load.
 */

const SHIPPED = {
  three: { id: 'switch.castellby-3way-15a', version: 1 },
  four: { id: 'switch.castellby-4way-15a', version: 1 },
  one: { id: 'switch.castellby-1p-15a', version: 1 },
  dimmer: { id: 'dimmer.castellby-600w', version: 1 },
  keyless: { id: 'lampholder.castellby-keyless', version: 1 },
  pullChain: { id: 'lampholder.castellby-pull-chain', version: 1 },
  a19_60: { id: 'lamp.lumivane-a19-60w', version: 1 },
  a19_100: { id: 'lamp.lumivane-a19-100w', version: 1 },
  led: { id: 'light.lumivane-led-a19-9w', version: 1 },
  wall: { id: 'light.fennisby-led-wall-15w', version: 1 },
} as const;

type Ref = { readonly id: string; readonly version: number };
const rel = (a: number, b: number) => Math.abs(a / b - 1);
const DARK_A = 1e-9;

/**
 * A shipped holder placed clear of everything with `bulb` screwed in: the socket is 54, 54, 40 mm into
 * the holder and a bulb's anchor is −30, −30 (its 60 mm body centred on the socket's axis), so the bulb's
 * origin is 24, 24, 40 mm from the holder's.
 */
function shippedSocket(
  host: SourceHost,
  bulb: Ref,
  holderRef: Ref = SHIPPED.keyless,
): { holder: number; bulb: number } {
  const at = { x: 5000 + 200 * host.bus.state.nextEntityId, y: 0, z: 0 };
  host.exec('entity.place', { ref: holderRef, positionMm: at });
  const holder = host.bus.state.nextEntityId - 1;
  host.exec('entity.place', {
    ref: bulb,
    positionMm: { x: at.x + 24, y: at.y + 24, z: at.z + 40 },
    mountedOn: { entity: holder, mount: 'socket' },
  });
  return { holder, bulb: host.bus.state.nextEntityId - 1 };
}

const filamentAmps = (host: SourceHost, bulb: number) =>
  host.engine.branchAmps({ kind: 'entity', entity: bulb, part: 'filament' }) || 0;

/** The 3-way (and optional 4-way) bench of `switches.spec.ts`; returns the lamp current at the positions. */
function threeWay(
  refs: { three: Ref; four: Ref; holder: Ref; bulb: Ref },
  shipped: boolean,
  p1: 't1' | 't2',
  p4: 'straight' | 'crossed' | null,
  p2: 't1' | 't2',
): number {
  const host = new SourceHost();
  const source = host.place(AC_SOURCE);
  const s1 = host.place(refs.three);
  const four = p4 === null ? null : host.place(refs.four);
  const s2 = host.place(refs.three);
  const { holder, bulb } = shipped ? shippedSocket(host, refs.bulb, refs.holder) : socket(host, refs.bulb, refs.holder);
  host.lead(source, 'l', s1, 'common');
  if (four === null) {
    host.lead(s1, 't1', s2, 't1').lead(s1, 't2', s2, 't2');
  } else {
    host.lead(s1, 't1', four, 'a1').lead(s1, 't2', four, 'a2').lead(four, 'b1', s2, 't1').lead(four, 'b2', s2, 't2');
    host.operate(four, 'position', p4 as string);
  }
  host.lead(s2, 'common', holder, 'hot').lead(holder, 'neutral', source, 'n');
  host.operate(s1, 'position', p1).operate(s2, 'position', p2).advance(400);
  return filamentAmps(host, bulb);
}

/** S = V · conj(I) at an entity's terminals (W), summing its own branches. */
function watts(host: SourceHost, entity: number, a: string, b: string): number {
  const reading = host.engine.probe(end(entity, a), end(entity, b));
  if (reading.kind !== 'ac') throw new Error(`expected an AC reading, got ${reading.kind}`);
  const solution = host.engine.exportState().solution as { branches: number[] };
  let iRe = 0;
  let iIm = 0;
  for (const branch of host.engine.netlist.branches as NetlistBranch[]) {
    if (branch.element.kind !== 'entity' || branch.element.entity !== entity) continue;
    iRe += solution.branches[2 * branch.index];
    iIm += solution.branches[2 * branch.index + 1];
  }
  return reading.re * iRe + reading.im * iIm;
}

describe('the shipped lighting entries behave as the test-only ones (F4.1 part 1)', () => {
  const TEST_REFS = { three: SWITCH_3WAY, four: SWITCH_4WAY, holder: LAMPHOLDER, bulb: A19_60W };
  const SHIPPED_REFS = { three: SHIPPED.three, four: SHIPPED.four, holder: SHIPPED.keyless, bulb: SHIPPED.a19_60 };

  it('the 3-way and 4-way truth tables with the Castellby switches, holder and the Lumivane 60 W A19', () => {
    const rows: string[] = [];
    for (const p1 of ['t1', 't2'] as const) {
      for (const p4 of [null, 'straight', 'crossed'] as const) {
        for (const p2 of ['t1', 't2'] as const) {
          const shipped = threeWay(SHIPPED_REFS, true, p1, p4, p2);
          const test = threeWay(TEST_REFS, false, p1, p4, p2);
          const lit = (p1 === p2) !== (p4 === 'crossed');
          rows.push(`${p1} ${p4 ?? '-'} ${p2} ${shipped > 0.4 ? 'lit' : 'dark'}`);
          if (lit) {
            expect(rel(shipped, 0.5)).toBeLessThan(0.01);
            expect(rel(shipped, test)).toBeLessThan(1e-9);
          } else {
            expect(shipped).toBeLessThan(DARK_A);
          }
        }
      }
    }
    expect(rows.filter((r) => r.endsWith('lit'))).toStrictEqual([
      't1 - t1 lit',
      't1 straight t1 lit',
      't1 crossed t2 lit',
      't2 - t2 lit',
      't2 straight t2 lit',
      't2 crossed t1 lit',
    ]);
  });

  it('the single-pole switch and the pull-chain holder: open dark, closed as the keyless holder', () => {
    const host = new SourceHost();
    const source = host.place(AC_SOURCE);
    const sw = host.place(SHIPPED.one);
    const { holder, bulb } = shippedSocket(host, SHIPPED.a19_60, SHIPPED.pullChain);
    host.lead(source, 'l', sw, 'a').lead(sw, 'b', holder, 'hot').lead(holder, 'neutral', source, 'n');
    host.advance(400);
    expect(filamentAmps(host, bulb)).toBeLessThan(DARK_A);
    host.operate(sw, 'closed', true).advance(400);
    expect(filamentAmps(host, bulb)).toBeLessThan(DARK_A);
    host.operate(holder, 'closed', true).advance(400);
    expect(rel(filamentAmps(host, bulb), 0.5)).toBeLessThan(0.01);

    const test = new SourceHost();
    const s = test.place(AC_SOURCE);
    const tsw = test.place({ id: 'switch.test-wall1p', version: 1 });
    const t = socket(test, A19_60W, PULL_CHAIN);
    test.lead(s, 'l', tsw, 'a').lead(tsw, 'b', t.holder, 'hot').lead(t.holder, 'neutral', s, 'n');
    test.advance(400).operate(tsw, 'closed', true).advance(400).operate(t.holder, 'closed', true).advance(400);
    expect(rel(filamentAmps(host, bulb), filamentAmps(test, t.bulb))).toBeLessThan(1e-9);
  });

  it('the 100 W A19 settles at 0.8333 A (144 Ω hot) on 120 V', () => {
    const host = new SourceHost();
    const source = host.place(AC_SOURCE);
    const { holder, bulb } = shippedSocket(host, SHIPPED.a19_100);
    host.lead(source, 'l', holder, 'hot').lead(holder, 'neutral', source, 'n').advance(1000);
    // Hand: 100 / 120 = 0.83333 A at the lamp's rated voltage; the source's 0.1 Ω, two 41 mΩ leads and
    // two 2 mΩ contacts drop about 0.15 %, which the lamp's positive coefficient shares out.
    expect(rel(filamentAmps(host, bulb), 100 / 120)).toBeLessThan(0.01);
  });

  it('the dimmer at 0.25, 0.5 and 0.75 on a 60 W A19: as the test dimmer, to rounding', () => {
    for (const level of [0.25, 0.5, 0.75]) {
      const run = (dimmerRef: Ref, holderRef: Ref, bulbRef: Ref, shipped: boolean) => {
        const host = new SourceHost();
        const source = host.place(AC_SOURCE);
        const dimmer = host.place(dimmerRef);
        const { holder, bulb } = shipped ? shippedSocket(host, bulbRef, holderRef) : socket(host, bulbRef, holderRef);
        host.lead(source, 'l', dimmer, 'line').lead(dimmer, 'load', holder, 'hot');
        host.lead(holder, 'neutral', source, 'n');
        host.operate(dimmer, 'on', true).operate(dimmer, 'level', level).advance(1000);
        return filamentAmps(host, bulb);
      };
      const shipped = run(SHIPPED.dimmer, SHIPPED.keyless, SHIPPED.a19_60, true);
      const test = run(DIMMER, LAMPHOLDER, A19_60W, false);
      expect(shipped).toBeGreaterThan(0);
      // The fit's sawtooth is within 0.1 % of the reactance; both runs take the same steps.
      expect(rel(shipped, test)).toBeLessThan(1e-6);
    }
    expect(dimmerRmsFraction(0.5)).toBeCloseTo(0.707107, 6);
  });

  it('the LED A19: 9 W within 1 % from 108 to 127 V, nothing below its dropout; the wall light 15 W', () => {
    const led = (volts: 80 | 89 | 108 | 120 | 127, ref: Ref = SHIPPED.led) => {
      const host = new SourceHost();
      const s = host.place(volts === 120 ? AC_SOURCE : acSourceAt(volts));
      const { holder, bulb } = shippedSocket(host, ref);
      host.lead(s, 'l', holder, 'hot').lead(holder, 'neutral', s, 'n').advance(100);
      return { host, bulb };
    };
    for (const volts of [108, 120, 127] as const) {
      const { host, bulb } = led(volts);
      expect(rel(watts(host, bulb, 'a', 'b'), 9)).toBeLessThan(0.01);
      expect(host.sim(bulb)['running']).toBe(true);
    }
    for (const volts of [80, 89] as const) {
      const { host, bulb } = led(volts);
      expect(host.sim(bulb)['running']).toBe(false);
      expect(watts(host, bulb, 'a', 'b')).toBeLessThan(1e-3);
    }
    // The shipped and test bulbs on the same bench read alike.
    const test = new SourceHost();
    const s = test.place(AC_SOURCE);
    const t = socket(test, LED_A19);
    test.lead(s, 'l', t.holder, 'hot').lead(t.holder, 'neutral', s, 'n').advance(100);
    const shipped = led(120);
    expect(rel(watts(shipped.host, shipped.bulb, 'a', 'b'), watts(test, t.bulb, 'a', 'b'))).toBeLessThan(1e-9);

    for (const fixtureRef of [SHIPPED.wall, LED_FIXTURE]) {
      const host = new SourceHost();
      const source = host.place(AC_SOURCE);
      const wall = host.place(fixtureRef);
      host.lead(source, 'l', wall, 'hot').lead(wall, 'neutral', source, 'n').advance(100);
      expect(rel(watts(host, wall, 'hot', 'neutral'), 15)).toBeLessThan(0.01);
    }
  });
});
