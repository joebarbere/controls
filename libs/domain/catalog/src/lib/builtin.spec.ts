import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_CATALOG, CATALOG_VERSION } from './builtin';
import { BUILTIN_DEVICE_DOCUMENTS } from './builtin-devices.generated';
import { leadResistanceOhm } from './lead';
import { LeadParams, modelKind } from './model-kinds';
import { parseCatalog } from './catalog';

/*
 * `content/devices/*.json` is the catalogue's source of truth (plan P2 decision D4). Domain code can't
 * import `content/`, so `builtin-devices.generated.ts` mirrors it. If this test fails, the mirror is
 * stale: regenerate it with `pnpm nx test catalog -u` and commit both. In CI a missing file fails too.
 */

const devicesDir = join(import.meta.dirname, '../../../../../content/devices');
const files = readdirSync(devicesDir)
  .filter((name) => name.endsWith('.json'))
  .sort();
const documents = files.map((name) => JSON.parse(readFileSync(join(devicesDir, name), 'utf8')) as unknown);

/** The text of the generated module: a pure function of the sorted files. */
function generatedModule(): string {
  const body = documents.map((document) => JSON.stringify(document, null, 2)).join(',\n');
  return [
    '/*',
    ' * GENERATED from content/devices/*.json by builtin.spec.ts: do not edit. Edit the JSON files and',
    ' * regenerate with `pnpm nx test catalog -u` (plan P2 decision D4).',
    ' */',
    'export const BUILTIN_DEVICE_DOCUMENTS: readonly unknown[] = [',
    body,
    '];',
    '',
  ].join('\n');
}

describe('the built-in catalogue (content/devices)', () => {
  it('the generated mirror is up to date', async () => {
    await expect(generatedModule()).toMatchFileSnapshot(join(import.meta.dirname, 'builtin-devices.generated.ts'));
    expect(BUILTIN_DEVICE_DOCUMENTS).toStrictEqual(documents);
  });

  it('is catalogue version 1 and every file is a valid entry', () => {
    expect(CATALOG_VERSION).toBe(1);
    const result = parseCatalog(CATALOG_VERSION, documents);
    expect(result.ok ? 'ok' : result.issues).toBe('ok');
    expect(BUILTIN_CATALOG.version).toBe(CATALOG_VERSION);
  });

  it('names each file <id>.v<version>.json', () => {
    expect(files).toStrictEqual(BUILTIN_CATALOG.devices.map((d) => `${d.id}.v${d.version}.json`));
  });

  it('holds the P2 bench devices, the F2.4 supplies and one test lead (plan P2)', () => {
    expect(BUILTIN_CATALOG.devices.map((d) => [d.id, d.model.kind])).toStrictEqual([
      ['battery.ferrovane-12v-7ah', 'battery'],
      ['lamp.lumivane-12v-5w', 'lamp.incandescent'],
      ['lead.quillfern-test-1m', 'lead'],
      ['supply.brindlecore-bench-30v-5a', 'supply.bench'],
      ['supply.railwick-din-24v-5a', 'supply.dinPsu'],
      ['switch.tessaline-spst-toggle', 'switch.spst'],
      ['utility.larkmoor-208y120-150kva', 'utility.threePhase'],
      ['utility.larkmoor-480y277-1000kva', 'utility.threePhase'],
      ['utility.larkmoor-split-phase-25kva', 'utility.splitPhase'],
    ]);
  });

  it('uses fictional brands only (realism charter), one per maker (the utility serves three services)', () => {
    const brands = BUILTIN_CATALOG.devices.map((d) => d.brand);
    expect(brands).toStrictEqual([
      'Ferrovane',
      'Lumivane',
      'Quillfern',
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
