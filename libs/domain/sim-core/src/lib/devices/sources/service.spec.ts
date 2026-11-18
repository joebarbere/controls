import { type LeadParams, leadResistanceOhm, type ServiceSplitPhaseParams } from '@controls/catalog';
import { AMBIENT_TEMPERATURE_K } from '../../constants';
import { BUSBAR } from '../../../testing/engine';
import {
  BOND_OHM,
  MBJ,
  PANEL,
  residentialBus,
  residentialTestOptions,
  RESIDENTIAL_TEST_CATALOG,
  ROD,
  ROD_OHM,
  SERVICE,
  SERVICE_PARAMS,
} from '../../../testing/residential';
import { SourceHost } from '../../../testing/sources';
import type { NetlistBranch } from '../../netlist/types';
import { splitPhaseTEquivalent } from './ac-source';
import { serviceDropOhm } from './netlist-models';

/*
 * The utility service and remote earth (engine 8 part 1, D4 and D5, ADR 0021), headless, on the
 * TEST-ONLY residential catalogue's 25 kVA service (`SERVICE_PARAMS`): 2 %, X/R 2, 120/240 V; a 30 m
 * aluminium drop (33.62 mm² lines, 21.15 mm² neutral, 2.8264e-8 Ω·m at 20 °C); utility grounding 5 Ω;
 * ground rods of 39.9 Ω.
 *
 * Hand calculations (complex phasors; every value from the parameters, never from the engine):
 *
 * - the transformer's T-equivalent (`ac-source.spec.ts`): Z_full / 2 = 10.30380 + j20.60760 mΩ per line
 *   arm, Z_LN = 7.72785 + j12.36456 mΩ, Z_n = −2.57595 − j8.24304 mΩ;
 * - the drop at 20 °C (the reference temperature, so α plays no part):
 *   R_L = 2.8264e-8 × 30 / 3.362e-5 = 25.2207 mΩ per line, R_N = 2.8264e-8 × 30 / 2.115e-5 = 40.0907 mΩ;
 * - a bolted L1–N fault at the meter base's lugs: I = 120 / |Z_LN + R_L + R_N|
 *   = 120 / |73.0393 + j12.3646 mΩ| = 120 / 74.0785 mΩ = 1619.9 A;
 * - a bolted L1–L2 fault there: I = 240 / |Z_full + 2 R_L| = 240 / |71.0490 + j41.2152 mΩ|
 *   = 240 / 82.1380 mΩ = 2921.9 A;
 * - **the earth path** (the plan's `earth-path` teaching point, Art. 250.4(A)(5) by number): L1 faulted
 *   into a separate rod (R_rod 39.9 Ω) returns through remote earth to the transformer neutral x0 by two
 *   parallel paths, the utility's grounding (5 Ω) and the service's own rod (39.9 Ω) through the GEC,
 *   the bonding jumper's two contacts (2 mΩ each), the neutral lead and the drop neutral:
 *   R_ret = 5 ∥ (39.9 + 2 × 0.002 + R_N + 3 R_bb) = 4.44446 Ω, so
 *   I = 120 / |Z_LN + R_L + R_bb + 39.9 + R_ret| ≈ 120 / 44.3778 Ω = 2.7041 A, which trips nothing
 *   (≈ 2.70 A in the plan, at 40 Ω, 5 Ω and 40 Ω). R_bb is the test busbar link, 17 nΩ.
 */

const p = SERVICE_PARAMS as ServiceSplitPhaseParams;
const OMEGA = 2 * Math.PI * 60;
type Complex = [number, number];
const add = (...zs: Complex[]): Complex => zs.reduce(([a, b], [c, d]) => [a + c, b + d], [0, 0] as Complex);
const abs = ([re, im]: Complex) => Math.hypot(re, im);
const parallel = (a: number, b: number) => (a * b) / (a + b);

const T = splitPhaseTEquivalent(p, 60);
const Z_LN: Complex = [T.lineToNeutral.ohms, T.lineToNeutral.henries * OMEGA];
const Z_FULL: Complex = [2 * T.line.ohms, 2 * T.line.henries * OMEGA];
const R_L = (2.8264e-8 * 30) / 3.362e-5;
const R_N = (2.8264e-8 * 30) / 2.115e-5;
const R_BB = leadResistanceOhm(
  RESIDENTIAL_TEST_CATALOG.device(BUSBAR)?.model.params as LeadParams,
  AMBIENT_TEMPERATURE_K.value,
);

const near = (got: number, want: number, rel: number) => expect(Math.abs(got / want - 1)).toBeLessThan(rel);

function host(): SourceHost {
  return new SourceHost(residentialBus(), residentialTestOptions());
}
function place(h: SourceHost, ref: object, positionMm = { x: 0, y: 0, z: 1000 }, mountedOn: object | null = null) {
  h.exec('entity.place', { ref, positionMm, mountedOn });
  return h.bus.state.nextEntityId - 1;
}
const busbar = (h: SourceHost, a: number, ta: string, b: number, tb: string) =>
  h.exec('lead.connect', { ref: BUSBAR, a: { entity: a, terminal: ta }, b: { entity: b, terminal: tb } });

/** The phasor current of the branch `pick` chooses. */
function current(h: SourceHost, pick: (b: NetlistBranch) => boolean): Complex {
  const branch = h.engine.netlist.branches.find(pick);
  if (branch === undefined) throw new Error('no such branch');
  const s = h.engine.exportState().solution?.branches as number[];
  return [s[2 * branch.index], s[2 * branch.index + 1]];
}
const connection = (id: number) => (b: NetlistBranch) => b.element.kind === 'connection' && b.element.connection === id;
const contact = (entity: number, name: string) => (b: NetlistBranch) =>
  b.element.kind === 'contact' && b.element.entity === entity && b.element.contact === name;

describe('the service drop (ρL/A, never a table)', () => {
  it('derives each conductor from resistivity × length ÷ area at the 20 °C ambient', () => {
    expect(AMBIENT_TEMPERATURE_K.value).toBe(p.dropReferenceTemperatureK);
    near(serviceDropOhm(p, p.dropLineAreaM2), 0.0252207, 1e-5);
    near(serviceDropOhm(p, p.dropNeutralAreaM2), 0.0400907, 1e-5);
    expect(serviceDropOhm(p, p.dropLineAreaM2)).toBeCloseTo(R_L, 15);
    // At 75 °C the coefficient applies: R(T) = R₀ (1 + α ΔT).
    const hot = { ...p, dropReferenceTemperatureK: AMBIENT_TEMPERATURE_K.value - 55 };
    near(serviceDropOhm(hot, p.dropLineAreaM2), R_L * (1 + 0.00403 * 55), 1e-12);
  });
});

describe('the service in the engine (hand calculations within 0.5 %)', () => {
  it('a bolted L1–N fault at the meter base draws 120 / |Z_LN + R_L + R_N| (1619.9 A)', () => {
    const want = 120 / abs(add(Z_LN, [R_L + R_N + R_BB, 0]));
    near(want, 1619.9, 1e-4);
    const h = host();
    const service = place(h, SERVICE);
    busbar(h, service, 'l1', service, 'n');
    near(abs(current(h, connection(1))), want, 1e-6);
    near(abs(current(h, connection(1))), 1619.9, 0.005);
  });

  it('a bolted L1–L2 fault draws 240 / |Z_full + 2 R_L| (2921.9 A)', () => {
    const want = 240 / abs(add(Z_FULL, [2 * R_L + R_BB, 0]));
    near(want, 2921.9, 1e-4);
    const h = host();
    const service = place(h, SERVICE);
    busbar(h, service, 'l1', service, 'l2');
    near(abs(current(h, connection(1))), want, 1e-6);
  });

  it('opens at 120/240 V and puts the island on the 120/240 V band', () => {
    const h = host();
    place(h, SERVICE);
    const reading = h.engine.probe({ entity: 1, terminal: 'l1' }, { entity: 1, terminal: 'l2' });
    expect(reading.kind === 'ac' && reading.rmsVolts).toBeCloseTo(240, 9);
    expect(h.engine.islands()[0]).toMatchObject({ kind: 'ac', status: 'solved' });
  });
});

describe('remote earth (D5): the earth path', () => {
  /** The service, a panel with its bonding jumper, the service rod on the GEC and a second rod. */
  function bonded(): { h: SourceHost; service: number; panel: number; mbj: number; rod: number; other: number } {
    const h = host();
    const service = place(h, SERVICE);
    const panel = place(h, PANEL, { x: 0, y: 0, z: 0 });
    const mbj = place(h, MBJ, { x: 200, y: 0, z: 0 }, { entity: panel, mount: 'mbj' });
    const rod = place(h, ROD, { x: 0, y: 0, z: 2000 });
    const other = place(h, ROD, { x: 0, y: 0, z: 3000 });
    busbar(h, service, 'n', panel, 'neutral'); // connection 1
    busbar(h, panel, 'chassis', rod, 'clamp'); // connection 2: the GEC
    return { h, service, panel, mbj, rod, other };
  }

  it('a fault into a separate rod draws V / (R_rod + R_utility ∥ R_service-rod) and nothing trips (≈ 2.70 A)', () => {
    const { h, service, rod, other } = bonded();
    busbar(h, service, 'l1', other, 'clamp'); // connection 3: the fault
    const returnOhm = parallel(p.utilityGroundingOhm, ROD_OHM + R_BB + 2 * BOND_OHM + R_BB + R_N);
    const want = 120 / abs(add(Z_LN, [R_L + R_BB + ROD_OHM + returnOhm, 0]));
    near(want, 2.7041, 1e-4);
    near(abs(current(h, connection(3))), want, 1e-6);
    near(abs(current(h, connection(3))), 2.7041, 0.005);
    // The fault current enters the far rod and splits at earth by the current divider.
    near(abs(current(h, contact(other, 'electrode'))), want, 1e-6);
    const viaUtility = abs(current(h, contact(service, 'grounding')));
    const viaRod = abs(current(h, contact(rod, 'electrode')));
    near(viaUtility + viaRod, want, 1e-6);
    near(viaRod / viaUtility, p.utilityGroundingOhm / (ROD_OHM + 3 * R_BB + 2 * BOND_OHM + R_N), 1e-6);
  });

  it('a fault into the service rod returns through the GEC and the bond: a fault current, not 2.7 A', () => {
    const { h, service, rod, mbj } = bonded();
    busbar(h, service, 'l1', rod, 'clamp');
    const fault = abs(current(h, connection(3)));
    expect(fault).toBeGreaterThan(1000);
    near(abs(current(h, contact(mbj, 'neutral'))), fault, 0.01);
    expect(abs(current(h, contact(rod, 'electrode')))).toBeLessThan(0.01 * fault);
  });

  it('without the bonding jumper the GEC carries nothing back: the service rod is in series with earth', () => {
    const h = host();
    const service = place(h, SERVICE);
    const panel = place(h, PANEL, { x: 0, y: 0, z: 0 });
    const rod = place(h, ROD, { x: 0, y: 0, z: 2000 });
    busbar(h, service, 'n', panel, 'neutral');
    busbar(h, panel, 'chassis', rod, 'clamp');
    busbar(h, service, 'l1', rod, 'clamp'); // the fault into the service rod, no MBJ
    const want = 120 / abs(add(Z_LN, [R_L + R_BB + ROD_OHM + p.utilityGroundingOhm, 0]));
    near(abs(current(h, connection(3))), want, 1e-6);
    near(want, 2.6713, 1e-3);
  });

  it('the earth node survives a save and load, and the replayed world solves bit for bit', () => {
    const { h, service, other } = bonded();
    busbar(h, service, 'l1', other, 'clamp');
    h.advance(50);
    const loaded = h.reload();
    expect(loaded.engine.netlist.topologyHash).toBe(h.engine.netlist.topologyHash);
    loaded.advance(50);
    h.advance(50);
    expect(loaded.materialised()).toStrictEqual(h.materialised());
    expect(loaded.engine.snapshotHash()).toBe(h.engine.snapshotHash());
  });
});

describe("Dwight's single-rod formula (computed here, never in sim code: D6)", () => {
  it('an 8 ft × 5/8 in rod at 100 Ω·m is 39.9 Ω with the radius (35.4 Ω with the diameter, the must-avoid)', () => {
    // R = ρ / (2π L) · (ln(4 L / a) − 1), a the radius (IEEE Std 142, cited by number).
    const rho = 100;
    const length = 8 * 0.3048;
    const radius = (5 / 8) * 0.0254 * 0.5;
    const dwight = (a: number) => (rho / (2 * Math.PI * length)) * (Math.log((4 * length) / a) - 1);
    near(dwight(radius), 39.9, 0.001);
    expect(dwight(radius)).toBeCloseTo(ROD_OHM, 1);
    // Using the diameter for a understates it by about 11 %: the pre-audit's must-avoid.
    near(dwight(2 * radius), 35.38, 0.001);
  });
});
