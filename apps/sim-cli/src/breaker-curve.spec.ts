import { BUILTIN_CATALOG, type BreakerParams } from '@controls/catalog';
import { BREAKER, BUSBAR, RHEOSTAT, SourceHost, UTILITY_SPLIT } from '@controls/sim-core/testing';

/*
 * The breaker's long-overload end (plan F2.5 part 2), headless: at 135 % of its rating the thermal
 * element takes about two minutes of sim time, 117 000 ticks, too slow under sim-core's coverage
 * instrumentation (the battery-hour golden's reason, beside it). The engine is the same code; sim-core's
 * `protection.spec.ts` keeps 200 % and 500 %.
 *
 * Hand calculation. The 15 A breaker: τ = 60 s, ultimate trip 1.25 × 15 A = 18.75 A. At I = 1.35 × 15 =
 * 20.25 A on a 120 V service, t = −τ ln(1 − (18.75 / I)²) = −60 ln(1 − 0.857339) = 116.8 s: inside
 * the fictional datasheet's 30 s to 1 h band, and the UL 489-style "within an hour at 135 %".
 */

const breaker = BUILTIN_CATALOG.device(BREAKER)?.model.params as BreakerParams;

describe("the breaker's 135 % trip (F2.5 part 2 golden)", () => {
  it('trips thermally after −τ ln(1 − (k_u I_n / I)²), about 117 s, within 0.5 %, inside its band', () => {
    const host = new SourceHost();
    host.place(UTILITY_SPLIT);
    host.place(BREAKER);
    host.place(RHEOSTAT);
    host.exec('lead.connect', { ref: BUSBAR, a: { entity: 1, terminal: 'l1' }, b: { entity: 2, terminal: 'line' } });
    host.exec('lead.connect', { ref: BUSBAR, a: { entity: 2, terminal: 'load' }, b: { entity: 3, terminal: 'a' } });
    host.exec('lead.connect', { ref: BUSBAR, a: { entity: 3, terminal: 'b' }, b: { entity: 1, terminal: 'n' } });
    host.operate(3, 'ohms', 120 / (1.35 * breaker.ratedCurrentA)).operate(2, 'on', true);
    const amps = host.record(2)['currentA'] as number;
    expect(Math.abs(amps / (1.35 * breaker.ratedCurrentA) - 1)).toBeLessThan(0.01);
    const a = breaker.ultimateTripRatio * breaker.ratedCurrentA;
    const expected = -breaker.thermalTimeConstantS * Math.log(1 - (a / amps) * (a / amps)) * 1000;
    host.advance(130_000);
    const trip = host.events.find((e) => e.kind === 'tripped');
    expect(trip?.detail).toStrictEqual({ cause: 'thermal' });
    const ticks = trip?.tick ?? -1;
    expect(Math.abs(ticks / expected - 1)).toBeLessThan(0.005);
    expect(ticks / 1000).toBeGreaterThan(30);
    expect(ticks / 1000).toBeLessThan(3600);
  });
});
