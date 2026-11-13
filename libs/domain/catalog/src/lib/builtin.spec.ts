import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_CATALOG, CATALOG_VERSION } from './builtin';
import { leadResistanceOhm } from './lead';
import { LeadParams, modelKind } from './model-kinds';
import { parseCatalog } from './catalog';

/*
 * `content/devices/*.json` is the catalogue's source of truth (plan P2 decision D4). Domain code can't
 * import `content/`, so `builtin-devices.generated.ts` mirrors it; content-mirrors.spec.ts fails when
 * that mirror is stale (regenerate with `pnpm nx test catalog -u`).
 */

const contentDir = join(import.meta.dirname, '../../../../../content');
const read = (dir: string) => {
  const names = readdirSync(join(contentDir, dir))
    .filter((name) => name.endsWith('.json'))
    .sort();
  return { names, documents: names.map((n) => JSON.parse(readFileSync(join(contentDir, dir, n), 'utf8')) as unknown) };
};
const devices = read('devices');
const tables = read('tables');
/** The P2 entries (catalogue 1's, version 1 in catalogue 2); F3.1's conductors are checked in conductors.spec.ts. */
const tools = read('tools');
const PART_2_KINDS = /^(raceway|terminalBlock)\./;
const p2Devices = BUILTIN_CATALOG.devices.filter(
  (d) => d.model.kind !== 'conductor' && d.model.kind !== 'splice.twistOn' && !PART_2_KINDS.test(d.model.kind),
);
const raceways = BUILTIN_CATALOG.devices.filter((d) => d.model.kind.startsWith('raceway.'));
const terminalBlocks = BUILTIN_CATALOG.devices.filter((d) => d.model.kind.startsWith('terminalBlock.'));
const splices = BUILTIN_CATALOG.devices.filter((d) => d.model.kind === 'splice.twistOn');

const size = (widthMm: number, heightMm: number, depthMm: number) => ({ widthMm, heightMm, depthMm });

describe('the built-in catalogue (content/devices, content/tables, content/tools)', () => {
  it('is catalogue version 2 and every file is a valid entry or table', () => {
    expect(CATALOG_VERSION).toBe(2);
    const result = parseCatalog(CATALOG_VERSION, {
      devices: devices.documents,
      tools: tools.documents,
      tables: tables.documents,
    });
    expect(result.ok ? 'ok' : result.issues).toBe('ok');
    expect(BUILTIN_CATALOG.version).toBe(CATALOG_VERSION);
  });

  it('names each file <id>.v<version>.json (tables <table>.v<version>.json)', () => {
    expect(devices.names).toStrictEqual(BUILTIN_CATALOG.devices.map((d) => `${d.id}.v${d.version}.json`));
    expect(tables.names).toStrictEqual(BUILTIN_CATALOG.tables.map((t) => `${t.table}.v${t.version}.json`));
    expect(tools.names).toStrictEqual(BUILTIN_CATALOG.tools.map((t) => `${t.id}.v${t.version}.json`));
  });

  it('holds the P3 tables: materials, insulation and colours, version 1 each', () => {
    expect(BUILTIN_CATALOG.tables.map((t) => `${t.table}@${t.version}`)).toStrictEqual([
      'colours@1',
      'insulation@1',
      'materials@1',
    ]);
  });

  it('every P2 entry is still version 1: catalogue v2 only gave them data (ADR 0015)', () => {
    expect(BUILTIN_CATALOG.devices.every((d) => d.version === 1)).toBe(true);
  });

  it('termination methods only where a conductor really lands; clip-only elsewhere', () => {
    const landed = BUILTIN_CATALOG.devices.flatMap((d) =>
      d.terminals
        .filter((t) => t.methods.length > 0)
        .map((t) => `${d.id}:${t.id}:${t.methods.map((m) => m.method).join(',')}`),
    );
    expect(landed).toStrictEqual([
      'breaker.saltmere-1p-15a:line:screw',
      'breaker.saltmere-1p-15a:load:screw',
      'heater.hearthvale-120v-1500w:a:screw',
      'heater.hearthvale-120v-1500w:b:screw',
      'lamp.lumivane-120v-60w:a:screw',
      'lamp.lumivane-120v-60w:b:screw',
      'splice.corvelle-tw-l:splice:twistOn',
      'splice.corvelle-tw-m:splice:twistOn',
      'splice.corvelle-tw-s:splice:twistOn',
      'supply.railwick-din-24v-5a:neg:screw',
      'supply.railwick-din-24v-5a:pos:screw',
      'tb.quennick-pe4:a:screw',
      'tb.quennick-pe4:b:screw',
      'tb.quennick-sc25:a:springCage',
      'tb.quennick-sc25:b:springCage',
      'tb.quennick-st4:a:screw',
      'tb.quennick-st4:b:screw',
      'utility.larkmoor-split-phase-25kva:l1:screw',
      'utility.larkmoor-split-phase-25kva:l2:screw',
      'utility.larkmoor-split-phase-25kva:n:screw',
    ]);
    const breaker = BUILTIN_CATALOG.device({ id: 'breaker.saltmere-1p-15a', version: 1 });
    expect(breaker?.terminals[0].methods[0]).toMatchObject({
      awgRange: { smallest: 14, largest: 10 },
      torqueNm: 4,
      drives: ['slotted', 'square'],
      alRated: true,
      ratedConductors: 1,
      maxConductors: 2,
    });
    const psu = BUILTIN_CATALOG.device({ id: 'supply.railwick-din-24v-5a', version: 1 });
    expect(psu?.terminals[0].methods[0]).toMatchObject({
      awgRange: { smallest: 24, largest: 12 },
      torqueNm: 0.5,
      drives: ['slotted', 'pozidriv'],
      alRated: false,
      stranding: ['solid', 'stranded', 'strandedFerrule'],
    });
  });

  it('the breaker, the DIN supply and the terminal blocks fit a DIN rail; the boxes a stud flange; ducts a backplate; nothing else declares a mount', () => {
    expect(BUILTIN_CATALOG.devices.filter((d) => d.mounts.length > 0).map((d) => [d.id, d.mounts])).toStrictEqual([
      ['box.tinmoor-1g-steel', [{ type: 'studFlange', widthMm: 51, crossMm: 0 }]],
      ['box.tinmoor-2g-nm', [{ type: 'studFlange', widthMm: 102, crossMm: 0 }]],
      ['box.tinmoor-4rd-nm-ceiling', [{ type: 'studFlange', widthMm: 102, crossMm: 0 }]],
      ['box.tinmoor-4sq-steel', [{ type: 'studFlange', widthMm: 102, crossMm: 0 }]],
      ['breaker.saltmere-1p-15a', [{ type: 'din35', widthMm: 40, crossMm: 0 }]],
      ['duct.lattisby-25x40', [{ type: 'backplate', widthMm: 2000, crossMm: 0 }]],
      ['duct.lattisby-40x60', [{ type: 'backplate', widthMm: 2000, crossMm: 0 }]],
      ['duct.lattisby-60x80', [{ type: 'backplate', widthMm: 2000, crossMm: 0 }]],
      ['supply.railwick-din-24v-5a', [{ type: 'din35', widthMm: 40, crossMm: 0 }]],
      // Centred on the rail: 45 − ⌊height / 2⌋ above the mount origin (48 mm and 56 mm tall).
      ['tb.quennick-pe4', [{ type: 'din35', widthMm: 6, crossMm: 21 }]],
      ['tb.quennick-sc25', [{ type: 'din35', widthMm: 5, crossMm: 17 }]],
      ['tb.quennick-st4', [{ type: 'din35', widthMm: 6, crossMm: 21 }]],
    ]);
    for (const d of terminalBlocks) {
      const size = d.sizeMm as NonNullable<typeof d.sizeMm>;
      expect(d.mounts[0].crossMm).toBe(45 - Math.floor(size.heightMm / 2));
    }
    // A declared width never exceeds the body: the declaration is the footprint along the rail.
    for (const d of BUILTIN_CATALOG.devices)
      for (const m of d.mounts) expect(m.widthMm).toBeLessThanOrEqual(d.sizeMm?.widthMm ?? 0);
  });

  it('only the F3.5 boxes and panel are enclosures; only the conductor kind’s entries carry conductor data', () => {
    expect(BUILTIN_CATALOG.devices.filter((d) => d.enclosure !== null).map((d) => d.id)).toStrictEqual([
      'box.tinmoor-1g-steel',
      'box.tinmoor-2g-nm',
      'box.tinmoor-4rd-nm-ceiling',
      'box.tinmoor-4sq-steel',
      'panel.pellmoor-din-400x500',
    ]);
    expect(
      BUILTIN_CATALOG.devices.filter((d) => (d.conductor !== null) !== (d.model.kind === 'conductor')),
    ).toStrictEqual([]);
  });

  it('holds the P2 bench devices, the F2.4 supplies, the F2.5 loads and protection, one test lead, the F3.5 enclosures and the D12 120 V lamp and heater', () => {
    expect(p2Devices.map((d) => [d.id, d.model.kind])).toStrictEqual([
      ['battery.ferrovane-12v-7ah', 'battery'],
      ['box.tinmoor-1g-steel', 'enclosure.box'],
      ['box.tinmoor-2g-nm', 'enclosure.box'],
      ['box.tinmoor-4rd-nm-ceiling', 'enclosure.box'],
      ['box.tinmoor-4sq-steel', 'enclosure.box'],
      ['breaker.saltmere-1p-15a', 'breaker.thermalMagnetic'],
      ['fuse.emberlyn-5x20-fa-1a', 'fuse'],
      ['heater.hearthvale-120v-1500w', 'heater'],
      ['heater.hearthvale-12v-50w', 'heater'],
      ['lamp.lumivane-120v-60w', 'lamp.incandescent'],
      ['lamp.lumivane-12v-5w', 'lamp.incandescent'],
      ['lead.quillfern-test-1m', 'lead'],
      ['panel.pellmoor-din-400x500', 'enclosure.panel'],
      ['resistor.orrinwood-10r-10w', 'resistor'],
      ['supply.brindlecore-bench-30v-5a', 'supply.bench'],
      ['supply.railwick-din-24v-5a', 'supply.dinPsu'],
      ['switch.tessaline-spst-toggle', 'switch.spst'],
      ['utility.larkmoor-208y120-150kva', 'utility.threePhase'],
      ['utility.larkmoor-480y277-1000kva', 'utility.threePhase'],
      ['utility.larkmoor-split-phase-25kva', 'utility.splitPhase'],
    ]);
  });

  it('uses fictional brands only (realism charter), one per maker (the utility serves three services, Tinmoor makes the boxes, Lumivane both lamps, Hearthvale both heaters)', () => {
    const brands = p2Devices.map((d) => d.brand);
    expect(brands).toStrictEqual([
      'Ferrovane',
      'Tinmoor',
      'Tinmoor',
      'Tinmoor',
      'Tinmoor',
      'Saltmere',
      'Emberlyn',
      'Hearthvale',
      'Hearthvale',
      'Lumivane',
      'Lumivane',
      'Quillfern',
      'Pellmoor',
      'Orrinwood',
      'Brindlecore',
      'Railwick',
      'Tessaline',
      'Larkmoor Power',
      'Larkmoor Power',
      'Larkmoor Power',
    ]);
  });

  it('F3.5 part 2: Lattisby ducts, Stavenor EMT parts and Quennick terminal blocks, by kind and size', () => {
    expect(raceways.map((d) => [d.id, d.brand, d.category, d.model.kind, d.sizeMm])).toStrictEqual([
      ['connector.stavenor-emt-050', 'Stavenor', 'raceway', 'raceway.conduitConnector', size(22, 28, 28)],
      ['connector.stavenor-emt-075', 'Stavenor', 'raceway', 'raceway.conduitConnector', size(25, 34, 34)],
      ['connector.stavenor-emt-100', 'Stavenor', 'raceway', 'raceway.conduitConnector', size(28, 42, 42)],
      ['duct.lattisby-25x40', 'Lattisby', 'raceway', 'raceway.duct', size(2000, 25, 40)],
      ['duct.lattisby-40x60', 'Lattisby', 'raceway', 'raceway.duct', size(2000, 40, 60)],
      ['duct.lattisby-60x80', 'Lattisby', 'raceway', 'raceway.duct', size(2000, 60, 80)],
      // An elbow's box is L + R + D/2 square: 64 + 102 + 9, 64 + 114 + 12, 76 + 146 + 15.
      ['elbow.stavenor-emt-050', 'Stavenor', 'raceway', 'raceway.conduitElbow', size(175, 175, 18)],
      ['elbow.stavenor-emt-075', 'Stavenor', 'raceway', 'raceway.conduitElbow', size(190, 190, 24)],
      ['elbow.stavenor-emt-100', 'Stavenor', 'raceway', 'raceway.conduitElbow', size(237, 237, 30)],
      ['emt.stavenor-050', 'Stavenor', 'raceway', 'raceway.conduit', size(3048, 18, 18)],
      ['emt.stavenor-075', 'Stavenor', 'raceway', 'raceway.conduit', size(3048, 24, 24)],
      ['emt.stavenor-100', 'Stavenor', 'raceway', 'raceway.conduit', size(3048, 30, 30)],
    ]);
    // EMT outside diameters and walls, inches × 25.4 to 0.01 mm (ANSI C80.3 by number; unverified,
    // for electrical-realism-reviewer): 0.706 in → 17.93, 0.922 → 23.42, 1.163 → 29.54 mm; walls
    // 0.042 → 1.07, 0.049 → 1.24, 0.057 → 1.45 mm. The body diameter is the OD rounded up to even.
    const tube = raceways
      .filter((d) => d.model.kind === 'raceway.conduit')
      .map((d) => [
        d.model.params['tradeSizeIn'],
        d.model.params['outsideDiameterMm'],
        d.model.params['wallThicknessMm'],
      ]);
    expect(tube).toStrictEqual([
      [0.5, 17.93, 1.07],
      [0.75, 23.42, 1.24],
      [1, 29.54, 1.45],
    ]);
    // Makers' standard 90° elbows (realism review 2026-11-12): 4.00, 4.50, 5.75 in radius → 102, 114,
    // 146 mm (× 25.4, rounded); legs 2.5, 2.5, 3.0 in → 64, 64, 76 mm.
    const elbows = raceways.filter((d) => d.model.kind === 'raceway.conduitElbow');
    expect(elbows.map((d) => [d.model.params['bendRadiusMm'], d.model.params['legLengthMm']])).toStrictEqual([
      [102, 64],
      [114, 64],
      [146, 76],
    ]);
    // Terminal blocks: the 4 mm² class is 47.5 mm high on the rail, drawn 47 (review required change 1).
    expect(terminalBlocks.map((d) => [d.id, d.sizeMm])).toStrictEqual([
      ['tb.quennick-pe4', size(6, 48, 47)],
      ['tb.quennick-sc25', size(5, 56, 36)],
      ['tb.quennick-st4', size(6, 48, 47)],
    ]);
    expect(terminalBlocks.map((d) => [d.id, d.brand, d.category, d.model.kind])).toStrictEqual([
      ['tb.quennick-pe4', 'Quennick', 'terminalBlock', 'terminalBlock.ground'],
      ['tb.quennick-sc25', 'Quennick', 'terminalBlock', 'terminalBlock.feedThrough'],
      ['tb.quennick-st4', 'Quennick', 'terminalBlock', 'terminalBlock.feedThrough'],
    ]);
    for (const d of terminalBlocks) {
      for (const t of d.terminals) {
        const m = t.methods[0];
        // ADR 0018 §8 fields on every clamp; screw clamps are rising cages (boxLug) at 0.6 N·m.
        expect([m.contactOhm, m.combination, m.alRated]).toStrictEqual([3e-4, null, false]);
        if (m.method === 'screw') {
          expect([m.clampType, m.clampDepthMm, m.torqueNm, m.heatPathWPerK, m.hotSpotHeatCapacityJPerK]).toStrictEqual([
            'boxLug',
            8,
            0.6,
            0.026,
            0.5,
          ]);
        } else {
          expect([m.method, m.clampType, m.clampDepthMm, m.torqueNm, m.drives]).toStrictEqual([
            'springCage',
            'springCage',
            9,
            null,
            [],
          ]);
        }
      }
    }
  });

  it('F3.3: three Corvelle twist-on splices, combinations inside their own ranges (ADR 0018 §4.4)', () => {
    // Areas from AWG_GAUGES.areaUm2: 22 AWG 325 534, 18 AWG 823 047, 14 AWG 2 080 910, 12 AWG 3 308 770.
    const combination = (n: [number, number], awg: [number, number], area: [number, number]) => ({
      minConductors: n[0],
      maxConductors: n[1],
      awg: { smallest: awg[0], largest: awg[1] },
      totalAreaUm2: { min: area[0], max: area[1] },
    });
    expect(splices.map((d) => [d.id, d.brand, d.category, d.terminals[0].methods[0].combination])).toStrictEqual([
      ['splice.corvelle-tw-l', 'Corvelle', 'splice', combination([2, 5], [14, 10], [2 * 2080910, 5 * 3308770])],
      ['splice.corvelle-tw-m', 'Corvelle', 'splice', combination([2, 4], [18, 12], [2 * 823047, 3 * 3308770])],
      ['splice.corvelle-tw-s', 'Corvelle', 'splice', combination([2, 3], [22, 14], [2 * 325534, 2 * 2080910])],
    ]);
    for (const d of splices) {
      const m = d.terminals[0].methods[0];
      expect([m.method, m.clampType, m.torqueNm, m.alRated, m.contactOhm]).toStrictEqual([
        'twistOn',
        'twistOn',
        null,
        false,
        5e-4,
      ]);
      expect(m.ratedConductors).toBe(m.maxConductors);
    }
  });

  it('resolves refs to the entry and its model kind', () => {
    const ref = { id: 'switch.tessaline-spst-toggle', version: 1 };
    expect(BUILTIN_CATALOG.device(ref)?.title).toBe('SPST toggle switch on a base');
    expect(BUILTIN_CATALOG.kindOf(ref)).toBe(modelKind('switch.spst'));
    expect(BUILTIN_CATALOG.device({ ...ref, version: 2 })).toBeUndefined();
    expect(BUILTIN_CATALOG.kindOf({ id: 'prop.crate', version: 1 })).toBeUndefined();
    expect(BUILTIN_CATALOG.family(ref)).toBe('device');
    expect(BUILTIN_CATALOG.family({ id: 'tool.none', version: 1 })).toBeUndefined();
  });

  it('the 18 AWG test lead is about 41 mΩ at 20 °C, derived from resistivity (never a table)', () => {
    const lead = BUILTIN_CATALOG.device({ id: 'lead.quillfern-test-1m', version: 1 });
    const params = LeadParams.parse(lead?.model.params);
    // 18 AWG: d = 0.127 mm × 92^(18/39) ≈ 1.0237 mm, A = π d²/4 ≈ 8.2305e-7 m² (the AWG formula, no table).
    const d = 0.127e-3 * 92 ** ((36 - 18) / 39);
    expect(params.conductorAreaM2).toBeCloseTo((Math.PI * d * d) / 4, 10);
    // ρ L / A = (1/58e6 Ω·m × 1 m) / 8.2305e-7 m² ≈ 20.95 mΩ, plus 2 × 10 mΩ of clip contact.
    expect(leadResistanceOhm(params, 293.15)).toBeCloseTo(1 / 58e6 / 8.2305e-7 + 0.02, 15);
    expect(leadResistanceOhm(params, 293.15)).toBeCloseTo(0.04095, 5);
  });
});
