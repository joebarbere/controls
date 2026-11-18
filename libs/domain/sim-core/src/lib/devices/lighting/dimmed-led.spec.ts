import { AC_SOURCE, end } from '../../../testing/bench';
import { A19_60W, DIMMER, LED_A19, LED_FIXTURE, socket } from '../../../testing/lighting';
import { SourceHost } from '../../../testing/sources';
import { OUTER_LOOP_MAX_ITERATIONS } from '../../constants';
import type { NetlistBranch } from '../../netlist/types';

/*
 * A dimmer feeding an LED driver (review E1; ADR 0021 L2, L3): what a phase-cut dimmer isn't meant to
 * feed (the pre-audit's must-avoid), so the model doesn't claim a dimmed LED, but it must give a defined
 * operating point that never blanks the island. Before the loop was staged, an A19 LED behind a dimmer
 * at 1, 0.9 or 0.75 took the shared island to the 50-pass cap at every solve (`nonConverged`), and ten
 * undimmed lamps on the same source read as unsettled and stopped heating.
 *
 * The defined behaviour: the dimmer (stage 0) fits its reactance with the driver's admittance frozen at
 * the warm start's value, then the driver (stage 1) settles behind that frozen reactance as a
 * constant-power load (or stops below its dropout and stays stopped for the solve). Pinned here: for
 * the A19 lamp and the fixture at 0.25, 0.5, 0.75 and 1, with an undimmed 60 W lamp on the same
 * source, the whole island is a reading at every solve, inside the cap (at most a dozen phasor solves
 * once settled), the driver's voltage never exceeds the source's open-circuit 120 V, and the undimmed
 * lamp settles at its 0.5 A. What the driver does is a consequence, pinned but not a claim: at 0.25,
 * 0.5 and 0.75 it can't hold up behind the fitted reactance and stays stopped (reading the open-circuit
 * 119.95 V); at 1 it runs at about 116.6 V. Before the driver's displacement was carried lagging, a
 * leading admittance resonated with the dimmer's series inductance and ran at 128–133 V at 0.75 and 1,
 * past ANSI C84.1 Range B (the review's item 3; ADR 0021 L3).
 */

const rel = (a: number, b: number) => Math.abs(a / b - 1);

function bench(led: { id: string; version: number }, level: number) {
  const host = new SourceHost();
  const source = host.place(AC_SOURCE);
  const dimmer = host.place(DIMMER);
  const target = led === LED_A19 ? socket(host, LED_A19) : null;
  const ledId = target?.bulb ?? host.place(led);
  const hot = target === null ? [ledId, 'hot'] : [target.holder, 'hot'];
  const neutral = target === null ? [ledId, 'neutral'] : [target.holder, 'neutral'];
  host.lead(source, 'l', dimmer, 'line').lead(dimmer, 'load', hot[0] as number, hot[1] as string);
  host.lead(neutral[0] as number, neutral[1] as string, source, 'n');
  const lamp = socket(host, A19_60W);
  host.lead(source, 'l', lamp.holder, 'hot').lead(lamp.holder, 'neutral', source, 'n');
  host.operate(dimmer, 'on', true).operate(dimmer, 'level', level);
  return { host, ledId, lamp: lamp.bulb, dimmer };
}

function islandOf(host: SourceHost, entity: number): number {
  return (
    host.engine.netlist.branches.find(
      (b) => b.element.kind === 'entity' && b.element.entity === entity,
    ) as NetlistBranch
  ).island;
}

describe('a dimmer feeding an LED driver: a defined, readable operating point (review E1)', () => {
  it.each([
    ['light.led', 0.25, false],
    ['light.led', 0.5, false],
    ['light.led', 0.75, false],
    ['light.led', 1, true],
    ['light.ledFixture', 0.25, false],
    ['light.ledFixture', 0.5, false],
    ['light.ledFixture', 0.75, false],
    ['light.ledFixture', 1, true],
  ])(
    '%s at level %s: the whole island is a reading at every solve; the undimmed lamp settles (running: %s)',
    (kind, level, running) => {
      const { host, ledId, lamp } = bench(kind === 'light.led' ? LED_A19 : LED_FIXTURE, level);
      const island = islandOf(host, lamp);
      expect(islandOf(host, ledId)).toBe(island);
      const [a, b] = kind === 'light.led' ? ['a', 'b'] : ['hot', 'neutral'];
      const volts: number[] = [];
      for (let t = 0; t < 30; t++) {
        host.advance(10);
        const info = host.engine.islands().find((i) => i.index === island);
        expect(info?.status).toBe('solved');
        expect(info?.iterations).toBeLessThan(OUTER_LOOP_MAX_ITERATIONS.value);
        // Past the first few solves (a cold fit, a driver starting and sinking), a dozen phasor solves at most.
        if (t >= 10) expect(info?.iterations).toBeLessThanOrEqual(12);
        // Never above the source's open-circuit 120 V (the review's item 3: a leading driver behind the
        // dimmer's reactance resonated up to 133 V, past ANSI C84.1 Range B).
        const v = host.engine.probe(end(ledId, a), end(ledId, b));
        volts.push(v.kind === 'ac' ? v.rmsVolts : Number.NaN);
        expect(volts[volts.length - 1]).toBeLessThanOrEqual(120);
      }
      expect(host.sim(ledId)['running']).toBe(running);
      expect(host.events.some((e) => e.kind === 'nonConverged')).toBe(false);
      const record = host.record(lamp);
      expect(record['status']).toBe('solved');
      expect(rel(record['currentA'] as number, 0.5)).toBeLessThan(0.01);
      const probe = host.engine.probe(
        end(ledId, kind === 'light.led' ? 'a' : 'hot'),
        end(ledId, kind === 'light.led' ? 'b' : 'neutral'),
      );
      expect(probe.kind).toBe('ac');
    },
  );
});
