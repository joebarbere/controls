import { AC_SOURCE } from '../../testing/bench';
import { engineBus, engineTestOptions, REACTOR, RESISTOR_100 } from '../../testing/engine';
import { SourceHost } from '../../testing/sources';
import { OUTER_LOOP_MAX_ITERATIONS } from '../constants';
import type { SimDeviceModel } from './device-model';

/*
 * The phasor outer loop (`acIterate`, P4 PR 12; ADR 0021 L2, L3, deviation L-d), on synthetic hooks:
 * the cap and `nonConverged` (never hidden), each island's own iteration count (review E6), only the
 * islands that moved re-solved (review E3). The stages' order (a dimmer fitting before the drivers
 * behind it settle) is pinned by `devices/lighting/dimmed-led.spec.ts`.
 */

/** `test.reactor` with an `acIterate` that toggles between two inductances on every pass for ever. */
const restless: SimDeviceModel = {
  kind: 'test.reactor',
  output: null,
  bank(devices) {
    const henries = new Float64Array(devices.length);
    return {
      bag: () => ({}),
      dcValue: (_i, b, values) => {
        values.resistor(b.index, 1);
        return true;
      },
      acIterate: (i, b, _iterate, values, pass) => {
        henries[i] = pass % 2 === 0 ? 0.05 : 0.06;
        values.inductorAt(b.index, henries, i);
        return pass > 0;
      },
    };
  },
};

/** `test.resistor` 100 Ω with a stage-1 hook that settles after `settle` passes, recording what it sees. */
function settling(settle: number, seen: string[]): SimDeviceModel {
  return {
    kind: 'test.resistor',
    output: null,
    bank(devices) {
      const calls = new Int32Array(devices.length);
      return {
        bag: () => ({}),
        dcValue: (_i, b, values) => {
          values.resistor(b.index, 100);
          return true;
        },
        acStage: 1,
        acIterate: (i, b, _iterate, values, pass) => {
          if (pass === 0) calls[i] = 0;
          else calls[i]++;
          seen.push(`resistor@${pass}`);
          values.resistor(b.index, 100);
          return pass > 0 && calls[i] < settle;
        },
      };
    },
  };
}

function host(models: Record<string, SimDeviceModel>): SourceHost {
  const options = engineTestOptions();
  return new SourceHost(engineBus(), { ...options, deviceModels: { ...options.deviceModels, ...models } });
}

describe('the phasor outer loop (acIterate)', () => {
  it('caps a hook that never settles at OUTER_LOOP_MAX_ITERATIONS and flags only its island nonConverged', () => {
    const h = host({ 'test.reactor': restless });
    const s1 = h.place(AC_SOURCE);
    const reactor = h.place(REACTOR);
    const s2 = h.place(AC_SOURCE);
    const load = h.place(RESISTOR_100);
    h.lead(s1, 'l', reactor, 'a').lead(reactor, 'b', s1, 'n');
    h.lead(s2, 'l', load, 'a').lead(load, 'b', s2, 'n').advance(10);
    const islands = h.engine.islands();
    const of = (entity: number) => islands.find((i) => i.entities.includes(entity));
    expect(of(reactor)?.status).toBe('nonConverged');
    expect(of(reactor)?.iterations).toBe(OUTER_LOOP_MAX_ITERATIONS.value);
    // The other island has no hook and was solved once: neither re-solved nor flagged (E3, E6).
    expect(of(load)?.status).toBe('solved');
    expect(of(load)?.iterations).toBe(1);
    expect(h.events.filter((e) => e.kind === 'nonConverged').map((e) => e.entities)).toStrictEqual([[s1, reactor]]);
  });

  it('an island records its own phasor solves: one per moving pass, plus the first', () => {
    const seen: string[] = [];
    const h = host({ 'test.resistor': settling(3, seen) });
    const s1 = h.place(AC_SOURCE);
    const fast = h.place(RESISTOR_100);
    h.lead(s1, 'l', fast, 'a').lead(fast, 'b', s1, 'n');
    seen.length = 0;
    // The cadence solve at tick 10.
    h.advance(11);
    const island = h.engine.islands().find((i) => i.entities.includes(fast));
    // Passes 1 and 2 move (each a re-solve), pass 3 accepts: three phasor solves.
    expect(island?.iterations).toBe(3);
    expect(island?.status).toBe('solved');
    expect(seen).toStrictEqual(['resistor@0', 'resistor@1', 'resistor@2', 'resistor@3']);
  });
});
