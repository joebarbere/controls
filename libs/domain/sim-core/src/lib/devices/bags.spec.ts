import { MODEL_KINDS, type StateKeyDef } from '@controls/catalog';
import type { DeviceStateValue } from '@controls/save-format';
import fc from 'fast-check';
import { BATTERY } from '../../testing/bench';
import { ENGINE_TEST_CATALOG, engineBus, engineTestOptions } from '../../testing/engine';
import { SimEngine } from '../engine/engine';

/*
 * Every bag a kind's key schemas accept starts the engine and steps without throwing (save-format
 * review of F2.5: a lamp at 1 K, which the key once accepted, gave a negative resistance and a
 * RangeError on the first solve). For every placed kind in MODEL_KINDS: one device of it, its first
 * two terminals across a battery through test leads, its bags drawn from what each key's schema
 * accepts (bounds, the initial value, null where allowed), then a start and 50 steps.
 */

/** Values a key's schema accepts: booleans, the enum's values, or numbers at and inside its bounds. */
function valueArb(def: StateKeyDef): fc.Arbitrary<DeviceStateValue> {
  if (def.type === 'boolean') return fc.boolean();
  if (def.type === 'enum') return fc.constantFrom(...(def.values ?? []));
  const probes = [0, -0, 1e-300, 1e-6, 0.5, 1, 2, 65, 200, 293.15, 3600, 1e6, 1e300, -1, null, def.initial];
  const accepted = probes.filter((v) => def.schema.safeParse(v).success);
  return fc.oneof(
    fc.constantFrom(...accepted),
    fc.double({ min: -1e7, max: 1e7, noNaN: true }).filter((v) => def.schema.safeParse(v).success),
  );
}

const LEAD = { id: 'lead.quillfern-test-1m', version: 1 };

describe('every accepted bag starts and steps (F2.5 review)', () => {
  const placed = Object.values(MODEL_KINDS).filter((k) => k.placement === 'entity');

  it.each(placed.map((k) => [k.kind, k] as const))('%s', (_name, kind) => {
    const device = ENGINE_TEST_CATALOG.devices.find((d) => d.model.kind === kind.kind);
    expect(device, kind.kind).toBeDefined();
    const keys = Object.entries(kind.keys);
    const bags = fc.record(Object.fromEntries(keys.map(([name, def]) => [name, valueArb(def)])));
    fc.assert(
      fc.property(bags, (values) => {
        const bus = engineBus();
        const at = { x: 0, y: 0, z: 0 };
        bus.exec('entity.place', { ref: BATTERY, positionMm: at });
        bus.exec('entity.place', { ref: { id: device?.id, version: device?.version }, positionMm: at });
        const [a, b] = kind.terminals;
        bus.exec('lead.connect', { ref: LEAD, a: { entity: 1, terminal: 'pos' }, b: { entity: 2, terminal: a } });
        bus.exec('lead.connect', { ref: LEAD, a: { entity: 2, terminal: b }, b: { entity: 1, terminal: 'neg' } });
        const state = Object.fromEntries(keys.filter(([, d]) => d.owner === 'commanded').map(([n]) => [n, values[n]]));
        const sim = Object.fromEntries(keys.filter(([, d]) => d.owner === 'sim').map(([n]) => [n, values[n]]));
        const world = {
          ...bus.state,
          entities: bus.state.entities.map((e) => (e.id === 2 ? { ...e, state, sim } : e)),
        };
        const engine = SimEngine.start(world, engineTestOptions());
        engine.advanceTo(50);
        for (const entity of engine.exportState().entities) {
          for (const v of Object.values(entity.state)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
        }
      }),
      { numRuns: 25 },
    );
  });
});
