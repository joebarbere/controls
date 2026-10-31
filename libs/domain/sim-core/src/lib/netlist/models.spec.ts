import { BUILTIN_CATALOG, MODEL_KINDS } from '@controls/catalog';
import { LEAD_CONDUCTOR_TEMPERATURE_K } from '../constants';
import { LEAD } from '../../testing/bench';
import { CONNECTION_NETLIST_MODELS, DEVICE_NETLIST_MODELS, ownModel } from './models';

describe('netlist models', () => {
  it('cover every model kind in MODEL_KINDS, by placement, under their own names', () => {
    const kinds = Object.values(MODEL_KINDS);
    expect(Object.keys(DEVICE_NETLIST_MODELS).sort()).toStrictEqual(
      kinds
        .filter((k) => k.placement === 'entity')
        .map((k) => k.kind)
        .sort(),
    );
    expect(Object.keys(CONNECTION_NETLIST_MODELS).sort()).toStrictEqual(
      kinds
        .filter((k) => k.placement === 'connection')
        .map((k) => k.kind)
        .sort(),
    );
    for (const [name, model] of Object.entries({ ...DEVICE_NETLIST_MODELS, ...CONNECTION_NETLIST_MODELS })) {
      expect(model.kind).toBe(name);
    }
  });

  it('read only commanded state and their declared sim topology keys (the fuse and the breaker only)', () => {
    const declared: Record<string, readonly string[]> = {};
    for (const model of Object.values(DEVICE_NETLIST_MODELS)) {
      const kind = MODEL_KINDS[model.kind];
      for (const key of model.simTopologyKeys) expect(kind.keys[key]?.owner).toBe('sim');
      if (model.simTopologyKeys.length > 0) declared[model.kind] = model.simTopologyKeys;
    }
    expect(declared).toStrictEqual({ 'breaker.thermalMagnetic': ['tripped'], fuse: ['blown'] });
  });

  it('the fuse is a link until it blows; the breaker a pole while its handle is on and it has not tripped', () => {
    const fuse = (blown: boolean) =>
      DEVICE_NETLIST_MODELS['fuse'].topology({ params: { resistanceOhm: 0.1 }, state: {}, sim: { blown } });
    expect(fuse(false).elements.map((e) => [e.part, e.kind, e.a, e.b, e.values])).toStrictEqual([
      ['link', 'resistor', 'a', 'b', { resistanceOhm: 0.1 }],
    ]);
    expect(fuse(true)).toStrictEqual({ joins: [], elements: [] });
    const breaker = (on: boolean, tripped: boolean) =>
      DEVICE_NETLIST_MODELS['breaker.thermalMagnetic'].topology({
        params: { contactResistanceOhm: 0.004 },
        state: { on },
        sim: { tripped },
      }).elements.length;
    expect([breaker(true, false), breaker(true, true), breaker(false, false), breaker(false, true)]).toStrictEqual([
      1, 0, 0, 0,
    ]);
  });

  it('the SPST switch joins its terminals only when closed', () => {
    const topology = (closed: unknown) =>
      DEVICE_NETLIST_MODELS['switch.spst'].topology({ params: {}, state: { closed: closed as boolean }, sim: {} });
    expect(topology(true)).toStrictEqual({ joins: [['a', 'b']], elements: [] });
    expect(topology(false)).toStrictEqual({ joins: [], elements: [] });
    expect(topology(null)).toStrictEqual({ joins: [], elements: [] });
  });

  it('the lead’s conductor temperature is a sourced constant inside the linear α range of leadResistanceOhm', () => {
    expect(LEAD_CONDUCTOR_TEMPERATURE_K.value).toBeGreaterThanOrEqual(223.15);
    expect(LEAD_CONDUCTOR_TEMPERATURE_K.value).toBeLessThanOrEqual(423.15);
    expect(LEAD_CONDUCTOR_TEMPERATURE_K.source).toMatch(/^game-design: /);
    // At the IACS reference temperature the built-in lead has exactly its catalogue resistivity.
    expect(BUILTIN_CATALOG.device(LEAD)?.model.params['referenceTemperatureK']).toBe(
      LEAD_CONDUCTOR_TEMPERATURE_K.value,
    );
  });

  it('look up own properties only', () => {
    expect(ownModel(DEVICE_NETLIST_MODELS, 'toString')).toBeUndefined();
    expect(ownModel(DEVICE_NETLIST_MODELS, 'battery')?.kind).toBe('battery');
  });
});
