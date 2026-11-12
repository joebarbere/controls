import { BUILTIN_CATALOG } from './builtin';
import { parseCatalog } from './catalog';
import { gaugeRow } from './gauge';
import { CAMEL_ID_PATTERN } from './registries';
import { type ColourRow, type InsulationRow, type MaterialRow, TABLE_KINDS } from './tables';

/*
 * The P3 tables (content/tables): their values recomputed by hand where they are derived, the colour
 * ids pinned (append-only, ADR 0015), and the table rules of parseCatalog. Hand calculations are
 * written out; tolerance at most 0.5 %.
 */

const material = (key: string) =>
  BUILTIN_CATALOG.tableRow({ table: 'materials', version: 1, key }) as MaterialRow | undefined;
const insulation = (key: string) =>
  BUILTIN_CATALOG.tableRow({ table: 'insulation', version: 1, key }) as InsulationRow | undefined;
const relative = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
const copper = material('copperAnnealed') as MaterialRow;
const aluminium = material('aluminiumAa8000') as MaterialRow;

/** R = ρ₀ · L / A · (1 + α (T − T₀)): the derivation the conductor model will use (F3.1), `+ − × ÷` only. */
const resistanceOhm = (m: MaterialRow, lengthM: number, areaMm2: number, temperatureK: number) =>
  ((m.resistivityOhmM * lengthM) / (areaMm2 * 1e-6)) *
  (1 + m.temperatureCoefficientPerK * (temperatureK - m.referenceTemperatureK));

describe('materials v1', () => {
  it('copper is the IACS: 1/58 Ω·mm²/m at 20 °C, α 0.00393/K', () => {
    // 1/58 Ω·mm²/m = 1/58 × 1e-6 Ω·m = 1.724138e-8 Ω·m.
    expect(copper.resistivityOhmM).toBe(1 / 58e6);
    expect(copper.conductivityIacsPercent).toBe(100);
    expect([copper.referenceTemperatureK, copper.temperatureCoefficientPerK]).toStrictEqual([293.15, 0.00393]);
    // The linear-α clamp: 200 °C = 473.15 K.
    expect(copper.linearAlphaMaxK).toBe(200 + 273.15);
  });

  it('aluminium is the 8000-series grade at 61.0 % IACS: its resistivity is the copper standard ÷ 0.610', () => {
    // ρ_Al = ρ_Cu / 0.610 = 1.724138e-8 / 0.610 = 2.826456e-8 Ω·m; HB109 states 0.028264 Ω·mm²/m.
    expect(relative(aluminium.resistivityOhmM, copper.resistivityOhmM / 0.61)).toBeLessThan(0.005);
    expect(aluminium.conductivityIacsPercent).toBe(61);
    // Al/Cu resistance ratio for equal geometry: 2.8264 / 1.724138 = 1.63931 (pre-audit: 1/0.610 = 1.6393).
    expect(relative(aluminium.resistivityOhmM / copper.resistivityOhmM, 1.6393)).toBeLessThan(0.005);
  });

  it('densities and specific heats as derived (HB100, HB109; NIST-JANAF molar heat ÷ molar mass)', () => {
    expect([copper.densityKgM3, aluminium.densityKgM3]).toStrictEqual([8890, 2703]);
    // Cu: 24.47 J/(mol·K) ÷ 0.063546 kg/mol = 385.1 J/(kg·K); Al: 24.21 ÷ 0.026982 = 897.3 J/(kg·K).
    expect(relative(copper.specificHeatJPerKgK, 24.47 / 0.063546)).toBeLessThan(0.005);
    expect(relative(aluminium.specificHeatJPerKgK, 24.21 / 0.026982)).toBeLessThan(0.005);
  });

  it('the plan golden: 30 m of 14 AWG solid copper is 0.248565 Ω at 20 °C', () => {
    // A = 2.08091 mm² (gauge table); R = 1.724138e-8 × 30 / 2.08091e-6 = 0.248565 Ω.
    const area = gaugeRow(14)?.areaMm2 as number;
    expect(relative(resistanceOhm(copper, 30, area, 293.15), 0.248565)).toBeLessThan(0.005);
    // Per metre: 8.2855 mΩ/m.
    expect(relative(resistanceOhm(copper, 1, area, 293.15), 0.0082855)).toBeLessThan(0.005);
    // At 75 °C: × (1 + 0.00393 × 55) = × 1.21615 → 0.302291 Ω.
    expect(relative(resistanceOhm(copper, 30, area, 348.15), 0.302291)).toBeLessThan(0.005);
  });

  it('per-metre resistance of 18, 12, 4 and 4/0 copper and aluminium (hand calculation, 20 °C)', () => {
    // R/m = ρ / A. Cu: 18 → 1.724138e-8 / 0.823047e-6 = 20.948 mΩ/m; 12 → 5.2108; 4 → 0.81517; 4/0 → 0.16080.
    // Al (ρ 2.8264e-8): 4 → 1.3363 mΩ/m; 4/0 → 0.26361 mΩ/m.
    const goldens: [MaterialRow, number, number][] = [
      [copper, 18, 0.020948],
      [copper, 12, 0.0052108],
      [copper, 4, 0.00081517],
      [copper, -3, 0.0001608],
      [aluminium, 4, 0.0013363],
      [aluminium, -3, 0.00026361],
    ];
    for (const [metal, awg, perMetre] of goldens) {
      expect(relative(resistanceOhm(metal, 1, gaugeRow(awg)?.areaMm2 as number, 293.15), perMetre)).toBeLessThan(0.005);
    }
  });
});

describe('insulation v1', () => {
  const celsius = (k: number | null) => (k === null ? null : Math.round((k - 273.15) * 100) / 100);

  it('ratings (UL-listed types, paraphrased): THHN/THWN-2 and XHHW-2 90 °C wet and dry; MTW 90 dry, 60 wet; NM-B dry only', () => {
    const ratings = Object.fromEntries(
      ['thhnThwn2', 'xhhw2', 'mtw', 'nmbJacket'].map((key) => {
        const row = insulation(key) as InsulationRow;
        return [key, [celsius(row.ratedTempDryK), celsius(row.ratedTempWetK)]];
      }),
    );
    expect(ratings).toStrictEqual({ thhnThwn2: [90, 90], xhhw2: [90, 90], mtw: [90, 60], nmbJacket: [90, null] });
  });

  it('THHN has a nylon jacket layer; the others are single layers; every surface ε = 0.9', () => {
    expect(insulation('thhnThwn2')?.jacketThermalConductivityWPerMK).toBe(0.25);
    for (const key of ['xhhw2', 'mtw', 'nmbJacket'])
      expect(insulation(key)?.jacketThermalConductivityWPerMK).toBeNull();
    const table = BUILTIN_CATALOG.table('insulation', 1);
    for (const row of Object.values(table?.rows ?? {})) expect((row as InsulationRow).emissivity).toBe(0.9);
  });

  it('the unverified XLPE conductivity is labelled game-design, never posing as a measurement', () => {
    const source = BUILTIN_CATALOG.table('insulation', 1)?.sources.find((s) =>
      s.covers.includes('rows.xhhw2.thermalConductivityWPerMK'),
    );
    expect(source?.kind).toBe('game-design');
    expect(source?.citation).toMatch(/^game-design: unverified/);
  });
});

describe('colours v1', () => {
  it('pins the shipped ids (append-only: a later version may add, never remove or rename)', () => {
    expect(BUILTIN_CATALOG.colourIds).toStrictEqual([
      'bare',
      'black',
      'blue',
      'brown',
      'green',
      'grey',
      'orange',
      'pink',
      'purple',
      'red',
      'white',
      'yellow',
    ]);
    for (const id of BUILTIN_CATALOG.colourIds) expect(CAMEL_ID_PATTERN.test(id)).toBe(true);
    expect((BUILTIN_CATALOG.colour('green') as ColourRow).name).toBe('Green');
    expect(BUILTIN_CATALOG.colour('toString')).toBeUndefined();
  });
});

describe('table rules in parseCatalog', () => {
  const colours = (version: number, ids: string[]) => ({
    table: 'colours',
    version,
    title: 'Colours',
    rows: Object.fromEntries(ids.map((id) => [id, { name: id, srgb: '#000000' }])),
    sources: [{ id: 'd', kind: 'game-design', citation: 'game-design: test', covers: ['rows.*.srgb'] }],
    extensions: {},
  });
  const messages = (tables: unknown[]) => {
    const result = parseCatalog(1, { tables });
    return result.ok ? [] : result.issues.map((i) => `${i.path}: ${i.message}`);
  };

  it('accepts colour ids that only grow, and refuses a later version that drops one', () => {
    expect(messages([colours(1, ['black', 'white']), colours(2, ['black', 'white', 'red'])])).toStrictEqual([]);
    expect(messages([colours(2, ['black']), colours(1, ['black', 'white'])]).join()).toContain(
      'Colour ids are append-only: missing white of version 1',
    );
  });

  it('refuses an unknown table, a bad row, a bad key, an empty table and a duplicate version', () => {
    expect(messages([{ ...colours(1, ['black']), table: 'gauges' }]).join()).toContain('Unknown table');
    const badRow = colours(1, ['black']);
    (badRow.rows['black'] as Record<string, unknown>)['srgb'] = 'black';
    expect(messages([badRow]).join()).toContain('rows.black.srgb');
    expect(messages([colours(1, ['Black'])]).join()).toContain('rows.Black');
    expect(messages([colours(1, [])]).join()).toContain('A table has at least one row');
    expect(messages([colours(1, ['black']), colours(1, ['black'])]).join()).toContain('Duplicate table');
  });

  it('every sourced field of every row is covered, and every cover covers something', () => {
    const uncovered = {
      ...colours(1, ['black']),
      sources: [{ id: 'd', kind: 'game-design', citation: 'x', covers: ['rows.white'] }],
    };
    const found = messages([uncovered]).join('\n');
    expect(found).toContain('rows.black.srgb: Has no source');
    expect(found).toContain("A source covers rows.white, which the entry doesn't have");
  });

  it('every table kind lists only real row fields as sourced', () => {
    for (const kind of Object.values(TABLE_KINDS)) {
      // Zod 4's refine keeps the object schema, so its shape is there to read.
      const fields = Object.keys((kind.row as unknown as { shape: Record<string, unknown> }).shape);
      for (const field of kind.sourced) expect(fields, kind.name).toContain(field);
    }
  });
});
