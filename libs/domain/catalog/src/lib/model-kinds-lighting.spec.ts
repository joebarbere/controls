import {
  DimmerParams,
  LampholderParams,
  LedDriverParams,
  LIGHTING_MODEL_KINDS,
  WallSwitchParams,
} from './model-kinds-lighting';
import { checkBags, initialBags, MODEL_KINDS } from './model-kinds';

/*
 * P4 F4.1 part 1's kinds (ADR 0019's key table): the terminals the simulator and the inspector name,
 * the parameter schemas, and that every kind is in MODEL_KINDS under its own name.
 */

const LED = { ratedVoltageV: 120, ratedPowerW: 9, powerFactor: 0.9, dropoutVoltageV: 90, restartVoltageV: 95 };

describe('the lighting model kinds (F4.1 part 1)', () => {
  it('are in MODEL_KINDS, keyed by their own name, with their terminals fixed (sorted)', () => {
    for (const [name, kind] of Object.entries(LIGHTING_MODEL_KINDS)) {
      expect(MODEL_KINDS[name]).toBe(kind);
      expect(kind.kind).toBe(name);
      expect(kind.placement).toBe('entity');
    }
    expect(Object.fromEntries(Object.values(LIGHTING_MODEL_KINDS).map((k) => [k.kind, k.terminals]))).toStrictEqual({
      'dimmer.wall': ['ground', 'line', 'load'],
      'lampholder.e26': ['ground', 'hot', 'neutral'],
      'lampholder.e26PullChain': ['centre', 'ground', 'hot', 'neutral'],
      'light.led': ['a', 'b'],
      'light.ledFixture': ['ground', 'hot', 'neutral'],
      'switch.wall1p': ['a', 'b', 'ground'],
      'switch.wall3way': ['common', 'ground', 't1', 't2'],
      'switch.wall4way': ['a1', 'a2', 'b1', 'b2', 'ground'],
    });
    expect(Object.isFrozen(LIGHTING_MODEL_KINDS)).toBe(true);
  });

  it('start a new device at its initial values (ADR 0019), which their own bag check accepts', () => {
    for (const kind of Object.values(LIGHTING_MODEL_KINDS)) {
      const bags = initialBags(kind);
      expect(checkBags(kind, bags.state, bags.sim), kind.kind).toStrictEqual([]);
    }
    expect(initialBags(LIGHTING_MODEL_KINDS['dimmer.wall'])).toStrictEqual({ state: { level: 1, on: false }, sim: {} });
    // The pull-chain holder's one key (ADR 0019 as amended in P4 PR 12); the keyless holder has none.
    expect(initialBags(LIGHTING_MODEL_KINDS['lampholder.e26PullChain'])).toStrictEqual({
      state: { closed: false },
      sim: {},
    });
    expect(LIGHTING_MODEL_KINDS['lampholder.e26PullChain'].sealedTerminals).toStrictEqual(['centre']);
    expect(LIGHTING_MODEL_KINDS['lampholder.e26'].keys).toStrictEqual({});
    expect(initialBags(LIGHTING_MODEL_KINDS['light.led'])).toStrictEqual({
      state: {},
      sim: { overvoltageSinceTick: null, running: false },
    });
  });

  it('refuse a dimmer level outside 0–1, a 3-way position that is not a traveller, a negative since-tick', () => {
    const dimmer = LIGHTING_MODEL_KINDS['dimmer.wall'];
    expect(checkBags(dimmer, { level: 1.01, on: true }, {}).map((i) => i.path)).toStrictEqual(['state.level']);
    expect(checkBags(dimmer, { level: -0.01, on: true }, {}).map((i) => i.path)).toStrictEqual(['state.level']);
    const threeWay = LIGHTING_MODEL_KINDS['switch.wall3way'];
    expect(checkBags(threeWay, { position: 'common' }, {}).map((i) => i.path)).toStrictEqual(['state.position']);
    const fourWay = LIGHTING_MODEL_KINDS['switch.wall4way'];
    expect(checkBags(fourWay, { position: 'crossed' }, {})).toStrictEqual([]);
    const led = LIGHTING_MODEL_KINDS['light.ledFixture'];
    expect(checkBags(led, {}, { overvoltageSinceTick: -1, running: false }).map((i) => i.path)).toStrictEqual([
      'sim.overvoltageSinceTick',
    ]);
  });

  it('parameter schemas: positive nameplates; the LED band must sit below its rated voltage', () => {
    expect(WallSwitchParams.safeParse({ ratedCurrentA: 15, ratedVoltageV: 120 }).success).toBe(true);
    expect(WallSwitchParams.safeParse({ ratedCurrentA: 0, ratedVoltageV: 120 }).success).toBe(false);
    expect(DimmerParams.safeParse({ ratedVoltageV: 120, ratedPowerW: 600 }).success).toBe(true);
    expect(LampholderParams.safeParse({ ratedVoltageV: 250, ratedPowerW: 660, extra: 1 }).success).toBe(false);
    expect(LedDriverParams.safeParse(LED).success).toBe(true);
    expect(LedDriverParams.safeParse({ ...LED, powerFactor: 0 }).success).toBe(false);
    expect(LedDriverParams.safeParse({ ...LED, powerFactor: 1 }).success).toBe(true);
    expect(LedDriverParams.safeParse({ ...LED, powerFactor: 1.1 }).success).toBe(false);
    expect(LedDriverParams.safeParse({ ...LED, restartVoltageV: 90 }).success).toBe(false);
    expect(LedDriverParams.safeParse({ ...LED, restartVoltageV: 120 }).success).toBe(false);
  });
});
