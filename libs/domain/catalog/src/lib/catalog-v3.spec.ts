import { DeviceStateBagV4, Int, MAX_DEVICE_STATE_KEYS } from '@controls/save-format';
import * as z from 'zod';
import { BUILTIN_CATALOG } from './builtin';
import { type CatalogInput, checkControlValue, offeredMounts, parseCatalog } from './catalog';
import { type DeviceControl, MAX_PANEL_SPACES } from './device';
import { checkBags, counterKey, initialBags, MODEL_KINDS, type ModelKindDef, textKey } from './model-kinds';
import { NEC_REGION } from './region';
import {
  AREA_USES,
  areaUse,
  AreaUseId,
  ContactId,
  MOUNT_TYPES,
  NEMA_CONFIGS,
  nemaConfig,
  NemaConfigId,
  nemaMates,
  PinId,
} from './registries';
import { ARTICLE_PATTERN } from './rules';
import { coversPath } from './sources';

/*
 * Catalogue format v3 (P4, ADR 0020), proved on TEST-ONLY fixtures: terminal roles and access, the
 * multi-conductor cap, terminal families, mount contacts and anchors, bus patterns and panel spaces,
 * host mounts on a non-enclosure device, outlets and plugs over NEMA_CONFIGS, `supersededBy`, the
 * `text` and `counter` key types and the momentary control, and inspector rule sets. Nothing here is
 * a real product; every number is `game-design: test`. Each test breaks one rule of a valid catalogue.
 */

const openEntries = {
  owner: 'commanded',
  type: 'number',
  schema: Int.min(0).max(0xffffffff),
  initial: 0,
  values: null,
  description: 'test',
} as const;

/** Synthetic kinds standing in for P4's (which land with their content PRs). */
const KINDS: Readonly<Record<string, ModelKindDef>> = {
  ...MODEL_KINDS,
  'test.device': {
    kind: 'test.device',
    placement: 'entity',
    terminals: ['a', 'b', 'ground'],
    params: z.strictObject({}),
    keys: {
      test: counterKey('test'),
      note: textKey('test'),
      on: { owner: 'commanded', type: 'boolean', schema: z.boolean(), initial: false, values: null, description: 't' },
    },
    description: 'test',
  },
  'test.panel': {
    kind: 'test.panel',
    placement: 'entity',
    requires: 'enclosure',
    terminals: ['busL1', 'busL2', 'chassis'],
    terminalFamilies: [{ prefix: 'n', min: 2, max: 30 }],
    params: z.strictObject({}),
    keys: { openEntries },
    description: 'test',
  },
};

const source = (covers: string[]) => [{ id: 'test', kind: 'game-design', citation: 'game-design: test', covers }];
const at = (x: number) => ({ x, y: 0, z: 0 });
const terminal = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: id,
  positionMm: at(0),
  methods: [],
  role: null,
  side: null,
  access: 'clip',
  ...extra,
});

/** A valid device of `test.device`: terminals a, b, ground; no mounts, outlets or plug. */
function device(overrides: Record<string, unknown> = {}, covers: string[] = []): Record<string, unknown> {
  return {
    id: 'device.test',
    version: 1,
    title: 'Test device',
    brand: 'Testbrand',
    modelName: 'D-1',
    category: 'load',
    sizeMm: { widthMm: 20, heightMm: 20, depthMm: 20 },
    terminals: [terminal('a'), terminal('b'), terminal('ground')],
    mounts: [],
    enclosure: null,
    hostMounts: [],
    outlets: [],
    plug: null,
    supersededBy: null,
    conductor: null,
    model: { kind: 'test.device', params: {} },
    controls: [],
    sources: source(['sizeMm', 'terminals', ...covers]),
    extensions: {},
    ...overrides,
  };
}

/** A valid two-column panel of `test.panel`: two 3-stab bus columns, four spaces, n1 … n3. */
function panel(overrides: Record<string, unknown> = {}, covers: string[] = []): Record<string, unknown> {
  const column = (id: string, x: number, legs: [string, string]) => ({
    id,
    type: 'busStab',
    positionMm: at(x),
    axis: '-y',
    facing: '+z',
    extentMm: 50,
    contacts: [],
    bus: { pitchMm: 25, stabs: 3, legs },
  });
  return {
    ...device(),
    id: 'panel.test',
    category: 'enclosure',
    terminals: ['busL1', 'busL2', 'chassis', 'n1', 'n2', 'n3'].map((id) => terminal(id)),
    enclosure: {
      mounts: [
        column('left', 0, ['busL1', 'busL2']),
        column('right', 40, ['busL1', 'busL2']),
        {
          id: 'mbj',
          type: 'mbj',
          positionMm: at(80),
          axis: '+x',
          facing: '+z',
          extentMm: 0,
          contacts: [
            { id: 'neutral', terminal: 'n1' },
            { id: 'chassis', terminal: 'chassis' },
          ],
          bus: null,
        },
      ],
      entries: [],
      interiorVolumeMm3: 1000000,
      markedVolumeMm3: null,
      material: 'steel',
      spaces: [
        { mount: 'left', index: 0 },
        { mount: 'right', index: 0 },
        { mount: 'left', index: 1 },
        { mount: 'right', index: 1 },
      ],
    },
    model: { kind: 'test.panel', params: {} },
    sources: source(['sizeMm', 'terminals', 'mounts', 'interiorVolumeMm3', 'material', 'spaces', ...covers]),
    ...overrides,
  };
}

function messages(input: CatalogInput | unknown[]): string[] {
  const result = parseCatalog(3, input, KINDS);
  return result.ok ? [] : result.issues.map((i) => `${i.path}: ${i.message}`);
}
const ok = (input: CatalogInput | unknown[]) => expect(messages(input)).toStrictEqual([]);

describe('catalogue format v3 (ADR 0020) on test fixtures', () => {
  it('accepts the valid fixtures', () => {
    ok([device(), panel()]);
  });

  describe('terminals', () => {
    it('are "land" exactly when they have methods', () => {
      const lands = device({ terminals: [terminal('a', { access: 'land' }), terminal('b'), terminal('ground')] });
      expect(messages([lands]).join()).toContain('terminals.a.access: A terminal is "land" exactly when');
      ok([device({ terminals: [terminal('a', { access: 'none' }), terminal('b'), terminal('ground')] })]);
    });

    it('take a role and a side, read by the inspector only (any combination loads)', () => {
      const roled = device({
        terminals: [
          terminal('a', { role: 'ungrounded', side: 'line' }),
          terminal('b', { role: 'grounded', side: 'load' }),
          terminal('ground', { role: 'egc' }),
        ],
      });
      ok([roled]);
      expect(messages([device({ terminals: [terminal('a', { role: 'neutral' })] })]).join()).toContain('role');
    });

    it('a kind with a terminal family takes 1 … n of it, n in [min, max], with no gap', () => {
      ok([panel()]);
      const terminals = (ids: string[]) => ids.map((id) => terminal(id));
      const withNeutrals = (ns: string[]) => panel({ terminals: terminals(['busL1', 'busL2', 'chassis', ...ns]) });
      expect(messages([withNeutrals(['n1'])]).join()).toContain('numbers n1 … nn with n from 2 to 30');
      expect(messages([withNeutrals(['n1', 'n3'])]).join()).toContain(
        'needs exactly the terminals [busL1, busL2, chassis, n1 … nn]',
      );
      expect(messages([withNeutrals(['n1', 'n2', 'x'])]).join()).toContain('needs exactly the terminals');
    });
  });

  describe('the multi-conductor cap', () => {
    const screw = {
      method: 'screw',
      ratedConductors: 1,
      maxConductors: 2,
      awgRange: { smallest: 22, largest: 10 },
      stranding: ['solid'],
      stripLengthMm: { nominal: 9, tolerance: 1 },
      torqueNm: 0.6,
      drives: ['slotted'],
      alRated: false,
      entryMm: at(0),
      exitAxis: '+y',
      clampType: 'boxLug',
      clampDepthMm: 8,
      contactOhm: 0.0003,
      heatPathWPerK: 0.026,
      hotSpotHeatCapacityJPerK: 0.5,
      combination: null,
      multiConductor: { awgRange: { smallest: 22, largest: 16 }, equalSize: true },
    };
    const capped = (spec: Record<string, unknown>, covers = ['terminals.a.methods.screw']) =>
      device(
        { terminals: [terminal('a', { methods: [spec], access: 'land' }), terminal('b'), terminal('ground')] },
        covers,
      );

    it('loads inside the method range with two or more conductors, and needs a source', () => {
      ok([capped(screw)]);
      expect(messages([capped({ ...screw, maxConductors: 1 })]).join()).toContain('needs maxConductors of at least 2');
      const wide = { ...screw, multiConductor: { awgRange: { smallest: 24, largest: 16 }, equalSize: true } };
      expect(messages([capped(wide)]).join()).toContain(
        "multiConductor.awgRange must lie inside the method's awgRange",
      );
      const fields = [
        'ratedConductors',
        'maxConductors',
        'awgRange',
        'stranding',
        'stripLengthMm',
        'alRated',
        'entryMm',
      ]
        .concat(['exitAxis', 'clampType', 'clampDepthMm', 'contactOhm', 'heatPathWPerK', 'hotSpotHeatCapacityJPerK'])
        .concat(['torqueNm', 'drives'])
        .map((f) => `terminals.a.methods.screw.${f}`);
      expect(messages([capped(screw, fields)]).join()).toContain(
        'terminals.a.methods.screw.multiConductor: Has no source',
      );
    });
  });

  describe('mount contacts and anchors', () => {
    const fit = (overrides: Record<string, unknown> = {}) => ({
      type: 'busStab',
      widthMm: 25,
      crossMm: 0,
      alongMm: 0,
      contacts: [
        { id: 'l1', terminal: 'a', host: 'stab', positionOffset: 0, contactOhm: 0.005 },
        { id: 'l2', terminal: 'b', host: 'stab', positionOffset: 1, contactOhm: 0.005 },
      ],
      ...overrides,
    });
    const fitted = (f: Record<string, unknown>, covers = ['fits.busStab', 'fits.busStab.contacts']) =>
      device({ mounts: [f] }, covers);

    it('a two-pole fit steps its second contact one stab along the bus', () => {
      ok([fitted(fit())]);
    });

    it('contacts name a terminal of the device, a host contact of the type, an offset only on a bus', () => {
      const bad = fit({
        contacts: [{ id: 'l1', terminal: 'zz', host: 'shell', positionOffset: 0, contactOhm: 0.005 }],
      });
      const found = messages([fitted(bad)]).join();
      expect(found).toContain('No terminal "zz" on this entry');
      expect(found).toContain('offers the host contacts [stab], not "shell"');
      const yoke = {
        type: 'deviceYoke',
        widthMm: 20,
        crossMm: 0,
        alongMm: 0,
        contacts: [{ id: 'bond', terminal: 'ground', host: 'chassis', positionOffset: 1, contactOhm: 0.001 }],
      };
      expect(messages([device({ mounts: [yoke] }, ['fits.deviceYoke', 'fits.deviceYoke.contacts'])]).join()).toContain(
        'positionOffset steps along a bus only',
      );
      const twice = fit({ contacts: [fit().contacts[0], fit().contacts[0]] });
      expect(messages([fitted(twice)]).join()).toContain('Contact ids must be unique within a fit');
    });

    it('a single mount takes an anchor; along is refused off a single mount, cross on an area mount', () => {
      const e26 = { type: 'e26', widthMm: 20, crossMm: 3, alongMm: -4, contacts: [] };
      ok([device({ mounts: [e26] }, ['fits.e26'])]);
      expect(messages([fitted(fit({ alongMm: 5 }))]).join()).toContain(
        'alongMm anchors a device on a single mount only',
      );
    });

    it('`fits.<type>` covers the layout but never a contact’s resistance (sources.ts)', () => {
      expect(coversPath('fits.busStab', 'fits.busStab')).toBe(true);
      expect(coversPath('fits.busStab', 'fits.busStab.contacts.l1.contactOhm')).toBe(false);
      expect(coversPath('fits.*', 'fits.busStab.contacts.l1.contactOhm')).toBe(false);
      expect(coversPath('fits.busStab.contacts', 'fits.busStab.contacts.l1.contactOhm')).toBe(true);
      const found = messages([fitted(fit(), ['fits.busStab'])]).join();
      expect(found).toContain('fits.busStab.contacts.l1.contactOhm: Has no source');
      expect(found).toContain('fits.busStab.contacts.l2.contactOhm: Has no source');
    });
  });

  describe('host mounts, bus patterns and panel spaces', () => {
    const mounts = (p: Record<string, unknown>) => (p['enclosure'] as { mounts: Record<string, unknown>[] }).mounts;
    const withMount = (i: number, change: Record<string, unknown>) => {
      const p = panel();
      mounts(p)[i] = { ...mounts(p)[i], ...change };
      return p;
    };

    it('a bus mount has its pattern, two different legs that are terminals, and its stabs within its extent', () => {
      expect(messages([withMount(0, { bus: null })]).join()).toContain('A busStab mount needs its bus pattern');
      expect(messages([withMount(2, { bus: { pitchMm: 25, stabs: 1, legs: ['busL1', 'busL2'] } })]).join()).toContain(
        'Only a bus mount has a bus pattern',
      );
      const legs = withMount(0, { bus: { pitchMm: 25, stabs: 3, legs: ['busL1', 'busL1'] } });
      expect(messages([legs]).join()).toContain('A bus alternates between two different legs');
      const far = withMount(0, { bus: { pitchMm: 25, stabs: 4, legs: ['busL1', 'busL2'] } });
      expect(messages([far]).join()).toContain("The last stab lies beyond the mount's extent");
      const stab = withMount(0, { contacts: [{ id: 'stab', terminal: 'busL1' }] });
      expect(messages([stab]).join()).toContain('reach their legs through its bus pattern');
    });

    it('host contacts are the type’s, each once, onto terminals of the host', () => {
      const wrong = withMount(2, { contacts: [{ id: 'shell', terminal: 'zz' }] });
      const found = messages([wrong]).join();
      expect(found).toContain('offers the host contacts [neutral, chassis], not "shell"');
      expect(found).toContain('No terminal "zz" on this entry');
    });

    it('panel spaces are stabs of the enclosure’s bus mounts, each once', () => {
      const spaces = (list: unknown[]) => {
        const p = panel();
        (p['enclosure'] as Record<string, unknown>)['spaces'] = list;
        return p;
      };
      expect(messages([spaces([{ mount: 'mbj', index: 0 }])]).join()).toContain(`"mbj" isn't a bus mount`);
      expect(messages([spaces([{ mount: 'left', index: 3 }])]).join()).toContain('has 3 stabs');
      expect(
        messages([
          spaces([
            { mount: 'left', index: 0 },
            { mount: 'left', index: 0 },
          ]),
        ]).join(),
      ).toContain('Each stab is one space');
    });

    it('a non-enclosure device offers a mount through hostMounts; an enclosure never does', () => {
      const socket = {
        id: 'socket',
        type: 'e26',
        positionMm: at(0),
        axis: '+x',
        facing: '+z',
        extentMm: 0,
        contacts: [
          { id: 'shell', terminal: 'a' },
          { id: 'centre', terminal: 'b' },
        ],
        bus: null,
      };
      const holder = device({ hostMounts: [socket] }, ['mounts.socket']);
      ok([holder]);
      const parsed = parseCatalog(3, [holder], KINDS);
      if (!parsed.ok) throw new Error('invalid');
      expect(offeredMounts(parsed.catalog.devices[0]).map((m) => m.id)).toStrictEqual(['socket']);
      expect(messages([panel({ hostMounts: [socket] }, ['mounts.socket'])]).join()).toContain(
        'An enclosure offers its mounts in enclosure.mounts',
      );
      expect(messages([device({ hostMounts: [{ ...socket, id: 'a' }] }, ['mounts.a'])]).join()).toContain(
        'Terminal and mount ids must be unique',
      );
      expect(messages([device({ hostMounts: [socket] })]).join()).toContain('mounts.socket: Has no source');
    });
  });

  describe('outlets and plugs', () => {
    const slots = ['hot', 'neutral', 'ground'];
    const outlet = (id: string, config = '5-20R', pins = slots) => ({
      id,
      config,
      positionMm: at(0),
      contactOhm: 0.002,
      pins: pins.map((pin, i) => ({ pin, terminal: ['a', 'b', 'ground'][i] })),
    });
    const outletCovers = (ids: string[]) =>
      ids.flatMap((id) => ['config', 'positionMm', 'pins', 'contactOhm'].map((f) => `outlets.${id}.${f}`));
    const plug = {
      config: '5-15P',
      cordAwg: 16,
      cordLengthMm: 1800,
      cordExitMm: at(0),
      pins: slots.map((pin, i) => ({ pin, terminal: ['a', 'b', 'ground'][i] })),
    };
    const plugCovers = ['config', 'cordAwg', 'cordLengthMm', 'cordExitMm', 'pins'].map((f) => `plug.${f}`);

    it('an outlet maps every slot of a receptacle configuration to a methodless terminal', () => {
      ok([device({ outlets: [outlet('top'), outlet('bottom')] }, outletCovers(['top', 'bottom']))]);
      expect(messages([device({ outlets: [outlet('top', '5-15P')] }, outletCovers(['top']))]).join()).toContain(
        `"5-15P" isn't a receptacle configuration`,
      );
      expect(
        messages([device({ outlets: [outlet('top', '5-20R', ['hot', 'neutral'])] }, outletCovers(['top']))]).join(),
      ).toContain('A 5-20R has the pins [hot, neutral, ground], each mapped once');
      expect(messages([device({ outlets: [outlet('top'), outlet('top')] }, outletCovers(['top']))]).join()).toContain(
        'Outlet ids must be unique',
      );
      expect(messages([device({ outlets: [outlet('top')] }, ['outlets.top.config'])]).join()).toContain(
        'outlets.top.contactOhm: Has no source',
      );
    });

    it('a plug maps every blade of a plug configuration; an entry with a plug fits no mount', () => {
      ok([device({ plug }, plugCovers)]);
      expect(messages([device({ plug: { ...plug, config: '5-15R' } }, plugCovers)]).join()).toContain(
        `"5-15R" isn't a plug configuration`,
      );
      const landed = device(
        { plug, terminals: [terminal('a', { methods: [], access: 'clip' }), terminal('b'), terminal('ground')] },
        plugCovers,
      );
      ok([landed]);
      const mounted = device(
        { plug, mounts: [{ type: 'deviceYoke', widthMm: 20, crossMm: 0, alongMm: 0, contacts: [] }] },
        [...plugCovers, 'fits.deviceYoke'],
      );
      expect(messages([mounted]).join()).toContain('An entry with a plug fits no mount');
      expect(messages([device({ plug: { ...plug, cordAwg: 50 } }, plugCovers)]).join()).toContain('cordAwg');
    });
  });

  describe('supersededBy', () => {
    it('names another device entry of the catalogue, never looping', () => {
      const v1 = device({ supersededBy: { id: 'device.test', version: 2 } });
      const v2 = device({ version: 2 });
      ok([v1, v2]);
      expect(messages([v1]).join()).toContain(`device.test@2 isn't a device entry of this catalogue`);
      const loop = device({ version: 2, supersededBy: { id: 'device.test', version: 1 } });
      expect(messages([v1, loop]).join()).toContain('supersededBy loops back');
      expect(messages([device({ supersededBy: { id: 'device.test', version: 1 } })]).join()).toContain('loops back');
    });
  });

  describe('text and counter keys, and the momentary control', () => {
    const press: DeviceControl = { id: 'test', label: 'Test', type: 'momentary' };

    it('a momentary control drives a counter key, and never takes a value', () => {
      ok([device({ controls: [press] })]);
      expect(messages([device({ controls: [{ ...press, id: 'on' }] })]).join()).toContain(
        'A momentary control needs a counter key',
      );
      expect(messages([device({ controls: [{ id: 'test', label: 'T', type: 'toggle' }] })]).join()).toContain(
        'A toggle control needs a boolean key',
      );
      const kind = KINDS['test.device'];
      expect(checkControlValue(press, kind, 1)).toStrictEqual({
        ok: false,
        message: 'test is a button: press it with device.press',
      });
    });

    it('no control drives a text key', () => {
      for (const type of ['toggle', 'momentary'] as const) {
        expect(messages([device({ controls: [{ id: 'note', label: 'Note', type }] })]).join()).toContain('needs a');
      }
    });

    it('text holds label text or null; a counter a non-negative integer', () => {
      const [text, counter] = [textKey('t'), counterKey('c')];
      expect([text.owner, text.type, text.initial, counter.owner, counter.type, counter.initial]).toStrictEqual([
        'commanded',
        'text',
        null,
        'commanded',
        'counter',
        0,
      ]);
      expect(text.schema.safeParse('Kitchen counter').success).toBe(true);
      expect(text.schema.safeParse('').success).toBe(false);
      expect(text.schema.safeParse('x'.repeat(33)).success).toBe(false);
      expect(counter.schema.safeParse(3).success).toBe(true);
      expect(counter.schema.safeParse(-1).success).toBe(false);
      expect(counter.schema.safeParse(1.5).success).toBe(false);
    });

    it("a load centre's commanded bag (on, coverOn, openEntries, directory1 … directory42) fits MAX_DEVICE_STATE_KEYS", () => {
      // World v4 (ADR 0019 deviation 5): one commanded text key per panel space. 45 keys ≤ 64.
      const keys: ModelKindDef['keys'] = {
        on: MODEL_KINDS['switch.spst'].keys['closed'],
        coverOn: MODEL_KINDS['switch.spst'].keys['closed'],
        openEntries,
        ...Object.fromEntries(Array.from({ length: MAX_PANEL_SPACES }, (_, i) => [`directory${i + 1}`, textKey('t')])),
      };
      const kind: ModelKindDef = { ...MODEL_KINDS['switch.spst'], kind: 'enclosure.test', keys };
      const { state, sim } = initialBags(kind);
      expect(Object.keys(state)).toHaveLength(3 + MAX_PANEL_SPACES);
      expect(Object.keys(state).length).toBeLessThanOrEqual(MAX_DEVICE_STATE_KEYS);
      expect(DeviceStateBagV4.safeParse(state).success).toBe(true);
      const filled = { ...state, directory1: 'KITCHEN SA 1', directory42: 'SPARE' };
      expect(checkBags(kind, filled, sim)).toStrictEqual([]);
      // Counters are non-negative integers through the same check (the load check's `checkBags`).
      const counted: ModelKindDef = { ...kind, keys: { ...keys, test: counterKey('c') } };
      const pressed = { ...filled, test: 0 };
      expect(checkBags(counted, pressed, sim)).toStrictEqual([]);
      expect(checkBags(counted, { ...pressed, test: -1 }, sim).map((i) => i.path)).toStrictEqual(['state.test']);
      expect(checkBags(counted, { ...pressed, test: 2.5 }, sim).map((i) => i.path)).toStrictEqual(['state.test']);
    });
  });

  describe('inspector rule sets', () => {
    const rule = (id: string, article = '240.4(D)') => ({
      id,
      article,
      title: 'Test rule',
      paraphrase: 'A test rule in our own words.',
      severity: 'violation',
      check: { kind: 'testCheck', params: { limitA: 20 } },
    });
    const ruleSet = (version: number, rules: unknown[], covers: string[]) => ({
      ruleSet: 'test',
      version,
      title: 'Test rules',
      edition: 'NFPA 70-2023',
      rules,
      sources: source(covers),
      extensions: {},
    });
    const covers = (ids: string[]) => ids.flatMap((id) => [`rules.${id}.article`, `rules.${id}.check.params.limitA`]);

    it('loads with an article by number, a source per rule and per parameter', () => {
      ok({ rules: [ruleSet(1, [rule('a')], covers(['a']))] });
      expect(messages({ rules: [ruleSet(1, [rule('a')], ['rules.a.article'])] }).join()).toContain(
        'rules.a.check.params.limitA: Has no source',
      );
      expect(messages({ rules: [ruleSet(1, [rule('a', 'Art. 240.4')], covers(['a']))] }).join()).toContain('article');
      expect(messages({ rules: [ruleSet(1, [rule('a'), rule('a')], covers(['a']))] }).join()).toContain(
        'Rule ids must be unique',
      );
    });

    it('rule ids are append-only across a rule set’s versions', () => {
      const v1 = ruleSet(1, [rule('a'), rule('b')], covers(['a', 'b']));
      ok({ rules: [v1, ruleSet(2, [rule('a'), rule('b'), rule('c')], covers(['a', 'b', 'c']))] });
      expect(messages({ rules: [v1, ruleSet(2, [rule('a')], covers(['a']))] }).join()).toContain(
        'Rule ids are append-only: missing b of version 1',
      );
    });

    it('article numbers only: a number with lettered subdivisions, never words', () => {
      for (const good of ['100', '240.4(D)', '250.148(C)', '314.16(B)(1)', '210.11(C)(1)']) {
        expect(ARTICLE_PATTERN.test(good), good).toBe(true);
      }
      for (const bad of ['Art. 240.4', '240.4 (D)', 'Table 310.16', '240.4(D) Small conductors']) {
        expect(ARTICLE_PATTERN.test(bad), bad).toBe(false);
      }
    });
  });
});

describe('catalogue v3 registries and region data', () => {
  it('every registry id parses as its save-format grammar', () => {
    for (const id of Object.keys(AREA_USES)) expect(AreaUseId.safeParse(id).success, id).toBe(true);
    for (const type of Object.values(MOUNT_TYPES)) {
      for (const id of type.hostContacts) expect(ContactId.safeParse(id).success, id).toBe(true);
    }
    for (const config of Object.values(NEMA_CONFIGS)) {
      expect(NemaConfigId.safeParse(config.id).success, config.id).toBe(true);
      for (const pin of config.pins) expect(PinId.safeParse(pin).success, pin).toBe(true);
      for (const plug of config.accepts) expect(NemaConfigId.safeParse(plug).success, plug).toBe(true);
    }
  });

  it('NEMA_CONFIGS: the mating matrix (the pre-audit as corrected 2026-11-17), and a 1-15P where its blades fit', () => {
    const receptacles = Object.values(NEMA_CONFIGS).filter((c) => c.form === 'receptacle');
    const plugs = Object.values(NEMA_CONFIGS).filter((c) => c.form === 'plug');
    const matrix = Object.fromEntries(
      receptacles.map((r) => [r.id, plugs.filter((p) => nemaMates(p.id, r.id)).map((p) => p.id)]),
    );
    // A save-format freeze from v0.5.0 (plug.insert's wrong-configuration): append only, never change a row.
    expect(matrix).toStrictEqual({
      '5-15R': ['1-15P', '5-15P'],
      '5-20R': ['1-15P', '5-15P', '5-20P'],
      '6-20R': ['6-15P', '6-20P'],
      '14-30R': ['14-30P'],
      '14-50R': ['14-50P'],
    });
    for (const r of receptacles) {
      for (const p of r.accepts) {
        // Every pin of an accepted plug meets a slot of the receptacle (a plug contact per pin).
        expect(
          nemaConfig(p)?.pins.every((pin) => r.pins.includes(pin)),
          `${p} in ${r.id}`,
        ).toBe(true);
        // A plug never enters a receptacle rated below it, nor of another voltage.
        expect((nemaConfig(p)?.ratedA ?? 0) <= r.ratedA && nemaConfig(p)?.ratedV === r.ratedV, `${p} in ${r.id}`).toBe(
          true,
        );
      }
    }
    expect(nemaMates('5-20P', '5-15R')).toBe(false);
    expect(nemaMates('6-20P', '5-20R')).toBe(false);
    expect(nemaMates('5-15R', '5-15P')).toBe(false);
    expect(nemaConfig('toString')).toBeUndefined();
  });

  it('NEMA_CONFIGS: the rating in each designation is the row’s rating', () => {
    for (const c of Object.values(NEMA_CONFIGS)) {
      const [, amps] = /^L?\d+-(\d+)[PR]$/.exec(c.id) ?? [];
      expect(c.ratedA, c.id).toBe(Number(amps));
      expect(c.ratedV, c.id).toBe(c.id.startsWith('5-') || c.id.startsWith('1-') ? 125 : 250);
    }
  });

  it('AREA_USES: the ten ADR 0019 rows, append-only from here on', () => {
    // A save-format freeze from v0.5.0 (AreaV4.use): append only, never rename or remove a row.
    expect(Object.keys(AREA_USES)).toStrictEqual([
      'kitchen',
      'bathroom',
      'garage',
      'outdoor',
      'laundry',
      'bedroom',
      'living',
      'hall',
      'basement',
      'crawlSpace',
    ]);
    for (const [id, row] of Object.entries(AREA_USES)) {
      expect(row.id).toBe(id);
      expect(areaUse(id)).toBe(row);
      expect(row.source).toMatch(/^game-design/);
    }
    expect(areaUse('toString')).toBeUndefined();
  });

  it('every bus mount type steps by stabs; only bus types do', () => {
    for (const type of Object.values(MOUNT_TYPES)) {
      expect(type.bus, type.id).toBe(type.id === 'busStab');
      expect(new Set(type.hostContacts).size).toBe(type.hostContacts.length);
    }
  });

  it("the GFCI Class A limit points are t = (20 mA / I)^1.43 within 0.15 %, the pre-audit's points", () => {
    const gfci = NEC_REGION.protection.gfci;
    expect([gfci.className, gfci.pickupMinA.value, gfci.pickupMaxA.value]).toStrictEqual(['A', 0.004, 0.006]);
    // Hand calculation: t(6 mA) = (20/6)^1.43 = e^(1.43 × 1.20397) = 5.5938 s; t(10) = 2^1.43 = 2.6945 s;
    // t(20) = 1 s; t(30) = (2/3)^1.43 = 0.55998 s; t(50) = 0.4^1.43 = 0.26975 s; t(100) = 0.2^1.43 =
    // 0.10013 s; t(150) = 0.05605 s; t(264) = 0.024967 s.
    const points = gfci.tripTimeLimit.points;
    expect(points.map((p) => Math.round(p.x * 1e6) / 1e3)).toStrictEqual([6, 10, 20, 30, 50, 100, 150, 264]);
    for (const { x, y } of points) {
      const exact = Math.pow(0.02 / x, 1.43);
      expect(Math.abs(y - exact) / exact, `${x} A`).toBeLessThan(0.0015);
    }
    // Strictly falling with the residual, and the rate 1/t rising, so a linear-in-rate read is monotone.
    for (let i = 1; i < points.length; i++) expect(points[i].y).toBeLessThan(points[i - 1].y);
    // The first point is the must-trip pickup.
    expect(points[0].x).toBe(gfci.pickupMaxA.value);
  });

  it('the AFCI limits: 1 s at 5 A, under 0.2 s at 1.5 × rating', () => {
    const afci = NEC_REGION.protection.afci;
    expect([
      afci.minArcCurrentA.value,
      afci.maxTripAtMinS.value,
      afci.ratedMultiple.value,
      afci.maxTripAtRatedMultipleS.value,
    ]).toStrictEqual([5, 1, 1.5, 0.2]);
  });

  it("the NEC region's inspector rules resolve in the built-in catalogue", () => {
    const { ruleSet, version } = NEC_REGION.inspectorRules;
    const set = BUILTIN_CATALOG.ruleSet(ruleSet, version);
    expect(set?.edition).toBe('NFPA 70-2023');
    // Every seeded rule cites an article by number and paraphrases it within the length limit.
    for (const rule of set?.rules ?? []) {
      expect(ARTICLE_PATTERN.test(rule.article), rule.id).toBe(true);
      expect(rule.paraphrase.length).toBeLessThanOrEqual(300);
    }
  });

  it('sources say game-design when they are (no game-design value poses as a measurement)', () => {
    for (const set of BUILTIN_CATALOG.ruleSets) {
      for (const s of set.sources) if (s.kind === 'game-design') expect(s.citation).toMatch(/^game-design/);
    }
  });
});
