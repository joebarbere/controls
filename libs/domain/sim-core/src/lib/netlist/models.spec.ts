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

  it('read only commanded state and their declared sim topology keys (none for the P2 bench kinds)', () => {
    for (const model of Object.values(DEVICE_NETLIST_MODELS)) {
      const kind = MODEL_KINDS[model.kind];
      for (const key of model.simTopologyKeys) expect(kind.keys[key]?.owner).toBe('sim');
      expect(model.simTopologyKeys).toStrictEqual([]);
    }
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
