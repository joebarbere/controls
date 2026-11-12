import { BUILTIN_DEVICE_DOCUMENTS } from './builtin-devices.generated';
import { BUILTIN_TABLE_DOCUMENTS } from './builtin-tables.generated';
import { BUILTIN_CATALOG } from './builtin';
import { parseCatalog } from './catalog';
import { conductorPhysics } from './conductor';
import {
  conductanceToAirWPerMK,
  conductorTauMinS,
  conductorThermal,
  heatCapacityPerMetre,
  leadThermalLine,
  maxFinConductanceWPerK,
  thermalConductivityWPerMK,
} from './conductor-thermal';
import type { LeadParams } from './model-kinds';
import { LORENZ_NUMBER, THERMAL_MIN_TAU_S } from './thermal-constants';

/*
 * The load-time thermal time-constant check (F3.6 part 1, ADR 0018 §3.4): the catalogue refuses a
 * conductor, a lead or a terminal method whose conservative τ bound is below `THERMAL_MIN_TAU_S`
 * (100 steps of the bank's 10 ms step). Hand values are written out; tolerances 0.5 % or tighter.
 */

type Doc = Record<string, unknown> & { id: string; model: { kind: string; params: Record<string, number> } };
const docs = () => structuredClone(BUILTIN_DEVICE_DOCUMENTS) as Doc[];
const parse = (devices: readonly unknown[]) => parseCatalog(2, { devices, tables: BUILTIN_TABLE_DOCUMENTS });
const messages = (devices: readonly unknown[]) => {
  const result = parse(devices);
  return result.ok ? [] : result.issues.map((i) => `${i.path}: ${i.message}`);
};
const rel = (actual: number, expected: number) => Math.abs(actual / expected - 1);
const lead = () => BUILTIN_CATALOG.device({ id: 'lead.quillfern-test-1m', version: 1 })?.model.params as LeadParams;
const physics = (id: string) => {
  const device = BUILTIN_CATALOG.device({ id, version: 1 });
  const p = device && conductorPhysics(BUILTIN_CATALOG, device);
  if (!p) throw new Error(id);
  return p;
};

describe('thermal time constants (ADR 0018 §3.4)', () => {
  it('the minimum is 1 s, numerical', () => {
    expect([THERMAL_MIN_TAU_S.value, THERMAL_MIN_TAU_S.kind]).toStrictEqual([1, 'numerical']);
    expect(LORENZ_NUMBER.value).toBe(2.443004509e-8);
  });

  it('the built-in catalogue passes, with the hand bounds of ADR 0018 §3.4', () => {
    expect(parse(BUILTIN_DEVICE_DOCUMENTS).ok).toBe(true);
    // 14 AWG THHN: C′ = 8890 × 385 × 2.08091e-6 = 7.12222 J/(m·K); R′_ins = 0.391676 K·m/W (ADR 0018 §12 golden 3): 2.790 s.
    const thhn14 = conductorThermal(physics('conductor.tallowmere-thhn-14-solid'));
    expect(rel(heatCapacityPerMetre(thhn14.physics), 7.122219)).toBeLessThan(1e-5);
    expect(rel(conductorTauMinS(thhn14), 7.122219 * 0.391676)).toBeLessThan(1e-5);
    // 4/0 THHN: ADR 0018 §3.4 quotes 69.6 s.
    expect(
      rel(conductorTauMinS(conductorThermal(physics('conductor.tallowmere-thhn-4-0-stranded'))), 69.6),
    ).toBeLessThan(0.005);
    // Bare 14 AWG: C′ / G′(473.15 K) with ε 0.5, about 45 s.
    const bare = conductorThermal(physics('conductor.sorrelby-bare-14-solid'));
    const g = conductanceToAirWPerMK(bare, 473.15, 293.15);
    expect(conductorTauMinS(bare)).toBe(heatCapacityPerMetre(bare.physics) / g);
    expect(conductorTauMinS(bare)).toBeGreaterThan(40);
    expect(conductorTauMinS(bare)).toBeLessThan(50);
  });

  it("the lead's line: 18 AWG copper solid-round, one 0.8 mm PVC wall, τ_min ≈ 2.35 s", () => {
    const line = leadThermalLine(lead());
    // d = √(4 × 8.2305e-7 / π) = 1.023690 mm; r₁/r₀ = (0.511845 + 0.8) / 0.511845 = 2.562982.
    expect(rel(line.diameterM, 1.02369e-3)).toBeLessThan(1e-5);
    const thermal = conductorThermal(line);
    // R′_ins = ln(2.562982) / (2π × 0.18) = 0.941173 / 1.130973 = 0.832181 K·m/W.
    expect(rel(thermal.insulationResistanceKMPerW, 0.832181)).toBeLessThan(1e-5);
    // C′ = 8890 × 385 × 8.2305e-7 = 2.816975 J/(m·K); τ_min = C′ · R′_ins = 2.344234 s.
    expect(rel(conductorTauMinS(thermal), 2.344234)).toBeLessThan(1e-5);
    expect(thermal.outerDiameterM).toBeCloseTo(1.02369e-3 + 1.6e-3, 8);
  });

  it('Wiedemann–Franz: copper 415.4 and the aluminium alloy 253.4 W/(m·K)', () => {
    expect(rel(thermalConductivityWPerMK(physics('conductor.tallowmere-thhn-14-solid')), 415.4)).toBeLessThan(5e-4);
    expect(rel(thermalConductivityWPerMK(physics('conductor.quorvale-xhhw2-al-4-compact')), 253.4)).toBeLessThan(5e-4);
  });

  it("the screw class's hot spot: 1.1 J/K over 0.026 W/K + the largest fin it admits, ≥ 1 s", () => {
    const breaker = BUILTIN_CATALOG.device({ id: 'breaker.saltmere-1p-15a', version: 1 });
    const spec = breaker?.terminals[0].methods[0];
    if (!spec) throw new Error('breaker');
    const fin = maxFinConductanceWPerK(conductorThermal(physics('conductor.tallowmere-thhn-14-solid')));
    expect(spec.hotSpotHeatCapacityJPerK / (spec.heatPathWPerK + fin)).toBeGreaterThan(THERMAL_MIN_TAU_S.value);
  });

  it('refuses a lead whose bound is below 1 s, or whose insulation is past lnRatio’s range', () => {
    const thin = docs().map((d) =>
      d.model.kind === 'lead'
        ? { ...d, model: { ...d.model, params: { ...d.model.params, insulationThicknessMm: 0.001 } } }
        : d,
    );
    expect(messages(thin).join()).toMatch(/lead\.quillfern-test-1m@1: model\.params: The lead's thermal time constant/);
    const thick = docs().map((d) =>
      d.model.kind === 'lead'
        ? { ...d, model: { ...d.model, params: { ...d.model.params, insulationThicknessMm: 5 } } }
        : d,
    );
    expect(messages(thick).join()).toMatch(/insulationThicknessMm: The insulation's outer radius is above 8×/);
  });

  it('refuses a conductor whose bound is below 1 s (a thin wall on a light conductor)', () => {
    const light = docs().map((d) =>
      d.id === 'conductor.tallowmere-mtw-18'
        ? { ...d, conductor: { ...(d['conductor'] as Record<string, unknown>), insulationThicknessMm: 0.01 } }
        : d,
    );
    expect(messages(light).join()).toMatch(
      /conductor\.tallowmere-mtw-18@1: conductor: The conductor's thermal time constant/,
    );
  });

  it('refuses a terminal method whose hot spot is too light for the fins it admits', () => {
    const light = docs().map((d) =>
      d.id === 'breaker.saltmere-1p-15a'
        ? {
            ...d,
            terminals: (d['terminals'] as { methods: Record<string, unknown>[] }[]).map((t) => ({
              ...t,
              methods: t.methods.map((m) => ({ ...m, hotSpotHeatCapacityJPerK: 0.01 })),
            })),
          }
        : d,
    );
    expect(messages(light).join()).toMatch(
      /breaker\.saltmere-1p-15a@1: terminals\.line\.methods\.screw\.hotSpotHeatCapacityJPerK: The termination hot spot/,
    );
  });
});
