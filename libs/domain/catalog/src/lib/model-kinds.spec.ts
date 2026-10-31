import { DEVICE_STATE_KEY_PATTERN, DeviceStateValue } from '@controls/save-format';
import fc from 'fast-check';
import { bagSchemas, checkBags, initialBags, MODEL_KINDS, modelKind, stateKeys } from './model-kinds';

const kinds = Object.values(MODEL_KINDS);

describe('MODEL_KINDS', () => {
  it('lists the P2 kinds, keyed by their own name', () => {
    expect(Object.keys(MODEL_KINDS).sort()).toStrictEqual([
      'battery',
      'breaker.thermalMagnetic',
      'fuse',
      'generator.portable',
      'heater',
      'lamp.incandescent',
      'lead',
      'resistor',
      'supply.bench',
      'supply.dinPsu',
      'switch.spst',
      'utility.splitPhase',
      'utility.threePhase',
    ]);
    for (const [name, kind] of Object.entries(MODEL_KINDS)) expect(kind.kind).toBe(name);
    expect(Object.isFrozen(MODEL_KINDS)).toBe(true);
  });

  it('pins every state key: owner, type and initial value (save format: changing one is a schemaVersion bump)', () => {
    const summary = Object.fromEntries(
      kinds.map((k) => [
        k.kind,
        Object.fromEntries(Object.entries(k.keys).map(([n, d]) => [n, `${d.owner} ${d.type} ${String(d.initial)}`])),
      ]),
    );
    expect(summary).toStrictEqual({
      battery: { stateOfCharge: 'sim number 1' },
      'breaker.thermalMagnetic': {
        on: 'commanded boolean false',
        thermal: 'sim number 0',
        tripped: 'sim boolean false',
      },
      fuse: { blown: 'sim boolean false', meltFraction: 'sim number 0' },
      'generator.portable': {},
      heater: {},
      'lamp.incandescent': { filamentTempK: 'sim number null' },
      lead: {},
      resistor: {},
      'supply.bench': {
        currentLimitA: 'commanded number 1',
        mode: 'sim enum cv',
        outputOn: 'commanded boolean false',
        setpointV: 'commanded number 12',
      },
      'supply.dinPsu': { mode: 'sim enum ok', phaseTicks: 'sim number 0' },
      'switch.spst': { closed: 'commanded boolean false' },
      'utility.splitPhase': {},
      'utility.threePhase': {},
    });
  });

  it('keys follow the bag key grammar, initial values pass their own schema, terminals are sorted', () => {
    for (const kind of kinds) {
      expect([...kind.terminals].sort(), kind.kind).toStrictEqual([...kind.terminals]);
      for (const [name, def] of Object.entries(kind.keys)) {
        expect(DEVICE_STATE_KEY_PATTERN.test(name) && name.length <= 64, `${kind.kind}.${name}`).toBe(true);
        expect(def.schema.safeParse(def.initial).success, `${kind.kind}.${name}`).toBe(true);
        expect(def.values, `${kind.kind}.${name}`).toBe(def.type === 'enum' ? def.values : null);
      }
      if (kind.placement === 'connection') {
        expect(kind.terminals, kind.kind).toStrictEqual([]);
        expect(kind.keys, kind.kind).toStrictEqual({});
      }
    }
  });

  it('every value a key schema accepts is a DeviceStateValue (property)', () => {
    const anyValue = fc.oneof(
      fc.double(),
      fc.boolean(),
      fc.string({ maxLength: 40 }),
      fc.constant(null),
      fc.constant(-0),
      fc.constantFrom(0, 1, 0.5, 293.15),
    );
    fc.assert(
      fc.property(anyValue, (value) => {
        for (const kind of kinds) {
          for (const def of Object.values(kind.keys)) {
            const parsed = def.schema.safeParse(value);
            if (parsed.success) expect(DeviceStateValue.safeParse(parsed.data).success).toBe(true);
          }
        }
      }),
    );
  });

  it('modelKind looks up own kinds only', () => {
    expect(modelKind('battery')).toBe(MODEL_KINDS['battery']);
    expect(modelKind('toString')).toBeUndefined();
    expect(modelKind('relay')).toBeUndefined();
  });
});

describe('device state bags', () => {
  const spst = MODEL_KINDS['switch.spst'];
  const battery = MODEL_KINDS['battery'];

  it('splits keys by owner', () => {
    expect(stateKeys(spst, 'commanded')).toStrictEqual(['closed']);
    expect(stateKeys(spst, 'sim')).toStrictEqual([]);
    expect(stateKeys(battery, 'sim')).toStrictEqual(['stateOfCharge']);
  });

  it('a new device starts with every key at its initial value', () => {
    expect(initialBags(spst)).toStrictEqual({ state: { closed: false }, sim: {} });
    expect(initialBags(battery)).toStrictEqual({ state: {}, sim: { stateOfCharge: 1 } });
    expect(initialBags(MODEL_KINDS['lamp.incandescent'])).toStrictEqual({ state: {}, sim: { filamentTempK: null } });
    for (const kind of kinds) {
      const bags = initialBags(kind);
      expect(checkBags(kind, bags.state, bags.sim)).toStrictEqual([]);
      const schemas = bagSchemas(kind);
      expect(schemas.state.parse(bags.state)).toStrictEqual(bags.state);
      expect(schemas.sim.parse(bags.sim)).toStrictEqual(bags.sim);
    }
  });

  it('checkBags reports missing, unknown, misplaced and invalid keys without echoing values', () => {
    expect(checkBags(spst, {}, {})).toStrictEqual([
      { path: 'state.closed', message: 'Missing (an absent value is null, never a missing key)' },
    ]);
    expect(checkBags(spst, { closed: 'secret-text' }, {})).toStrictEqual([
      { path: 'state.closed', message: 'Not a valid switch.spst closed value' },
    ]);
    expect(checkBags(spst, { closed: true, extra: 1 }, { closed: true })).toStrictEqual([
      { path: 'state.extra', message: 'Not a commanded key of model kind switch.spst' },
      { path: 'sim.closed', message: 'Not a sim key of model kind switch.spst' },
    ]);
    expect(checkBags(battery, {}, { stateOfCharge: 1.5 })).toStrictEqual([
      { path: 'sim.stateOfCharge', message: 'Not a valid battery stateOfCharge value' },
    ]);
    expect(checkBags(battery, { stateOfCharge: 1 }, {}).map((i) => i.path)).toStrictEqual([
      'state.stateOfCharge',
      'sim.stateOfCharge',
    ]);
  });

  it('bag schemas are strict', () => {
    expect(bagSchemas(spst).state.safeParse({ closed: true, extra: 1 }).success).toBe(false);
    expect(bagSchemas(spst).state.safeParse({}).success).toBe(false);
  });
});
