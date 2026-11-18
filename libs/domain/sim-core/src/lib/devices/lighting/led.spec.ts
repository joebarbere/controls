import { AC_SOURCE, end } from '../../../testing/bench';
import { AC_SOURCE_OHMS, RESISTOR_12, RHEOSTAT } from '../../../testing/engine';
import {
  AC_SOURCE_VOLTS,
  acSourceAt,
  LED_A19,
  LED_FIXTURE,
  LED_FIXTURE_POWER_W,
  LED_PARAMS,
  socket,
} from '../../../testing/lighting';
import { SourceHost } from '../../../testing/sources';
import type { NetlistBranch } from '../../netlist/types';
import { OUTER_LOOP_MAX_ITERATIONS } from '../../constants';
import { LED_DRIVER_OFF_OHM } from './constants';

/*
 * The constant-power LED driver's goldens (plan F4.1 part 1, D11): "LED power constant within 1 % from
 * 108 to 127 V, and zero below dropout".
 *
 * Hand calculation for the test A19 lamp (9 W, PF 0.9 carried lagging, dropout 90 V, restart 95 V): |S| = 9 / 0.9
 * = 10 VA, |Q| = 9 · √(1 − 0.81) / 0.9 = 4.3589 var. On a test source of E behind 0.1 Ω the driver's
 * voltage is within 0.01 % of E (|I| = 10 / E ≈ 0.08 A drops 8 mV), so it draws 9 W and 4.3589 var
 * (lagging: Im(V · conj(I)) = +4.3589) at every E from 108 to 127 V, through its E26 contacts. At 120 V
 * its admittance is G = 9 / 120² = 6.25e-4 S and B = 4.3589 / 120² = 3.0270e-4 S. Below 90 V it draws
 * nothing (two 100 MΩ branches: under 0.2 mW at 89 V).
 */

const rel = (a: number, b: number) => Math.abs(a / b - 1);
const Q_VAR = (9 * Math.sqrt(1 - 0.81)) / 0.9;

/** The driver's complex power S = V · conj(I) at its terminals (W, var), from the solution. */
function power(host: SourceHost, entity: number, a = 'a', b = 'b'): { p: number; q: number } {
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
  return { p: reading.re * iRe + reading.im * iIm, q: reading.im * iRe - reading.re * iIm };
}

/** An LED A19 lamp in a lampholder across `source`; returns the host and the bulb's id. */
function lamp(source: { id: string; version: number }): { host: SourceHost; bulb: number; holder: number } {
  const host = new SourceHost();
  const s = host.place(source);
  const { holder, bulb } = socket(host, LED_A19);
  host.lead(s, 'l', holder, 'hot').lead(holder, 'neutral', s, 'n');
  return { host, bulb, holder };
}

describe('the constant-power LED driver (D11)', () => {
  it.each(AC_SOURCE_VOLTS.filter((v) => v >= 108 && v <= 127).map((v) => [v]))(
    'at %s V it draws its rated 9 W within 1 % (and 4.36 var lagging)',
    (volts) => {
      const { host, bulb } = lamp(acSourceAt(volts as (typeof AC_SOURCE_VOLTS)[number]));
      host.advance(30);
      const { p, q } = power(host, bulb);
      expect(rel(p, LED_PARAMS.ratedPowerW)).toBeLessThan(0.01);
      // Far inside, in fact: the loop stops within 0.1 % of the admittance.
      expect(rel(p, LED_PARAMS.ratedPowerW)).toBeLessThan(2e-3);
      expect(rel(q, Q_VAR)).toBeLessThan(2e-3);
      expect(host.sim(bulb)['running']).toBe(true);
    },
  );

  it('at 120 V on the 120 V test source as well, through the lampholder', () => {
    const { host, bulb } = lamp(AC_SOURCE);
    host.advance(30);
    expect(rel(power(host, bulb).p, 9)).toBeLessThan(2e-3);
  });

  it.each([[80], [89]])('below its dropout (%s V) a new driver never runs and draws nothing', (volts) => {
    const { host, bulb } = lamp(acSourceAt(volts as (typeof AC_SOURCE_VOLTS)[number]));
    host.advance(100);
    const { p } = power(host, bulb);
    expect(host.sim(bulb)['running']).toBe(false);
    // Two 100 MΩ branches: V² · 2 / 1e8.
    expect(p).toBeLessThan(1e-3);
    expect(rel(p, (2 * volts * volts) / LED_DRIVER_OFF_OHM.value)).toBeLessThan(0.01);
  });

  it('hysteresis: a running driver rides down to its dropout; a stopped one waits for its restart voltage', () => {
    // The lamp across the lower arm of a divider: 120 V through 12 Ω, then a rheostat to neutral, so
    // the lamp's supply moves (a value change) without ever being disconnected (unpowered, a driver
    // stops: that is physics, not hysteresis). Rheostat 1e7 Ω: about 120 V; 39.43 Ω: 92.0 V open
    // circuit, about 91.0 V with the running lamp's 0.11 A through the divider's 9.2 Ω (inside the 90–95 V
    // band either way); 24 Ω: 80 V (below dropout).
    const host = new SourceHost();
    const s = host.place(AC_SOURCE);
    const upper = host.place(RESISTOR_12);
    const lower = host.place(RHEOSTAT);
    const { holder, bulb } = socket(host, LED_A19);
    host.operate(lower, 'ohms', 1e7);
    host.lead(s, 'l', upper, 'a').lead(upper, 'b', lower, 'a').lead(lower, 'b', s, 'n');
    host.lead(upper, 'b', holder, 'hot').lead(holder, 'neutral', s, 'n').advance(20);
    expect(host.sim(bulb)['running']).toBe(true);
    const supply = (ohms: number) => host.operate(lower, 'ohms', ohms).advance(20);
    const volts = () => {
      const reading = host.engine.probe(end(bulb, 'a'), end(bulb, 'b'));
      return reading.kind === 'ac' ? reading.rmsVolts : Number.NaN;
    };
    supply(39.43);
    expect(volts()).toBeGreaterThan(90);
    expect(volts()).toBeLessThan(95);
    expect(host.sim(bulb)['running']).toBe(true);
    expect(rel(power(host, bulb).p, 9)).toBeLessThan(2e-3);
    // A save inside the band reloads running, and runs on the same.
    const reloaded = host.reload();
    expect(reloaded.sim(bulb)['running']).toBe(true);
    reloaded.advance(20);
    expect(rel(power(reloaded, bulb).p, 9)).toBeLessThan(2e-3);
    // Below dropout it stops; back in the band it stays stopped (and a save there reloads stopped).
    supply(24);
    expect(host.sim(bulb)['running']).toBe(false);
    expect(power(host, bulb).p).toBeLessThan(1e-3);
    supply(39.43);
    expect(volts()).toBeGreaterThan(90);
    expect(volts()).toBeLessThan(95);
    expect(host.sim(bulb)['running']).toBe(false);
    expect(power(host, bulb).p).toBeLessThan(1e-3);
    expect(host.reload().sim(bulb)['running']).toBe(false);
    // At about 120 V again it restarts.
    supply(1e7);
    expect(host.sim(bulb)['running']).toBe(true);
    // Unpowered (its lead removed), a driver stops.
    host.exec('lead.disconnect', { id: 4 }).advance(20);
    expect(host.sim(bulb)['running']).toBe(false);
  });

  it('band edges (realism R7): running, it holds at 90.5 V and stops at 89.5 V; stopped, it waits at 94.5 V and starts at 95.5 V', () => {
    // The divider of the hysteresis test (120 V through 12 Ω over a rheostat, the lamp across the
    // rheostat); each point on a fresh host, so a dropout never carries into the next point.
    const at = (startOhms: number, ohms: number) => {
      const host = new SourceHost();
      const s = host.place(AC_SOURCE);
      const upper = host.place(RESISTOR_12);
      const lower = host.place(RHEOSTAT);
      const { holder, bulb } = socket(host, LED_A19);
      host.operate(lower, 'ohms', startOhms);
      host.lead(s, 'l', upper, 'a').lead(upper, 'b', lower, 'a').lead(lower, 'b', s, 'n');
      host.lead(upper, 'b', holder, 'hot').lead(holder, 'neutral', s, 'n').advance(20);
      host.operate(lower, 'ohms', ohms).advance(20);
      const reading = host.engine.probe(end(bulb, 'a'), end(bulb, 'b'));
      return { running: host.sim(bulb)['running'] === true, volts: reading.kind === 'ac' ? reading.rmsVolts : NaN };
    };
    /** The rheostat (Ω) where `volts(ohms)` is `target`, by bisection on [lo, hi] (volts rising with ohms). */
    const solve = (volts: (ohms: number) => number, target: number, lo: number, hi: number) => {
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (volts(mid) < target) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    };
    // Running from 120 V: the rheostat giving 90.5 V and 91.5 V while it runs, and 89.5 V extrapolated.
    const running = (ohms: number) => at(1e7, ohms);
    // A point where it dropped out counts as below any target, so the search stays on the running branch.
    const runningVolts = (o: number) => (running(o).running ? running(o).volts : -Infinity);
    const r905 = solve(runningVolts, 90.5, 30, 60);
    const r915 = solve(runningVolts, 91.5, 30, 60);
    expect(running(r905).running).toBe(true);
    expect(Math.abs(running(r905).volts - 90.5)).toBeLessThan(0.01);
    const r895 = r905 - (r915 - r905);
    expect(running(r895).running).toBe(false);
    // Stopped (started at 80 V): the rheostat giving 94.5 V while stopped, and 95.5 V from the divider
    // ratio (stopped, the driver draws next to nothing: V = 120 · R / (R + R_rest)).
    const stopped = (ohms: number) => at(24, ohms);
    // A point where it started counts as above any target, so the search stays on the stopped branch.
    const stoppedVolts = (o: number) => (stopped(o).running ? Infinity : stopped(o).volts);
    const r945 = solve(stoppedVolts, 94.5, 30, 60);
    expect(stopped(r945).running).toBe(false);
    expect(Math.abs(stopped(r945).volts - 94.5)).toBeLessThan(0.01);
    const rest = r945 * (120 / 94.5 - 1);
    const r955 = (95.5 * rest) / (120 - 95.5);
    expect(stopped(r955).running).toBe(true);
  });

  it('a supply that can’t hold it up: the driver stops and stays stopped for the solve, the island readable (review E1)', () => {
    // 120 V behind 300 Ω more: running, the driver would sit near 84.5 V (below dropout); stopped, it
    // sees nearly 120 V (above restart). A real one blinks. A driver that stops during a solve can't
    // restart in it, so each solve settles stopped in a few passes: the island stays a reading.
    const host = new SourceHost();
    const s = host.place(AC_SOURCE);
    const r = host.place(RHEOSTAT);
    const { holder, bulb } = socket(host, LED_A19);
    host.operate(r, 'ohms', 300);
    host.lead(s, 'l', r, 'a').lead(r, 'b', holder, 'hot').lead(holder, 'neutral', s, 'n');
    const island = host.engine.netlist.branches.find(
      (b) => b.element.kind === 'entity' && b.element.entity === bulb,
    )?.island;
    for (let t = 0; t < 5; t++) {
      host.advance(10);
      const info = host.engine.islands().find((i) => i.index === island);
      expect(info?.status).toBe('solved');
      // It starts, sinks over a few fixed-point passes, stops below dropout and stays stopped.
      expect(info?.iterations).toBeLessThanOrEqual(10);
      expect(host.sim(bulb)['running']).toBe(false);
      expect(power(host, bulb).p).toBeLessThan(1e-3);
    }
    expect(host.events.some((e) => e.kind === 'nonConverged')).toBe(false);
    expect(OUTER_LOOP_MAX_ITERATIONS.value).toBe(50);
    // A stiffer supply settles it running: 120 V behind 10 Ω more.
    host.operate(r, 'ohms', 10);
    const settled = host.engine.islands().find((i) => i.index === island);
    expect(settled?.status).toBe('solved');
    expect(host.sim(bulb)['running']).toBe(true);
    expect(rel(power(host, bulb).p, 9)).toBeLessThan(2e-3);
  });

  it('the fixture draws its 15 W between its hot and neutral leads; its ground lead joins nothing', () => {
    const host = new SourceHost();
    const s = host.place(AC_SOURCE);
    const fixture = host.place(LED_FIXTURE);
    host.lead(s, 'l', fixture, 'hot').lead(fixture, 'neutral', s, 'n').advance(30);
    expect(rel(power(host, fixture, 'hot', 'neutral').p, LED_FIXTURE_POWER_W)).toBeLessThan(2e-3);
    const ground = host.engine.netlist.nodes.find((n) =>
      n.members.some((m) => m.entity === fixture && m.terminal === 'ground'),
    );
    expect(ground?.members).toStrictEqual([{ entity: fixture, terminal: 'ground' }]);
  });

  it('on a DC island (the bench battery) the driver is stopped and draws nothing', () => {
    const host = new SourceHost();
    const battery = host.place({ id: 'battery.ferrovane-12v-7ah', version: 1 });
    const fixture = host.place(LED_FIXTURE);
    host.lead(battery, 'pos', fixture, 'hot').lead(fixture, 'neutral', battery, 'neg').advance(20);
    expect(host.sim(fixture)['running']).toBe(false);
    expect(Math.abs(host.volts(fixture, 'hot', fixture, 'neutral'))).toBeGreaterThan(12);
    const branch = host.engine.netlist.branches.find(
      (b) => b.element.kind === 'entity' && b.element.entity === fixture,
    );
    const amps = host.engine.branchAmps(branch?.element as never);
    expect(amps).toBeLessThan(1e-6);
  });

  it('settles in one phasor solve from a warm start, and the source drop is tiny (|I| = 10 / E behind 0.1 Ω)', () => {
    const { host, bulb } = lamp(AC_SOURCE);
    host.advance(20);
    const branch = host.engine.netlist.branches.find((b) => b.element.kind === 'entity' && b.element.entity === bulb);
    const info = host.engine.islands().find((i) => i.index === branch?.island);
    expect(info?.iterations).toBe(1);
    const reading = host.engine.probe(end(bulb, 'a'), end(bulb, 'b'));
    expect(reading.kind === 'ac' && rel(reading.rmsVolts, 120)).toBeLessThan((10 / 120) * AC_SOURCE_OHMS * 2);
  });
});
