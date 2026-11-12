import { LEAD_SIM_BAG_V3 } from '@controls/save-format';
import { worldHash } from '@controls/world-model';
import fc from 'fast-check';
import { BATTERY, LAMP } from '../../testing/bench';
import { RESISTOR_2_4 } from '../../testing/engine';
import { SourceHost } from '../../testing/sources';
import { AMBIENT_TEMPERATURE_K } from '../constants';

/*
 * The connection thermal bank inside the engine (F3.6 part 1, ADR 0018 §3.4, ADR 0015): the fixed
 * absolute schedule, materialisation of every connection's bag, and save/load parity mid-heating.
 */

const TA = AMBIENT_TEMPERATURE_K.value;

/** A battery (1) shorted through a 2.4 Ω resistor (2) by two leads (1, 2): about 5 A, so the leads warm. */
function heatingLoop(host = new SourceHost()): SourceHost {
  host.place(BATTERY);
  host.place(RESISTOR_2_4);
  host.lead(1, 'pos', 2, 'a');
  host.lead(2, 'b', 1, 'neg');
  return host;
}

const leadTemp = (host: SourceHost, id: number) =>
  host.engine.exportState().connections.find((c) => c.id === id)?.state['conductorTempK'] as number;

describe('the connection thermal bank in the engine', () => {
  it('integrates only at cadence ticks (t % 10 = 0), never in between', () => {
    // Step 20 integrates over [20, 30): the state at 21 holds it, and nothing moves until step 30.
    const host = heatingLoop().advanceTo(21);
    const after20 = leadTemp(host, 1);
    expect(after20).toBeGreaterThan(TA);
    for (let t = 22; t <= 30; t++) {
      host.advanceTo(t);
      expect(leadTemp(host, 1)).toBe(after20);
    }
    host.advanceTo(31);
    expect(leadTemp(host, 1)).toBeGreaterThan(after20);
  });

  it('materialises every connection of a known kind, with the ten keys; a lead keeps its end keys initial', () => {
    const host = heatingLoop().advance(5000);
    const world = host.materialised();
    expect(world.connections.map((c) => c.id)).toStrictEqual([1, 2]);
    for (const connection of world.connections) {
      expect(Object.keys(connection.sim).sort()).toStrictEqual(Object.keys(LEAD_SIM_BAG_V3).sort());
      expect(connection.sim['conductorTempK'] as number).toBeGreaterThan(TA);
      const { conductorTempK: _, ...ends } = connection.sim;
      const { conductorTempK: __, ...initial } = LEAD_SIM_BAG_V3;
      expect(ends).toStrictEqual(initial);
    }
  });

  it('a heating lead raises the loop resistance: the current falls as it warms', () => {
    const host = heatingLoop().advanceTo(1);
    const cold = host.engine.branchAmps({ kind: 'connection', connection: 1 });
    host.advance(30_000);
    const warm = host.engine.branchAmps({ kind: 'connection', connection: 1 });
    expect(warm).toBeLessThan(cold);
    expect(warm / cold).toBeGreaterThan(0.99); // a few kelvin on a 2.4 Ω load: a tiny effect
  });

  it('save and load mid-heating equals the uninterrupted run (property: any cut, any continuation)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3000 }), fc.integer({ min: 1, max: 3000 }), (cut, more) => {
        const straight = heatingLoop().advanceTo(cut);
        const loaded = straight.reload();
        straight.advance(more);
        loaded.advance(more);
        expect(loaded.engine.snapshotHash()).toBe(straight.engine.snapshotHash());
        expect(loaded.engine.exportState()).toStrictEqual(straight.engine.exportState());
        expect(worldHash(loaded.materialised())).toBe(worldHash(straight.materialised()));
      }),
      { numRuns: 12 },
    );
  });

  it('every materialised connection bag is finite, at or above ambient, with D ≥ 1, after a session', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(fc.constant('lamp' as const), fc.constant('short' as const), fc.integer({ min: 1, max: 4000 })),
          {
            minLength: 1,
            maxLength: 6,
          },
        ),
        (ops) => {
          const host = new SourceHost();
          for (const op of ops) {
            if (op === 'lamp' || op === 'short') {
              const battery = host.place(BATTERY);
              if (op === 'lamp') {
                const lamp = host.place(LAMP);
                host.lead(battery, 'pos', lamp, 'a').lead(lamp, 'b', battery, 'neg');
              } else {
                host.lead(battery, 'pos', battery, 'neg');
              }
            } else host.advance(op);
          }
          for (const connection of host.materialised().connections) {
            const sim = connection.sim;
            expect(Number.isFinite(sim['conductorTempK'])).toBe(true);
            expect(sim['conductorTempK'] as number).toBeGreaterThanOrEqual(TA);
            expect(sim['endADegradation'] as number).toBeGreaterThanOrEqual(1);
            expect(sim['endBDegradation'] as number).toBeGreaterThanOrEqual(1);
            expect(sim['insulationDamaged']).toBe(false);
            expect([
              sim['endATempK'],
              sim['endBTempK'],
              sim['endATerminationId'],
              sim['endBTerminationId'],
            ]).toStrictEqual([null, null, null, null]);
          }
        },
      ),
      { numRuns: 15 },
    );
  });

  it('a deleted and undone lead keeps its temperature (a tombstone), a disconnected one is dropped from the export', () => {
    const host = heatingLoop().advance(3000);
    const warm = leadTemp(host, 2);
    host.exec('lead.disconnect', { id: 2 });
    expect(host.engine.exportState().connections.map((c) => c.id)).toStrictEqual([1]);
    host.exec('edit.undo');
    expect(leadTemp(host, 2)).toBe(warm);
  });
});
