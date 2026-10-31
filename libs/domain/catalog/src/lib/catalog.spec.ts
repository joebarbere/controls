import { DeviceStateValue, FiniteNumber } from '@controls/save-format';
import { z } from 'zod';
import { CatalogError, catalogOrThrow, checkControlValue, parseCatalog } from './catalog';
import type { DeviceControl } from './device';
import { MODEL_KINDS, type ModelKindDef } from './model-kinds';

/** A valid switch entry; tests break one rule at a time. */
function switchEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'switch.test-spst',
    version: 1,
    title: 'Test switch',
    brand: 'Testbrand',
    modelName: 'T-1',
    category: 'switch',
    sizeMm: { widthMm: 10, heightMm: 10, depthMm: 10 },
    terminals: [
      { id: 'a', label: '1', positionMm: { x: 0, y: 0, z: 0 } },
      { id: 'b', label: '2', positionMm: { x: 5, y: 0, z: 0 } },
    ],
    model: { kind: 'switch.spst', params: {} },
    controls: [{ id: 'closed', label: 'Closed', type: 'toggle' }],
    sources: [{ id: 'layout', kind: 'game-design', citation: 'game-design: test', covers: ['sizeMm', 'terminals'] }],
    extensions: {},
    ...overrides,
  };
}

function leadEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'lead.test',
    version: 1,
    title: 'Test lead',
    brand: 'Testbrand',
    modelName: 'L-1',
    category: 'lead',
    sizeMm: null,
    terminals: [],
    model: {
      kind: 'lead',
      params: {
        lengthMm: 500,
        conductorAreaM2: 1e-6,
        resistivityOhmM: 1.7e-8,
        temperatureCoefficientPerK: 0.004,
        referenceTemperatureK: 293.15,
        contactResistanceOhm: 0,
      },
    },
    controls: [],
    sources: [
      {
        id: 'all',
        kind: 'real-world',
        citation: 'test',
        covers: [
          'model.params.lengthMm',
          'model.params.conductorAreaM2',
          'model.params.resistivityOhmM',
          'model.params.temperatureCoefficientPerK',
          'model.params.referenceTemperatureK',
          'model.params.contactResistanceOhm',
        ],
      },
    ],
    extensions: {},
    ...overrides,
  };
}

/** Synthetic kinds with a number and an enum commanded key, for the setpoint and selector rules. */
const SYNTHETIC: Readonly<Record<string, ModelKindDef>> = {
  ...MODEL_KINDS,
  'supply.test': {
    kind: 'supply.test',
    placement: 'entity',
    terminals: ['neg', 'pos'],
    params: z.strictObject({}),
    keys: {
      setpointV: {
        owner: 'commanded',
        type: 'number',
        schema: FiniteNumber.min(0).max(30),
        initial: 0,
        values: null,
        description: 'test',
      },
      handle: {
        owner: 'commanded',
        type: 'enum',
        schema: z.enum(['off', 'on']),
        initial: 'off',
        values: ['off', 'on'],
        description: 'test',
      },
      mode: {
        owner: 'sim',
        type: 'enum',
        schema: z.enum(['cv', 'cc']),
        initial: 'cv',
        values: ['cv', 'cc'],
        description: 'test',
      },
    },
    description: 'test',
  },
};

function supplyEntry(controls: unknown[]): Record<string, unknown> {
  return switchEntry({
    id: 'supply.test-bench',
    category: 'source',
    terminals: [
      { id: 'neg', label: '-', positionMm: { x: 0, y: 0, z: 0 } },
      { id: 'pos', label: '+', positionMm: { x: 1, y: 0, z: 0 } },
    ],
    model: { kind: 'supply.test', params: {} },
    controls,
  });
}

function messages(documents: unknown[], kinds = SYNTHETIC): string[] {
  const result = parseCatalog(1, documents, kinds);
  return result.ok ? [] : result.issues.map((i) => `${i.path}: ${i.message}`);
}

describe('parseCatalog', () => {
  it('accepts valid entries and sorts them by id, then version', () => {
    const result = parseCatalog(3, [switchEntry({ version: 2 }), leadEntry(), switchEntry()]);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.catalog.version).toBe(3);
    expect(result.catalog.devices.map((d) => `${d.id}@${d.version}`)).toStrictEqual([
      'lead.test@1',
      'switch.test-spst@1',
      'switch.test-spst@2',
    ]);
    expect(result.catalog.kindOf({ id: 'lead.test', version: 1 })?.placement).toBe('connection');
    expect(Object.isFrozen(result.catalog)).toBe(true);
  });

  it('refuses a bad catalogue version', () => {
    expect(messages([], MODEL_KINDS)).toStrictEqual([]);
    for (const version of [0, 1.5, -1]) {
      const result = parseCatalog(version, []);
      expect(result.ok).toBe(false);
    }
  });

  it('reports schema problems with the entry index, never the value', () => {
    const found = messages([switchEntry({ brand: '' }), { id: 'secret value', extra: true }]);
    expect(found.some((m) => m.startsWith('[0].brand'))).toBe(true);
    expect(found.some((m) => m.startsWith('[1].id'))).toBe(true);
    expect(found).toContain('[1]: Unrecognized key: "extra"');
    expect(found.join('\n')).not.toContain('secret value');
  });

  it('reserves prop.* for the built-in props', () => {
    expect(messages([switchEntry({ id: 'prop.switch' })]).join()).toContain('reserved for built-in props');
  });

  it('refuses a duplicate (id, version)', () => {
    expect(messages([switchEntry(), switchEntry()]).join()).toContain('Duplicate catalogue entry');
  });

  it('refuses an unknown model kind (own keys only) and bad parameters', () => {
    expect(messages([switchEntry({ model: { kind: 'toString', params: {} } })]).join()).toContain('Unknown model kind');
    expect(messages([switchEntry({ model: { kind: 'nope', params: {} } })]).join()).toContain('Unknown model kind');
    const extra = messages([switchEntry({ model: { kind: 'switch.spst', params: { ratedA: 10 } } })]);
    expect(extra.some((m) => m.includes('model.params'))).toBe(true);
    const bad = leadEntry();
    (bad['model'] as { params: Record<string, number> }).params['lengthMm'] = 0.5;
    expect(messages([bad]).some((m) => m.includes('model.params.lengthMm'))).toBe(true);
  });

  it('needs exactly the kind’s terminals, unique', () => {
    const one = messages([switchEntry({ terminals: [{ id: 'a', label: '1', positionMm: { x: 0, y: 0, z: 0 } }] })]);
    expect(one.join()).toContain('needs exactly the terminals [a, b]');
    const twice = { id: 'a', label: '1', positionMm: { x: 0, y: 0, z: 0 } };
    expect(messages([switchEntry({ terminals: [twice, twice] })]).join()).toContain('Terminal ids must be unique');
  });

  it('ties size and category to the placement', () => {
    expect(messages([switchEntry({ sizeMm: null })]).join()).toContain('needs a size');
    expect(messages([switchEntry({ category: 'lead' })]).join()).toContain('Category "lead"');
    const sized = leadEntry({ sizeMm: { widthMm: 1, heightMm: 1, depthMm: 1 } });
    expect(messages([sized]).join()).toContain('sizeMm must be null');
    expect(messages([leadEntry({ category: 'load' })]).join()).toContain('Category "lead"');
  });

  it('controls drive commanded keys of a matching type', () => {
    expect(messages([switchEntry({ controls: [{ id: 'open', label: 'Open', type: 'toggle' }] })]).join()).toContain(
      "isn't one",
    );
    const twice = { id: 'closed', label: 'Closed', type: 'toggle' };
    expect(messages([switchEntry({ controls: [twice, twice] })]).join()).toContain('Duplicate control id');
    const setpoint = { id: 'closed', label: 'X', type: 'setpoint', unit: 'V', min: 0, max: 1, step: 0.1 };
    expect(messages([switchEntry({ controls: [setpoint] })]).join()).toContain('needs a number key');

    expect(messages([supplyEntry([{ id: 'setpointV', label: 'V', type: 'toggle' }])]).join()).toContain(
      'needs a boolean key',
    );
    const selector = { id: 'handle', label: 'Handle', type: 'selector', options: ['off', 'on'] };
    expect(messages([supplyEntry([selector])])).toStrictEqual([]);
    expect(messages([supplyEntry([{ ...selector, options: ['off', 'tripped'] }])]).join()).toContain(
      'Selector options must be values',
    );
    expect(messages([supplyEntry([{ ...selector, id: 'mode', options: ['cv', 'cc'] }])]).join()).toContain(
      'commanded state key',
    );
    expect(messages([supplyEntry([{ ...selector, id: 'setpointV' }])]).join()).toContain('needs a enum key');
    const bounds = { id: 'setpointV', label: 'V', type: 'setpoint', unit: 'V', min: 2, max: 1, step: 1 };
    expect(messages([supplyEntry([bounds])]).join()).toContain('min must not be above max');
    // The key starts at 0: a control from 1 V would start a new device outside its own range.
    const above = { id: 'setpointV', label: 'V', type: 'setpoint', unit: 'V', min: 1, max: 5, step: 1 };
    expect(messages([supplyEntry([above])]).join()).toContain("initial value (0) is outside this control's range");
  });

  it('every parameter, the size and the terminals have a source (realism charter)', () => {
    const uncovered = messages([
      switchEntry({ sources: [{ id: 's', kind: 'game-design', citation: 'x', covers: ['sizeMm'] }] }),
    ]);
    expect(uncovered.join()).toContain('terminals: Has no source');
    const lead = leadEntry();
    (lead['sources'] as { covers: string[] }[])[0].covers.pop();
    expect(messages([lead]).join()).toContain('model.params.contactResistanceOhm: Has no source');
  });

  it('refuses sources for things the entry lacks, and duplicate source ids', () => {
    const extraParam = switchEntry({
      sources: [
        { id: 's', kind: 'game-design', citation: 'x', covers: ['sizeMm', 'terminals', 'model.params.ratedA'] },
      ],
    });
    expect(messages([extraParam]).join()).toContain("covers model.params.ratedA, which the entry doesn't have");
    const lead = leadEntry();
    (lead['sources'] as { covers: string[] }[])[0].covers.push('sizeMm', 'terminals');
    const found = messages([lead]).join();
    expect(found).toContain("covers sizeMm, which the entry doesn't have");
    expect(found).toContain("covers terminals, which the entry doesn't have");
    const twice = { id: 's', kind: 'game-design', citation: 'x', covers: ['sizeMm', 'terminals'] };
    expect(messages([switchEntry({ sources: [twice, twice] })]).join()).toContain('Source ids must be unique');
  });

  it('caps the reported issues', () => {
    const many = Array.from({ length: 80 }, () => ({}));
    const result = parseCatalog(1, many);
    expect(!result.ok && result.issues.length).toBe(50);
  });
});

describe('catalogOrThrow', () => {
  it('returns the catalogue, or throws CatalogError with the issues', () => {
    expect(catalogOrThrow(1, [switchEntry()]).devices).toHaveLength(1);
    expect(() => catalogOrThrow(1, [switchEntry({ id: 'bad' })])).toThrow(CatalogError);
    try {
      catalogOrThrow(1, [switchEntry({ id: 'bad' })]);
    } catch (error) {
      expect((error as CatalogError).issues.length).toBeGreaterThan(0);
      expect((error as Error).message).toMatch(/^Invalid device catalogue: /);
    }
  });
});

describe('checkControlValue', () => {
  const kind = SYNTHETIC['supply.test'];
  const toggle: DeviceControl = { id: 'closed', label: 'Closed', type: 'toggle' };
  const setpoint: DeviceControl = {
    id: 'setpointV',
    label: 'Voltage',
    type: 'setpoint',
    unit: 'V',
    min: 0,
    max: 20,
    step: 0.1,
  };
  const selector: DeviceControl = { id: 'handle', label: 'Handle', type: 'selector', options: ['off', 'on'] };

  it('toggles take booleans', () => {
    const spst = MODEL_KINDS['switch.spst'];
    expect(checkControlValue(toggle, spst, true)).toStrictEqual({ ok: true });
    expect(checkControlValue(toggle, spst, 1)).toMatchObject({ ok: false, message: 'Closed takes true or false' });
  });

  it('setpoints take numbers within the control’s range and the key’s schema', () => {
    expect(checkControlValue(setpoint, kind, 12.5)).toStrictEqual({ ok: true });
    expect(checkControlValue(setpoint, kind, 21)).toMatchObject({
      ok: false,
      message: 'Voltage takes a number from 0 to 20 V',
    });
    expect(checkControlValue(setpoint, kind, 'x')).toMatchObject({ ok: false });
    const wide: DeviceControl = { ...setpoint, max: 40 };
    expect(checkControlValue(wide, kind, 35)).toMatchObject({
      ok: false,
      message: "Voltage doesn't accept that value",
    });
  });

  it('selectors take one of their options', () => {
    expect(checkControlValue(selector, kind, 'on')).toStrictEqual({ ok: true });
    expect(checkControlValue(selector, kind, 'tripped')).toMatchObject({
      ok: false,
      message: 'Handle takes one of: off, on',
    });
    expect(checkControlValue(selector, kind, true)).toMatchObject({ ok: false });
  });

  it('every accepted value is a valid DeviceStateValue', () => {
    for (const value of [true, 12.5, 'on']) expect(DeviceStateValue.safeParse(value).success).toBe(true);
  });
});
