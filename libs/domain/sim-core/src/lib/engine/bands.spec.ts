import { BUILTIN_CATALOG, NEC_REGION } from '@controls/catalog';
import { decodeSnapshot, NOMINAL_BANDS } from '@controls/sim-protocol';
import fc from 'fast-check';
import { BATTERY, end, LAMP, LEAD, origin } from '../../testing/bench';
import { engineBus, engineTestOptions, GENERATOR } from '../../testing/engine';
import { BENCH_SUPPLY, DIN_PSU, UTILITY_208, UTILITY_480, UTILITY_SPLIT } from '../../testing/sources';
import { BUILTIN_DEVICE_MODELS } from './device-model';
import { DC_BAND_NOMINALS, islandNominalBands, SOURCE_BAND_RULES } from './bands';
import { SimEngine } from './engine';
import type { Netlist, NetlistBranch } from '../netlist/types';

/*
 * Nominal band selection (plan F2.6, protocol 5): each source's band from its nameplate, and the
 * island rule (agree → that band; none, all unrated, disagreeing or mixed → `none` with a reason).
 */

const band = (name: string) => NOMINAL_BANDS.indexOf(name);

type Commands = readonly (readonly [string, object])[];

function engineAfter(commands: Commands): SimEngine {
  const bus = engineBus();
  const engine = SimEngine.start(bus.state, engineTestOptions());
  for (const [id, args] of commands) {
    const result = bus.exec(id, args);
    if (!result.ok) throw new Error(`${id}: ${result.error.message}`);
    if (result.logged) engine.applied(result.entry, bus.state);
  }
  return engine;
}

const place = (ref: object): readonly [string, object] => ['entity.place', { ref, positionMm: origin }];
const lead = (a: [number, string], b: [number, string]): readonly [string, object] => [
  'lead.connect',
  { ref: LEAD, a: end(...a), b: end(...b) },
];
const bands = (engine: SimEngine) => engine.islandDiagnostics().map((i) => [NOMINAL_BANDS[i.band], i.bandReason]);

describe('nominal bands', () => {
  it('are the names the overlays look scales up by, in protocol 5 order, band 0 none', () => {
    expect([...NOMINAL_BANDS]).toStrictEqual(['none', 'dc12', 'dc24', 'ac120-240', 'ac208y120', 'ac480y277']);
  });

  it('every DC nominal has a source, and every built-in source model kind has a band rule', () => {
    for (const nominal of Object.values(DC_BAND_NOMINALS)) {
      expect(nominal.source.length).toBeGreaterThan(40);
      expect(nominal.unit).toBe('V');
    }
    // Every catalogue entry (built-in and test) that compiles to a source element, placed alone.
    const kinds = new Set<string>();
    for (const device of [...BUILTIN_CATALOG.devices, ...engineTestOptions().catalog.devices]) {
      if (device.category === 'lead') continue;
      const netlist = engineAfter([place({ id: device.id, version: device.version })]).netlist;
      for (const branch of netlist.branches) if (branch.source !== null) kinds.add(branch.model);
    }
    const builtIn = [...kinds].filter((kind) => kind in BUILTIN_DEVICE_MODELS).sort();
    expect(builtIn).toStrictEqual([
      'battery',
      'generator.portable',
      'supply.bench',
      'supply.dinPsu',
      'utility.splitPhase',
      'utility.threePhase',
    ]);
    for (const kind of builtIn) expect(SOURCE_BAND_RULES[kind], kind).toBeDefined();
  });

  it("take each source's band from its catalogue nameplate and the region's nominal systems", () => {
    const of = (ref: { id: string; version: number }) => {
      const device = engineTestOptions().catalog.device(ref) ?? BUILTIN_CATALOG.device(ref);
      if (!device) throw new Error(ref.id);
      return NOMINAL_BANDS[SOURCE_BAND_RULES[device.model.kind](device.model.params, NEC_REGION)];
    };
    expect(of(BATTERY)).toBe('dc12');
    expect(of(DIN_PSU)).toBe('dc24');
    expect(of(BENCH_SUPPLY)).toBe('none'); // adjustable: no fixed nominal
    expect(of(UTILITY_SPLIT)).toBe('ac120-240');
    expect(of(UTILITY_208)).toBe('ac208y120');
    expect(of(UTILITY_480)).toBe('ac480y277');
    expect(of(GENERATOR)).toBe('ac120-240'); // the stub's 120/240 V nameplate
    // A nameplate that is no band's nominal has no scale, never the nearest one.
    expect(SOURCE_BAND_RULES['battery']({ nominalVoltageV: 6 }, NEC_REGION)).toBe(0);
    // Exact, never "nearest within a volt": a nameplate a little off a nominal has no band.
    expect(SOURCE_BAND_RULES['battery']({ nominalVoltageV: 12.9 }, NEC_REGION)).toBe(0);
    expect(SOURCE_BAND_RULES['supply.dinPsu']({ ratedVoltageV: 24.5 }, NEC_REGION)).toBe(0);
    expect(SOURCE_BAND_RULES['supply.dinPsu']({ ratedVoltageV: 12 }, NEC_REGION)).toBe(band('dc12'));
    expect(SOURCE_BAND_RULES['utility.threePhase']({ lineToNeutralV: 347 }, NEC_REGION)).toBe(0);
    expect(SOURCE_BAND_RULES['utility.splitPhase']({ lineToNeutralV: 110 }, NEC_REGION)).toBe(0);
  });

  it('give an island the band its sources agree on, and say why when there is none', () => {
    // 1: a battery shorted by a lead; 2: a DIN PSU and a battery in parallel; 3: a bench supply and a
    // battery; 4: two batteries; 5: a lamp alone; 6: the split-phase service.
    const engine = engineAfter([
      place(BATTERY),
      lead([1, 'pos'], [1, 'neg']),
      place(DIN_PSU),
      place(BATTERY),
      lead([2, 'pos'], [3, 'pos']),
      lead([2, 'neg'], [3, 'neg']),
      place(BENCH_SUPPLY),
      place(BATTERY),
      lead([4, 'pos'], [5, 'pos']),
      lead([4, 'neg'], [5, 'neg']),
      place(BATTERY),
      place(BATTERY),
      lead([6, 'pos'], [7, 'pos']),
      lead([6, 'neg'], [7, 'neg']),
      place(LAMP),
      place(UTILITY_SPLIT),
      lead([9, 'l1'], [9, 'n']),
    ]);
    expect(bands(engine)).toStrictEqual([
      ['dc12', null],
      ['none', 'sources-disagree'],
      ['none', 'sources-disagree'],
      ['dc12', null],
      ['none', 'no-source'],
      ['ac120-240', null],
    ]);
    // The snapshot carries them (the hashed island entry, ADR 0011 §5.3).
    expect(decodeSnapshot(engine.snapshot()).islands.map((i) => i.band)).toStrictEqual([1, 0, 0, 1, 0, 3]);
  });

  it('follow the topology: wiring a 24 V supply into a 12 V island drops it to none, undoing restores it', () => {
    const bus = engineBus();
    const engine = SimEngine.start(bus.state, engineTestOptions());
    const exec = (id: string, args: object) => {
      const result = bus.exec(id, args);
      if (!result.ok) throw new Error(result.error.message);
      if (result.logged) engine.applied(result.entry, bus.state);
    };
    for (const [id, args] of [place(BATTERY), lead([1, 'pos'], [1, 'neg']), place(DIN_PSU)]) exec(id, args);
    expect(bands(engine)).toStrictEqual([
      ['dc12', null],
      ['dc24', null],
    ]);
    exec('lead.connect', { ref: LEAD, a: end(1, 'pos'), b: end(2, 'pos') });
    expect(bands(engine)).toStrictEqual([['none', 'sources-disagree']]);
    exec('edit.undo', {});
    expect(bands(engine)).toStrictEqual([
      ['dc12', null],
      ['dc24', null],
    ]);
  });

  it('the island rule: agreeing sources keep their band, anything else is none, whatever the order', () => {
    const sourceBranch = (index: number): NetlistBranch => ({
      index,
      element: { kind: 'entity', entity: index + 1, part: 'cell' },
      kind: 'vsource',
      model: 'test',
      source: 'dc',
      a: 0,
      b: 1,
      island: 0,
      values: {},
    });
    fc.assert(
      fc.property(fc.array(fc.nat({ max: NOMINAL_BANDS.length - 1 }), { maxLength: 6 }), fc.boolean(), (own, mixed) => {
        const netlist = {
          nodes: [],
          branches: own.map((_, i) => sourceBranch(i)),
          islands: [{ index: 0, kind: mixed ? 'mixed' : 'dc', nodes: [0, 1], branches: own.map((_, i) => i) }],
          devices: [],
          topologyHash: '',
          diagnostics: [],
        } as unknown as Netlist;
        const [result] = islandNominalBands(netlist, (b) => own[b.index]);
        const reversed = islandNominalBands(
          { ...netlist, islands: [{ ...netlist.islands[0], branches: [...netlist.islands[0].branches].reverse() }] },
          (b) => own[b.index],
        );
        expect(reversed[0]).toStrictEqual(result);
        const distinct = new Set(own);
        if (mixed) expect(result).toStrictEqual({ band: 0, reason: 'mixed' });
        else if (own.length === 0) expect(result).toStrictEqual({ band: 0, reason: 'no-source' });
        else if (distinct.size > 1) expect(result).toStrictEqual({ band: 0, reason: 'sources-disagree' });
        else if (own[0] === 0) expect(result).toStrictEqual({ band: 0, reason: 'unrated-source' });
        else expect(result).toStrictEqual({ band: own[0], reason: null });
      }),
      { numRuns: 200 },
    );
  });
});
