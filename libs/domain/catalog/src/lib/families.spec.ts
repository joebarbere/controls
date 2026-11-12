import { Int } from '@controls/save-format';
import * as z from 'zod';
import { BUILTIN_TABLE_DOCUMENTS } from './builtin-tables.generated';
import { type CatalogInput, parseCatalog } from './catalog';
import { CONNECTION_SIM_KEYS, MODEL_KINDS, type ModelKindDef } from './model-kinds';

/*
 * Catalogue format v2's new shapes, proved on TEST-ONLY fixtures (no real content: conductors, cables,
 * enclosures, tools and accessories arrive with F3.1, F3.4 and F3.5). Nothing here is a real product;
 * every number is `game-design: test`. Each test breaks one rule of a valid catalogue.
 */

/** Synthetic kinds: a conductor connection kind and an enclosure kind (the real ones land with F3.1 and F3.5). */
const KINDS: Readonly<Record<string, ModelKindDef>> = {
  ...MODEL_KINDS,
  'test.conductor': {
    kind: 'test.conductor',
    placement: 'connection',
    requires: 'conductor',
    terminals: [],
    params: z.strictObject({}),
    keys: CONNECTION_SIM_KEYS,
    description: 'test',
  },
  'test.box': {
    kind: 'test.box',
    placement: 'entity',
    requires: 'enclosure',
    terminals: ['ground'],
    params: z.strictObject({}),
    keys: {
      openEntries: {
        owner: 'commanded',
        type: 'number',
        schema: Int.min(0).max(0xffffffff),
        initial: 0,
        values: null,
        description: 'test',
      },
    },
    description: 'test',
  },
};

const source = (covers: string[]) => [{ id: 'test', kind: 'game-design', citation: 'game-design: test', covers }];
const copper = { table: 'materials', version: 1, key: 'copperAnnealed' };
const thhn = { table: 'insulation', version: 1, key: 'thhnThwn2' };

function conductor(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    version: 1,
    title: 'Test conductor',
    brand: 'Testbrand',
    modelName: 'C-1',
    category: 'conductor',
    sizeMm: null,
    terminals: [],
    mounts: [],
    enclosure: null,
    conductor: {
      awg: 14,
      stranding: 'solid',
      strandCount: 1,
      material: copper,
      insulation: thhn,
      insulationThicknessMm: 0.4,
      jacketThicknessMm: 0.1,
      colours: [
        { base: 'black', stripe: null },
        { base: 'white', stripe: null },
        { base: 'green', stripe: 'yellow' },
      ],
    },
    model: { kind: 'test.conductor', params: {} },
    controls: [],
    sources: source(['conductor']),
    extensions: {},
    ...overrides,
  };
}

function bareConductor(): Record<string, unknown> {
  return conductor('conductor.test-14-bare', {
    conductor: {
      awg: 14,
      stranding: 'solid',
      strandCount: 1,
      material: copper,
      insulation: null,
      insulationThicknessMm: null,
      jacketThicknessMm: null,
      colours: [{ base: 'bare', stripe: null }],
    },
  });
}

const screw = {
  method: 'screw',
  ratedConductors: 1,
  maxConductors: 2,
  awgRange: { smallest: 14, largest: 10 },
  stranding: ['solid', 'stranded'],
  stripLengthMm: { nominal: 13, tolerance: 2 },
  torqueNm: 1.4,
  alRated: false,
  entryMm: { x: 10, y: 0, z: 5 },
  exitAxis: '+z',
};

function box(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'box.test-1gang',
    version: 1,
    title: 'Test box',
    brand: 'Testbrand',
    modelName: 'B-1',
    category: 'enclosure',
    sizeMm: { widthMm: 50, heightMm: 75, depthMm: 60 },
    terminals: [{ id: 'ground', label: 'GND', positionMm: { x: 10, y: 0, z: 5 }, methods: [screw] }],
    mounts: [{ type: 'studFlange', widthMm: 50 }],
    enclosure: {
      mounts: [
        { id: 'yoke', type: 'deviceYoke', positionMm: { x: 25, y: 37, z: 60 }, axis: '+x', facing: '+z', extentMm: 0 },
      ],
      entries: [
        {
          id: 'top',
          type: 'clamp',
          tradeSize: null,
          maxCables: 2,
          internalClamp: true,
          positionMm: { x: 25, y: 75, z: 30 },
          axis: '-y',
        },
        {
          id: 'ko1',
          type: 'knockout',
          tradeSize: '1/2',
          maxCables: 1,
          internalClamp: false,
          positionMm: { x: 25, y: 0, z: 30 },
          axis: '+y',
        },
      ],
      interiorVolumeMm3: 295000,
    },
    conductor: null,
    model: { kind: 'test.box', params: {} },
    controls: [],
    sources: source([
      'sizeMm',
      'terminals',
      'terminals.ground.methods.screw',
      'fits.studFlange',
      'mounts',
      'entries',
      'interiorVolumeMm3',
    ]),
    extensions: {},
    ...overrides,
  };
}

function cable(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cable.test-14-2',
    version: 1,
    title: 'Test cable 14/2 with ground',
    brand: 'Testbrand',
    modelName: 'K-1',
    conductors: [
      {
        index: 0,
        conductor: { id: 'conductor.test-14', version: 1 },
        role: 'ungrounded',
        insulated: true,
        colour: { base: 'black', stripe: null },
      },
      {
        index: 1,
        conductor: { id: 'conductor.test-14', version: 1 },
        role: 'grounded',
        insulated: true,
        colour: { base: 'white', stripe: null },
      },
      {
        index: 2,
        conductor: { id: 'conductor.test-14-bare', version: 1 },
        role: 'egc',
        insulated: false,
        colour: { base: 'bare', stripe: null },
      },
    ],
    jacket: {
      material: { table: 'insulation', version: 1, key: 'nmbJacket' },
      colour: 'white',
      thicknessMm: 0.6,
      widthMm: 9.6,
      heightMm: 5.1,
    },
    sources: source(['conductors', 'jacket']),
    extensions: {},
    ...overrides,
  };
}

function tool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tool.test-stripper',
    version: 1,
    title: 'Test stripper',
    brand: 'Testbrand',
    modelName: 'S-1',
    kind: 'stripper',
    capabilities: [
      { step: 'strip', maxAwg: 10 },
      { step: 'cut', maxAwg: 10 },
    ],
    holes: [
      { id: 'sol-14', awg: 14, stranding: 'solid' },
      { id: 'sol-12', awg: 12, stranding: 'solid' },
    ],
    dies: [],
    torque: null,
    boreDiameterMm: null,
    sources: source(['capabilities', 'holes']),
    extensions: {},
    ...overrides,
  };
}

function ferrule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ferrule.test-16',
    version: 1,
    title: 'Test ferrule',
    brand: 'Testbrand',
    modelName: 'F-1',
    kind: 'ferrule',
    awgRange: { smallest: 16, largest: 16 },
    stranding: ['stranded'],
    dies: ['sq-16'],
    barrelLengthMm: 8,
    studDiameterMm: null,
    sources: source(['awgRange', 'stranding', 'dies', 'barrelLengthMm']),
    extensions: {},
    ...overrides,
  };
}

function input(overrides: Partial<Record<keyof CatalogInput, unknown[]>> = {}): CatalogInput {
  return {
    devices: [conductor('conductor.test-14'), bareConductor(), box()],
    cables: [cable()],
    tools: [tool()],
    accessories: [ferrule()],
    tables: BUILTIN_TABLE_DOCUMENTS,
    ...overrides,
  };
}

function messages(overrides: Partial<Record<keyof CatalogInput, unknown[]>> = {}): string[] {
  const result = parseCatalog(2, input(overrides), KINDS);
  return result.ok ? [] : result.issues.map((i) => `${i.path}: ${i.message}`);
}

describe('catalogue format v2: the families on test fixtures', () => {
  it('accepts a conductor, an enclosure, a cable, a tool and an accessory, and resolves each by family', () => {
    const result = parseCatalog(2, input(), KINDS);
    if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
    const { catalog } = result;
    expect(catalog.family({ id: 'conductor.test-14', version: 1 })).toBe('device');
    expect(catalog.family({ id: 'cable.test-14-2', version: 1 })).toBe('cable');
    expect(catalog.family({ id: 'tool.test-stripper', version: 1 })).toBe('tool');
    expect(catalog.family({ id: 'ferrule.test-16', version: 1 })).toBe('accessory');
    expect(catalog.cable({ id: 'cable.test-14-2', version: 1 })?.conductors).toHaveLength(3);
    expect(catalog.tool({ id: 'tool.test-stripper', version: 1 })?.holes.map((h) => h.id)).toStrictEqual([
      'sol-14',
      'sol-12',
    ]);
    expect(catalog.accessory({ id: 'ferrule.test-16', version: 1 })?.dies).toStrictEqual(['sq-16']);
    expect(catalog.device({ id: 'box.test-1gang', version: 1 })?.enclosure?.entries.map((e) => e.id)).toStrictEqual([
      'top',
      'ko1',
    ]);
    expect(catalog.tableRow(copper)).toMatchObject({ temperatureCoefficientPerK: 0.00393 });
  });

  it('refuses an unknown family key in the object form (a misspelt family would drop its documents)', () => {
    const result = parseCatalog(2, { ...input(), tool: [tool()] } as CatalogInput, KINDS);
    expect(!result.ok && result.issues.map((i) => `${i.path}: ${i.message}`).join()).toContain(
      'tool: Not a catalogue family',
    );
  });

  it('one namespace: family prefixes are reserved, conductor ids go with conductor data', () => {
    expect(
      messages({ devices: [conductor('conductor.test-14'), bareConductor(), box({ id: 'tool.box' })] }).join(),
    ).toContain('"tool." ids belong to the tool family');
    expect(messages({ devices: [conductor('wire.test-14'), bareConductor(), box()] }).join()).toContain(
      'Conductor entries, and only they',
    );
    expect(messages({ cables: [cable({ id: 'nm.test' })] }).join()).toContain('A cable id starts with "cable."');
    expect(messages({ tools: [tool({ id: 'stripper.test' })] }).join()).toContain('A tool id starts with "tool."');
    expect(messages({ accessories: [ferrule({ id: 'lug.test-16' })] }).join()).toContain(
      'A ferrule id starts with "ferrule."',
    );
  });

  it('conductor data: pinned rows in the right table, colours in the colour table, bare only when bare', () => {
    const wrongTable = conductor('conductor.test-14');
    (wrongTable['conductor'] as Record<string, unknown>)['material'] = thhn;
    expect(messages({ devices: [wrongTable, bareConductor(), box()] }).join()).toContain(
      'Must pin a row of the materials table',
    );
    const noRow = conductor('conductor.test-14');
    (noRow['conductor'] as Record<string, unknown>)['insulation'] = { ...thhn, key: 'thw' };
    expect(messages({ devices: [noRow, bareConductor(), box()] }).join()).toContain('No row thw in insulation@1');
    const mauve = conductor('conductor.test-14');
    (mauve['conductor'] as Record<string, unknown>)['colours'] = [{ base: 'mauve', stripe: null }];
    expect(messages({ devices: [mauve, bareConductor(), box()] }).join()).toContain(
      `Colour "mauve" isn't in the catalogue's colour table`,
    );
    const bareInsulated = conductor('conductor.test-14');
    (bareInsulated['conductor'] as Record<string, unknown>)['colours'] = [{ base: 'bare', stripe: null }];
    expect(messages({ devices: [bareInsulated, bareConductor(), box()] }).join()).toContain(
      '"bare" is only valid on an uninsulated conductor',
    );
    const solidStrands = conductor('conductor.test-14');
    (solidStrands['conductor'] as Record<string, unknown>)['strandCount'] = 7;
    expect(messages({ devices: [solidStrands, bareConductor(), box()] }).join()).toContain(
      'a solid conductor has one strand',
    );
    expect(
      messages({ devices: [conductor('conductor.test-14', { conductor: null }), bareConductor(), box()] }).join(),
    ).toContain('Conductor data goes with conductor kinds');
  });

  it('conductor layers (F3.1): a jacket thickness exactly with a jacket layer, an outer radius at most 8 × the metal’s', () => {
    const noJacket = conductor('conductor.test-14');
    (noJacket['conductor'] as Record<string, unknown>)['jacketThicknessMm'] = null;
    expect(messages({ devices: [noJacket, bareConductor(), box()] }).join()).toContain(
      'thhnThwn2 has a jacket layer: give its thickness',
    );
    const mtwJacket = conductor('conductor.test-14');
    (mtwJacket['conductor'] as Record<string, unknown>)['insulation'] = { ...thhn, key: 'mtw' };
    expect(messages({ devices: [mtwJacket, bareConductor(), box()] }).join()).toContain(
      'mtw is a single layer: jacketThicknessMm must be null',
    );
    const bareJacket = bareConductor();
    (bareJacket['conductor'] as Record<string, unknown>)['jacketThicknessMm'] = 0.1;
    expect(messages({ devices: [conductor('conductor.test-14'), bareJacket, box()] }).join()).toContain(
      'a bare conductor has no jacket layer',
    );
    // 14 AWG: r₀ = 1.62773 / 2 = 0.813865 mm; 8 r₀ = 6.51092 mm, so a 5.7 mm wall (+ 0.1 mm jacket) is over.
    const thick = conductor('conductor.test-14');
    (thick['conductor'] as Record<string, unknown>)['insulationThicknessMm'] = 5.7;
    expect(messages({ devices: [thick, bareConductor(), box()] }).join()).toContain(
      "The insulation's outer radius is above 8× the conductor's",
    );
    const justInside = conductor('conductor.test-14');
    (justInside['conductor'] as Record<string, unknown>)['insulationThicknessMm'] = 5.5;
    expect(messages({ devices: [justInside, bareConductor(), box()] })).toStrictEqual([]);
  });

  it('enclosure data: registered mount and entry types, at most 32 entries, unique ids, a perpendicular frame', () => {
    const spec = () => structuredClone(box()['enclosure']) as Record<string, Record<string, unknown>[]>;
    const badMount = spec();
    badMount['mounts'][0]['type'] = 'magnet';
    expect(
      messages({ devices: [conductor('conductor.test-14'), bareConductor(), box({ enclosure: badMount })] }).join(),
    ).toContain('Unknown mount type "magnet"');
    const badEntry = spec();
    badEntry['entries'][0]['type'] = 'hole';
    expect(
      messages({ devices: [conductor('conductor.test-14'), bareConductor(), box({ enclosure: badEntry })] }).join(),
    ).toContain('Unknown entry type "hole"');
    const many = spec();
    many['entries'] = Array.from({ length: 33 }, (_, i) => ({ ...many['entries'][1], id: `ko${i}` }));
    expect(
      messages({ devices: [conductor('conductor.test-14'), bareConductor(), box({ enclosure: many })] }).join(),
    ).toContain('entries');
    const clash = spec();
    clash['entries'][0]['id'] = 'ground';
    expect(
      messages({ devices: [conductor('conductor.test-14'), bareConductor(), box({ enclosure: clash })] }).join(),
    ).toContain('Terminal, mount and entry ids must be unique');
    const skew = spec();
    skew['mounts'][0]['facing'] = '-x';
    expect(
      messages({ devices: [conductor('conductor.test-14'), bareConductor(), box({ enclosure: skew })] }).join(),
    ).toContain('axis and facing must be perpendicular');
    expect(
      messages({ devices: [conductor('conductor.test-14'), bareConductor(), box({ enclosure: null })] }).join(),
    ).toContain('Enclosure data goes with enclosure kinds');
  });

  it('an enclosure kind declares the commanded openEntries key', () => {
    const kinds = { ...KINDS, 'test.box': { ...KINDS['test.box'], keys: {} } };
    const result = parseCatalog(2, input(), kinds);
    expect(!result.ok && result.issues.map((i) => i.message).join()).toContain(
      'must declare the commanded number key openEntries',
    );
  });

  it('termination specs: registered methods, once each, torque exactly for clamp-torque methods', () => {
    const withMethods = (methods: unknown[]) =>
      box({ terminals: [{ id: 'ground', label: 'GND', positionMm: { x: 10, y: 0, z: 5 }, methods }] });
    const devices = (b: Record<string, unknown>) => ({ devices: [conductor('conductor.test-14'), bareConductor(), b] });
    expect(messages(devices(withMethods([{ ...screw, method: 'solder' }]))).join()).toContain(
      'Unknown termination method "solder"',
    );
    expect(messages(devices(withMethods([screw, screw]))).join()).toContain('A terminal lists each method once');
    expect(messages(devices(withMethods([{ ...screw, torqueNm: null }]))).join()).toContain(
      'needs its marked torqueNm',
    );
    const cage = { ...screw, method: 'springCage', torqueNm: 1 };
    expect(messages(devices(withMethods([cage]))).join()).toContain('torqueNm must be null');
    expect(messages(devices(withMethods([{ ...screw, maxConductors: 0 }]))).join()).toContain('maxConductors');
    expect(messages(devices(withMethods([{ ...screw, awgRange: { smallest: 10, largest: 14 } }]))).join()).toContain(
      'smallest',
    );
  });

  it('termination specs need a source per field: terminals alone covers only the layout', () => {
    const layoutOnly = box({
      sources: source(['sizeMm', 'terminals', 'fits.studFlange', 'mounts', 'entries', 'interiorVolumeMm3']),
    });
    const found = messages({ devices: [conductor('conductor.test-14'), bareConductor(), layoutOnly] });
    expect(found).toContain(
      '[2] box.test-1gang@1: terminals.ground.methods.screw.torqueNm: Has no source (realism charter: every value has a source)',
    );
    expect(found.filter((m) => m.includes('terminals.ground.methods.screw.'))).toHaveLength(9);
  });

  it('cables: indices in order, pinned conductor entries, matching insulation and colours, a jacket row', () => {
    const conductors = () => structuredClone(cable()['conductors']) as Record<string, unknown>[];
    const order = conductors();
    order[1]['index'] = 2;
    expect(messages({ cables: [cable({ conductors: order })] }).join()).toContain('index is its position');
    const unknown = conductors();
    unknown[0]['conductor'] = { id: 'conductor.test-14', version: 2 };
    expect(messages({ cables: [cable({ conductors: unknown })] }).join()).toContain(
      "conductor.test-14@2 isn't a conductor entry",
    );
    const red = conductors();
    red[0]['colour'] = { base: 'red', stripe: null };
    expect(messages({ cables: [cable({ conductors: red })] }).join()).toContain("isn't made in that colour");
    const insulated = conductors();
    insulated[2]['insulated'] = true;
    expect(messages({ cables: [cable({ conductors: insulated })] }).join()).toContain('insulated must match');
    const jacket = { ...(cable()['jacket'] as object), material: copper };
    expect(messages({ cables: [cable({ jacket })] }).join()).toContain('Must pin a row of the insulation table');
    expect(messages({ cables: [cable({ sources: source(['jacket']) })] }).join()).toContain(
      'conductors.0: Has no source',
    );
  });

  it('tools: capabilities match holes, dies, torque and bore size; ids unique; coverage per hole', () => {
    expect(messages({ tools: [tool({ holes: [] })] }).join()).toContain('holes exactly when it can strip');
    expect(messages({ tools: [tool({ torque: { minNm: 1, maxNm: 6, accuracyFraction: 0.06 } })] }).join()).toContain(
      'torque range exactly when it can torque',
    );
    expect(messages({ tools: [tool({ boreDiameterMm: 22 })] }).join()).toContain(
      'bore diameter exactly when it can bore',
    );
    const twice = tool({
      holes: [
        { id: 'h', awg: 14, stranding: 'solid' },
        { id: 'h', awg: 12, stranding: 'solid' },
      ],
    });
    expect(messages({ tools: [twice] }).join()).toContain('Hole ids must be unique');
    expect(messages({ tools: [tool({ sources: source(['capabilities', 'holes.sol-14']) })] }).join()).toContain(
      'holes.sol-12: Has no source',
    );
    const dup = tool({
      capabilities: [
        { step: 'strip', maxAwg: 10 },
        { step: 'strip', maxAwg: 12 },
      ],
    });
    expect(messages({ tools: [dup] }).join()).toContain('Each step is listed once');
    const driver = tool({
      id: 'tool.test-torque',
      kind: 'torqueDriver',
      capabilities: [
        { step: 'drive', maxAwg: null },
        { step: 'torque', maxAwg: null },
      ],
      holes: [],
      torque: { minNm: 0.4, maxNm: 6, accuracyFraction: 0.06 },
      sources: source(['capabilities', 'torque']),
    });
    expect(messages({ tools: [tool(), driver] })).toStrictEqual([]);
  });

  it('accessories: a lug has a stud size and a ferrule none', () => {
    expect(messages({ accessories: [ferrule({ studDiameterMm: 4 })] }).join()).toContain('null exactly for a ferrule');
    const ring = ferrule({
      id: 'lug.test-ring',
      kind: 'ringLug',
      studDiameterMm: 4.2,
      sources: source(['awgRange', 'stranding', 'dies', 'barrelLengthMm', 'studDiameterMm']),
    });
    expect(messages({ accessories: [ferrule(), ring] })).toStrictEqual([]);
    expect(messages({ accessories: [ferrule(), { ...ring, sources: ferrule()['sources'] }] }).join()).toContain(
      'studDiameterMm: Has no source',
    );
  });

  it('category goes with the kind: conductor, enclosure, lead', () => {
    expect(
      messages({ devices: [conductor('conductor.test-14', { category: 'lead' }), bareConductor(), box()] }).join(),
    ).toContain('Category "conductor" goes with conductor kinds');
    expect(
      messages({ devices: [conductor('conductor.test-14'), bareConductor(), box({ category: 'load' })] }).join(),
    ).toContain('Category "enclosure" goes with enclosure kinds');
  });

  it('a connection mounts on nothing; mount types are registered and declared once', () => {
    expect(
      messages({
        devices: [conductor('conductor.test-14', { mounts: [{ type: 'din35', widthMm: 9 }] }), bareConductor(), box()],
      }).join(),
    ).toContain('A connection mounts on nothing');
    expect(
      messages({
        devices: [conductor('conductor.test-14'), bareConductor(), box({ mounts: [{ type: 'shelf', widthMm: 9 }] })],
      }).join(),
    ).toContain('mounts.shelf: Unknown mount type');
  });
});
