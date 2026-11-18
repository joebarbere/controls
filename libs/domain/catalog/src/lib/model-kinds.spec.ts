import { DEVICE_STATE_KEY_PATTERN, DeviceStateValue } from '@controls/save-format';
import fc from 'fast-check';
import {
  bagSchemas,
  checkBags,
  CONDUCTOR_SIM_KEYS,
  CONNECTION_SIM_KEYS,
  initialBags,
  MODEL_KINDS,
  modelKind,
  stateKeys,
} from './model-kinds';

const kinds = Object.values(MODEL_KINDS);

describe('MODEL_KINDS', () => {
  it('lists the P2 kinds, F3.1’s conductor, the F3.5 enclosure, raceway and terminal-block kinds, F3.3’s twist-on splice, engine 8’s service and ground rod and the breakers v2 kinds, keyed by their own name', () => {
    expect(Object.keys(MODEL_KINDS).sort()).toStrictEqual([
      'battery',
      'breaker.afci1p',
      'breaker.gfci1p',
      'breaker.plugOn1p',
      'breaker.plugOn2p',
      'breaker.thermalMagnetic',
      'conductor',
      'electrode.groundRod',
      'enclosure.box',
      'enclosure.panel',
      'fuse',
      'generator.portable',
      'heater',
      'lamp.incandescent',
      'lead',
      'raceway.conduit',
      'raceway.conduitConnector',
      'raceway.conduitElbow',
      'raceway.duct',
      'resistor',
      'service.splitPhase',
      'splice.twistOn',
      'supply.bench',
      'supply.dinPsu',
      'switch.spst',
      'terminalBlock.feedThrough',
      'terminalBlock.ground',
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
      // P4 PR 10 (ADR 0019's table, finalised by ADR 0021 part 2): breakers v2, GFCI and AFCI breakers.
      'breaker.afci1p': {
        arcExposure: 'sim number 0',
        arcLastSeenTick: 'sim number null',
        magneticSinceTick: 'sim number null',
        on: 'commanded boolean false',
        test: 'commanded counter 0',
        thermal: 'sim number 0',
        tripCause: 'sim enum null',
        tripped: 'sim boolean false',
      },
      'breaker.gfci1p': {
        magneticSinceTick: 'sim number null',
        on: 'commanded boolean false',
        residualIntegral: 'sim number 0',
        residualSinceTick: 'sim number null',
        test: 'commanded counter 0',
        testHeldSinceTick: 'sim number null',
        thermal: 'sim number 0',
        tripCause: 'sim enum null',
        tripped: 'sim boolean false',
      },
      'breaker.plugOn1p': {
        magneticSinceTick: 'sim number null',
        on: 'commanded boolean false',
        thermal: 'sim number 0',
        tripCause: 'sim enum null',
        tripped: 'sim boolean false',
      },
      'breaker.plugOn2p': {
        magneticSinceTick: 'sim number null',
        on: 'commanded boolean false',
        thermalL1: 'sim number 0',
        thermalL2: 'sim number 0',
        tripCause: 'sim enum null',
        tripped: 'sim boolean false',
      },
      // F3.5 (ADR 0015, D11): the commanded knockout bit set; provisional until v0.4.0.
      'enclosure.box': { openEntries: 'commanded number 0' },
      'enclosure.panel': { openEntries: 'commanded number 0' },
      fuse: { blown: 'sim boolean false', bodyHeat: 'sim number 0', elementHeat: 'sim number 0' },
      'generator.portable': {},
      // Engine 8 (P4 PR 9): the service and the ground rod hold no state.
      'electrode.groundRod': {},
      'service.splitPhase': {},
      heater: {},
      // F3.1: the conductor kind shares the lead's ten connection sim keys (ADR 0015, ADR 0016), plus the
      // sticky `fused` (an eleventh, added while world v3 is provisional: a melted conductor stays open).
      conductor: {
        conductorTempK: 'sim number null',
        endADegradation: 'sim number 1',
        endAState: 'sim enum ok',
        endATempK: 'sim number null',
        endATerminationId: 'sim number null',
        endBDegradation: 'sim number 1',
        endBState: 'sim enum ok',
        endBTempK: 'sim number null',
        endBTerminationId: 'sim number null',
        fused: 'sim boolean false',
        insulationDamaged: 'sim boolean false',
      },
      'lamp.incandescent': {
        burnedOut: 'sim boolean false',
        filamentTempK: 'sim number null',
        overvoltageSinceTick: 'sim number null',
      },
      // ADR 0015: the connection sim keys (world v3's ConnectionV3.sim), provisional until v0.4.0.
      lead: {
        conductorTempK: 'sim number null',
        endADegradation: 'sim number 1',
        endAState: 'sim enum ok',
        endATempK: 'sim number null',
        endATerminationId: 'sim number null',
        endBDegradation: 'sim number 1',
        endBState: 'sim enum ok',
        endBTempK: 'sim number null',
        endBTerminationId: 'sim number null',
        insulationDamaged: 'sim boolean false',
      },
      // F3.5 part 2: the cut length (placed at the entry's defaultLengthMm, so this initial is a
      // placeholder) and the duct's cover; provisional until v0.4.0.
      'raceway.conduit': { lengthMm: 'commanded number 1000' },
      'raceway.conduitConnector': {},
      'raceway.conduitElbow': {},
      'raceway.duct': { coverOn: 'commanded boolean false', lengthMm: 'commanded number 1000' },
      resistor: {},
      'splice.twistOn': {},
      'supply.bench': {
        currentLimitA: 'commanded number 1',
        mode: 'sim enum cv',
        outputOn: 'commanded boolean false',
        setpointV: 'commanded number 12',
      },
      'supply.dinPsu': { mode: 'sim enum ok', phaseTicks: 'sim number 0' },
      'switch.spst': { closed: 'commanded boolean false' },
      'terminalBlock.feedThrough': {},
      'terminalBlock.ground': {},
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
        // A connection has no terminals, and in P3 no commanded keys (ADR 0015: `state` is {}).
        expect(kind.terminals, kind.kind).toStrictEqual([]);
        expect(stateKeys(kind, 'commanded'), kind.kind).toStrictEqual([]);
      }
      if (kind.requires === 'enclosure') {
        expect(kind.keys['openEntries']?.owner, kind.kind).toBe('commanded');
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

  it('the lead kind holds the ten connection sim keys of ADR 0015, ends A and B alike', () => {
    const lead = MODEL_KINDS['lead'];
    expect(lead.keys).toBe(CONNECTION_SIM_KEYS);
    expect(stateKeys(lead, 'sim')).toHaveLength(10);
    expect(lead.keys['endAState'].values).toStrictEqual(['ok', 'intermittentClosed', 'intermittentOpen', 'arcing']);
    expect(lead.keys['endADegradation'].schema.safeParse(0.99).success).toBe(false);
    expect(lead.keys['endATerminationId'].schema.safeParse(1.5).success).toBe(false);
    expect(lead.keys['endATerminationId'].schema.safeParse(7).success).toBe(true);
    for (const name of ['TempK', 'Degradation', 'TerminationId', 'State']) {
      const [a, b] = [lead.keys[`endA${name}`], lead.keys[`endB${name}`]];
      expect([b.owner, b.type, b.initial, b.values]).toStrictEqual([a.owner, a.type, a.initial, a.values]);
    }
  });

  it('the conductor kind (F3.1) is a conductor connection kind on the ten keys and a sticky `fused`; its only param is the lay factor', () => {
    const conductor = MODEL_KINDS['conductor'];
    expect([conductor.placement, conductor.requires, conductor.terminals]).toStrictEqual([
      'connection',
      'conductor',
      [],
    ]);
    expect(conductor.keys).toBe(CONDUCTOR_SIM_KEYS);
    expect(Object.keys(CONDUCTOR_SIM_KEYS).sort()).toStrictEqual([...Object.keys(CONNECTION_SIM_KEYS), 'fused'].sort());
    for (const name of Object.keys(CONNECTION_SIM_KEYS))
      expect(CONDUCTOR_SIM_KEYS[name]).toBe(CONNECTION_SIM_KEYS[name]);
    expect([
      conductor.keys['fused'].owner,
      conductor.keys['fused'].type,
      conductor.keys['fused'].initial,
    ]).toStrictEqual(['sim', 'boolean', false]);
    expect(conductor.params.safeParse({ layFactor: 1 }).success).toBe(true);
    expect(conductor.params.safeParse({ layFactor: 1.02 }).success).toBe(true);
    expect(conductor.params.safeParse({ layFactor: 0.99 }).success).toBe(false);
    expect(conductor.params.safeParse({ layFactor: 1.2 }).success).toBe(false);
    expect(conductor.params.safeParse({ layFactor: 1, resistivityOhmM: 1.7e-8 }).success).toBe(false);
  });

  describe('breakers v2 (P4 D6, ADR 0021 part 2)', () => {
    const plugOn = {
      ratedCurrentA: 20,
      thermalTimeConstantS: 60,
      ultimateTripRatio: 1.25,
      magneticPickupMinA: 240,
      magneticPickupMaxA: 400,
      openingTimeMinMs: 8,
      openingTimeMaxMs: 20,
      contactResistanceOhm: 0.005,
    };
    const gfci = {
      ...plugOn,
      residualPickupMinA: 0.004,
      residualPickupMaxA: 0.006,
      mechanismTimeMinMs: 3,
      mechanismTimeMaxMs: 14,
      testResistanceOhm: 3900,
    };
    const parses = (kind: string, params: object) => MODEL_KINDS[kind].params.safeParse(params).success;

    it('the plug-on pickup is an absolute band in amperes: the DIN entry’s “near ten times” ratio fields are refused', () => {
      for (const kind of ['breaker.plugOn1p', 'breaker.plugOn2p', 'breaker.afci1p']) {
        expect(parses(kind, plugOn), kind).toBe(true);
        expect(parses(kind, { ...plugOn, magneticTripMinRatio: 8, magneticTripMaxRatio: 12 }), kind).toBe(false);
      }
      expect(parses('breaker.gfci1p', gfci)).toBe(true);
      expect(parses('breaker.gfci1p', plugOn)).toBe(false);
    });

    it('refuses an inverted band, a pickup at or below k_u I_n, an inverted opening or mechanism time, an inverted residual band', () => {
      expect(parses('breaker.plugOn1p', { ...plugOn, magneticPickupMaxA: 240 })).toBe(false);
      expect(parses('breaker.plugOn1p', { ...plugOn, magneticPickupMinA: 25, magneticPickupMaxA: 30 })).toBe(false);
      expect(parses('breaker.plugOn1p', { ...plugOn, openingTimeMaxMs: 7 })).toBe(false);
      expect(parses('breaker.plugOn1p', { ...plugOn, ultimateTripRatio: 1.4 })).toBe(false);
      // k_u = 1.35 would never trip at 135 % (UL 489's 1 h ceiling): strictly below it, on every v2 kind.
      for (const kind of ['breaker.plugOn1p', 'breaker.plugOn2p', 'breaker.afci1p']) {
        expect(parses(kind, { ...plugOn, ultimateTripRatio: 1.35 }), kind).toBe(false);
        expect(parses(kind, { ...plugOn, ultimateTripRatio: 1.349 }), kind).toBe(true);
      }
      expect(parses('breaker.gfci1p', { ...gfci, ultimateTripRatio: 1.35 })).toBe(false);
      // The frozen DIN kind keeps its P2 bound (at most 1.35).
      expect(
        parses('breaker.thermalMagnetic', {
          ratedCurrentA: 15,
          thermalTimeConstantS: 60,
          ultimateTripRatio: 1.35,
          magneticTripMinRatio: 8,
          magneticTripMaxRatio: 12,
          contactResistanceOhm: 0.01,
        }),
      ).toBe(true);
      expect(parses('breaker.gfci1p', { ...gfci, residualPickupMaxA: 0.004 })).toBe(false);
      expect(parses('breaker.gfci1p', { ...gfci, mechanismTimeMaxMs: 2 })).toBe(false);
    });

    it('tripCause takes the five causes or null; the since-ticks are null or a tick; the exposure and integral stay in 0–1', () => {
      const keys = MODEL_KINDS['breaker.afci1p'].keys;
      expect(keys['tripCause'].values).toStrictEqual(['thermal', 'magnetic', 'groundFault', 'arcFault', 'test']);
      for (const cause of [...(keys['tripCause'].values ?? []), null]) {
        expect(keys['tripCause'].schema.safeParse(cause).success).toBe(true);
      }
      expect(keys['tripCause'].schema.safeParse('overload').success).toBe(false);
      expect(keys['magneticSinceTick'].schema.safeParse(1.5).success).toBe(false);
      expect(keys['arcExposure'].schema.safeParse(1.01).success).toBe(false);
      expect(MODEL_KINDS['breaker.gfci1p'].keys['residualIntegral'].schema.safeParse(1).success).toBe(true);
      expect(MODEL_KINDS['breaker.gfci1p'].keys['residualIntegral'].schema.safeParse(1.01).success).toBe(false);
    });
  });

  it("the load check: a conductor's bag needs `fused` (any value, whatever its ends), a lead's never has it", () => {
    const conductor = MODEL_KINDS['conductor'];
    const lead = MODEL_KINDS['lead'];
    const ten = initialBags(lead).sim;
    expect(checkBags(conductor, {}, ten)).toStrictEqual([
      { path: 'sim.fused', message: 'Missing (an absent value is null, never a missing key)' },
    ]);
    // A fused conductor whose ends were re-made: new terminations, D = 1, both `ok` (still open).
    const remade = { ...ten, fused: true, endATerminationId: 3, endBTerminationId: 4 };
    expect(checkBags(conductor, {}, remade)).toStrictEqual([]);
    expect(checkBags(conductor, {}, { ...ten, fused: 'yes' })).toStrictEqual([
      { path: 'sim.fused', message: 'Not a valid conductor fused value' },
    ]);
    expect(checkBags(lead, {}, { ...ten, fused: false })).toStrictEqual([
      { path: 'sim.fused', message: 'Not a sim key of model kind lead' },
    ]);
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
    expect(initialBags(MODEL_KINDS['lamp.incandescent'])).toStrictEqual({
      state: {},
      sim: { burnedOut: false, filamentTempK: null, overvoltageSinceTick: null },
    });
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
