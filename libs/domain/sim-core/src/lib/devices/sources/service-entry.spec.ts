import { BUILTIN_CATALOG, type LeadParams, leadResistanceOhm, type ServiceSplitPhaseParams } from '@controls/catalog';
import { AMBIENT_TEMPERATURE_K } from '../../constants';
import { BUSBAR } from '../../../testing/engine';
import { residentialBus, residentialTestOptions, RESIDENTIAL_TEST_CATALOG } from '../../../testing/residential';
import { SourceHost } from '../../../testing/sources';
import type { NetlistBranch } from '../../netlist/types';
import { splitPhaseTEquivalent } from './ac-source';
import { serviceDropOhm } from './netlist-models';

/*
 * The shipped service entry (P4 F4.2 part 2, content PR 14): `service.larkmoor-sp25-overhead@1`, a
 * 25 kVA, 2 %, X/R 2, 120/240 V pole transformer, a 30 m triplex drop of two 2 AWG 1350 aluminium lines
 * and a 4 AWG neutral (at 61.0 % IACS, 2.8264e-8 Ω·m, α 0.00403 /K at 20 °C) and the meter base's
 * load-side lugs; utility grounding 5 Ω. Hand calculations (complex phasors, from the entry's own
 * parameters, never from the engine):
 *
 * - areas from the AWG definition, d = 0.127 mm × 92^((36 − n) / 39): 2 AWG 6.54371 mm, 33.6308 mm²
 *   (stored 33.631 mm²); 4 AWG 5.18940 mm, 21.1506 mm² (stored 21.151 mm²);
 * - the drop at 20 °C (the game's ambient, so α plays no part): R_L = 2.8264e-8 × 30 / 3.3631e-5 =
 *   25.2125 mΩ per line; R_N = 2.8264e-8 × 30 / 2.1151e-5 = 40.0889 mΩ;
 * - the T-equivalent (ADR 0021 §1): Z_full = 0.02 × 240² / 25 000 = 46.08 mΩ at X/R 2, so
 *   10.30380 + j20.60760 mΩ per half; Z_LN = 1.5 R + j1.2 X on the 120 V base = 7.72785 + j12.36456 mΩ;
 *   at the transformer terminals I_LN = 120 / |Z_LN| = 8229.96 A and I_LL = 240 / |Z_full| = 5208.33 A
 *   (ratio 1.580; ADR 0021's goldens);
 * - a bolted L1–N fault at the meter-base lugs: I = 120 / |Z_LN + R_L + R_N| =
 *   120 / |73.0292 + j12.3646 mΩ| = 120 / 74.0685 mΩ = 1620.12 A (plus the 17 nΩ busbar link);
 * - a bolted L1–L2 fault there: I = 240 / |Z_full + 2 R_L| = 240 / |71.0325 + j41.2152 mΩ| = 2922.42 A.
 */

const SERVICE = { id: 'service.larkmoor-sp25-overhead', version: 1 };
const entry = BUILTIN_CATALOG.device(SERVICE);
const p = entry?.model.params as ServiceSplitPhaseParams;
const OMEGA = 2 * Math.PI * 60;
type Complex = [number, number];
const add = (...zs: Complex[]): Complex => zs.reduce(([a, b], [c, d]) => [a + c, b + d], [0, 0] as Complex);
const abs = ([re, im]: Complex) => Math.hypot(re, im);
const near = (got: number, want: number, rel: number) => expect(Math.abs(got / want - 1)).toBeLessThan(rel);

const T = splitPhaseTEquivalent(p, 60);
const Z_LN: Complex = [T.lineToNeutral.ohms, T.lineToNeutral.henries * OMEGA];
const Z_FULL: Complex = [2 * T.line.ohms, 2 * T.line.henries * OMEGA];
const R_L = (2.8264e-8 * 30) / 3.3631e-5;
const R_N = (2.8264e-8 * 30) / 2.1151e-5;
const R_BB = leadResistanceOhm(
  RESIDENTIAL_TEST_CATALOG.device(BUSBAR)?.model.params as LeadParams,
  AMBIENT_TEMPERATURE_K.value,
);

function host(): SourceHost {
  const h = new SourceHost(residentialBus(), residentialTestOptions());
  h.exec('entity.place', { ref: SERVICE, positionMm: { x: 0, y: 0, z: 1000 }, mountedOn: null });
  return h;
}
const busbar = (h: SourceHost, ta: string, tb: string) =>
  h.exec('lead.connect', { ref: BUSBAR, a: { entity: 1, terminal: ta }, b: { entity: 1, terminal: tb } });
function connectionAmps(h: SourceHost, id: number): number {
  const branch = h.engine.netlist.branches.find(
    (b: NetlistBranch) => b.element.kind === 'connection' && b.element.connection === id,
  );
  if (branch === undefined) throw new Error('no such branch');
  const s = h.engine.exportState().solution?.branches as number[];
  return Math.hypot(s[2 * branch.index], s[2 * branch.index + 1]);
}

describe('the shipped service entry (P4 F4.2 part 2)', () => {
  it('is the 25 kVA, 2 %, X/R 2, 120/240 V service with a 30 m 2-2-4 aluminium drop and 5 Ω utility grounding', () => {
    expect(entry?.model.kind).toBe('service.splitPhase');
    expect(p).toStrictEqual({
      ratedKva: 25,
      percentImpedance: 2,
      xOverR: 2,
      lineToNeutralV: 120,
      dropLengthMm: 30_000,
      dropLineAreaM2: 3.3631e-5,
      dropNeutralAreaM2: 2.1151e-5,
      dropResistivityOhmM: 2.8264e-8,
      dropTemperatureCoefficientPerK: 0.00403,
      dropReferenceTemperatureK: 293.15,
      utilityGroundingOhm: 5,
    });
    // The drop's areas are the AWG definition's 2 and 4 AWG (to the stored five significant figures).
    const area = (n: number) => {
      const d = 0.127 * Math.pow(92, (36 - n) / 39);
      return (Math.PI * d * d) / 4;
    };
    near(p.dropLineAreaM2, area(2) * 1e-6, 5e-5);
    near(p.dropNeutralAreaM2, area(4) * 1e-6, 5e-5);
  });

  it('derives its drop from ρL/A at the 20 °C ambient: 25.2125 mΩ per line, 40.0889 mΩ for the neutral', () => {
    expect(AMBIENT_TEMPERATURE_K.value).toBe(p.dropReferenceTemperatureK);
    near(serviceDropOhm(p, p.dropLineAreaM2), 0.0252125, 1e-5);
    near(serviceDropOhm(p, p.dropNeutralAreaM2), 0.0400889, 1e-5);
  });

  it('has the T-equivalent’s 8229.96 A line-to-neutral and 5208.33 A line-to-line at the transformer (ratio 1.580)', () => {
    near(120 / abs(Z_LN), 8229.96, 1e-5);
    near(240 / abs(Z_FULL), 5208.33, 1e-5);
    // I_LN / I_LL = (120 / |Z_LN|) / (240 / |Z_full|) = 1.580 (1.5 is the rule of thumb).
    near(120 / abs(Z_LN) / (240 / abs(Z_FULL)), 1.5802, 1e-4);
  });

  it('a bolted L1–N fault at the meter-base lugs draws 120 / |Z_LN + R_L + R_N| (1620.12 A) in the engine', () => {
    const want = 120 / abs(add(Z_LN, [R_L + R_N + R_BB, 0]));
    near(want, 1620.12, 1e-4);
    const h = host();
    busbar(h, 'l1', 'n');
    near(connectionAmps(h, 1), want, 0.005);
  });

  it('a bolted L1–L2 fault draws 240 / |Z_full + 2 R_L| (2922.42 A) in the engine', () => {
    const want = 240 / abs(add(Z_FULL, [2 * R_L + R_BB, 0]));
    near(want, 2922.42, 1e-4);
    const h = host();
    busbar(h, 'l1', 'l2');
    near(connectionAmps(h, 1), want, 0.005);
  });

  it('opens at 120/240 V, and its transformer neutral x0 is out of reach (a lead is refused)', () => {
    const h = host();
    const reading = h.engine.probe({ entity: 1, terminal: 'l1' }, { entity: 1, terminal: 'l2' });
    expect(reading.kind === 'ac' && reading.rmsVolts).toBeCloseTo(240, 9);
    expect(entry?.terminals.find((t) => t.id === 'x0')).toMatchObject({ access: 'none', methods: [] });
    const result = h.bus.exec('lead.connect', {
      ref: BUSBAR,
      a: { entity: 1, terminal: 'x0' },
      b: { entity: 1, terminal: 'n' },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatchObject({ kind: 'rejected', code: 'inaccessible' });
  });
});
