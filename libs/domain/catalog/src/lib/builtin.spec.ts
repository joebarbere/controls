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
const p2Devices = BUILTIN_CATALOG.devices.filter((d) => d.model.kind !== 'conductor');
const tools = read('tools');

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
      'supply.railwick-din-24v-5a:neg:screw',
      'supply.railwick-din-24v-5a:pos:screw',
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

  it('the breaker and the DIN supply fit a DIN rail; the F3.5 boxes fit a stud flange; nothing else declares a mount', () => {
    expect(BUILTIN_CATALOG.devices.filter((d) => d.mounts.length > 0).map((d) => [d.id, d.mounts])).toStrictEqual([
      ['box.tinmoor-1g-steel', [{ type: 'studFlange', widthMm: 51 }]],
      ['box.tinmoor-2g-nm', [{ type: 'studFlange', widthMm: 102 }]],
      ['box.tinmoor-4rd-nm-ceiling', [{ type: 'studFlange', widthMm: 102 }]],
      ['box.tinmoor-4sq-steel', [{ type: 'studFlange', widthMm: 102 }]],
      ['breaker.saltmere-1p-15a', [{ type: 'din35', widthMm: 40 }]],
      ['supply.railwick-din-24v-5a', [{ type: 'din35', widthMm: 40 }]],
    ]);
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

  it('holds the P2 bench devices, the F2.4 supplies, the F2.5 loads and protection, one test lead and the F3.5 enclosures', () => {
    expect(p2Devices.map((d) => [d.id, d.model.kind])).toStrictEqual([
      ['battery.ferrovane-12v-7ah', 'battery'],
      ['box.tinmoor-1g-steel', 'enclosure.box'],
      ['box.tinmoor-2g-nm', 'enclosure.box'],
      ['box.tinmoor-4rd-nm-ceiling', 'enclosure.box'],
      ['box.tinmoor-4sq-steel', 'enclosure.box'],
      ['breaker.saltmere-1p-15a', 'breaker.thermalMagnetic'],
      ['fuse.emberlyn-5x20-fa-1a', 'fuse'],
      ['heater.hearthvale-12v-50w', 'heater'],
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

  it('uses fictional brands only (realism charter), one per maker (the utility serves three services, Tinmoor makes the boxes)', () => {
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
