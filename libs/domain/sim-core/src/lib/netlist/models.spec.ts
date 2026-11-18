import { BUILTIN_CATALOG, MODEL_KINDS } from '@controls/catalog';
import { AMBIENT_TEMPERATURE_K } from '../constants';
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

  it('read only commanded state and their declared sim topology keys (the fuse and the breakers only)', () => {
    const declared: Record<string, readonly string[]> = {};
    for (const model of Object.values(DEVICE_NETLIST_MODELS)) {
      const kind = MODEL_KINDS[model.kind];
      for (const key of model.simTopologyKeys) expect(kind.keys[key]?.owner).toBe('sim');
      if (model.simTopologyKeys.length > 0) declared[model.kind] = model.simTopologyKeys;
    }
    expect(declared).toStrictEqual({
      'breaker.afci1p': ['tripped'],
      'breaker.gfci1p': ['tripped', 'testHeldSinceTick'],
      'breaker.plugOn1p': ['tripped'],
      'breaker.plugOn2p': ['tripped'],
      'breaker.thermalMagnetic': ['tripped'],
      fuse: ['blown'],
    });
  });

  it('breakers v2 (P4 PR 10): every pole while closed (a common trip), the sensing neutral always, the GFCI test resistor while held; the wiring view intact', () => {
    const params = { contactResistanceOhm: 0.005, testResistanceOhm: 15_000 };
    const parts = (kind: string, on: boolean, sim: Record<string, boolean>) =>
      DEVICE_NETLIST_MODELS[kind]
        .topology({ params, state: { on }, sim })
        .elements.map((e) => `${e.part} ${e.a}→${e.b}`);
    expect(parts('breaker.plugOn1p', true, { tripped: false })).toStrictEqual(['pole line→load']);
    expect(parts('breaker.plugOn1p', true, { tripped: true })).toStrictEqual([]);
    expect(parts('breaker.plugOn1p', false, { tripped: false })).toStrictEqual([]);
    expect(parts('breaker.plugOn2p', true, { tripped: false })).toStrictEqual([
      'pole1 line1→load1',
      'pole2 line2→load2',
    ]);
    expect(parts('breaker.plugOn2p', true, { tripped: true })).toStrictEqual([]);
    expect(parts('breaker.gfci1p', true, { tripped: false, testHeldSinceTick: true })).toStrictEqual([
      'neutral pigtail→loadNeutral',
      'pole line→load',
      'test load→pigtail',
    ]);
    expect(parts('breaker.gfci1p', false, { tripped: false, testHeldSinceTick: false })).toStrictEqual([
      'neutral pigtail→loadNeutral',
    ]);
    expect(parts('breaker.afci1p', true, { tripped: true })).toStrictEqual(['neutral pigtail→loadNeutral']);
    for (const kind of ['breaker.plugOn1p', 'breaker.plugOn2p', 'breaker.gfci1p', 'breaker.afci1p']) {
      const model = DEVICE_NETLIST_MODELS[kind];
      expect(model.wiringPath, kind).toBe(true);
      const wiring = model.wiring?.({ params, state: { on: false }, sim: {} }).elements.map((e) => e.part);
      // Never the test resistor: it would join the load-side hot to the neutral in `wiringGraph`.
      expect(wiring, kind).toStrictEqual(
        kind === 'breaker.plugOn2p' ? ['pole1', 'pole2'] : kind === 'breaker.plugOn1p' ? ['pole'] : ['neutral', 'pole'],
      );
    }
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
    expect(AMBIENT_TEMPERATURE_K.value).toBeGreaterThanOrEqual(223.15);
    expect(AMBIENT_TEMPERATURE_K.value).toBeLessThanOrEqual(423.15);
    expect(AMBIENT_TEMPERATURE_K.source).toMatch(/^game-design: /);
    // At the IACS reference temperature the built-in lead has exactly its catalogue resistivity.
    expect(BUILTIN_CATALOG.device(LEAD)?.model.params['referenceTemperatureK']).toBe(AMBIENT_TEMPERATURE_K.value);
  });

  it('look up own properties only', () => {
    expect(ownModel(DEVICE_NETLIST_MODELS, 'toString')).toBeUndefined();
    expect(ownModel(DEVICE_NETLIST_MODELS, 'battery')?.kind).toBe('battery');
  });
});
