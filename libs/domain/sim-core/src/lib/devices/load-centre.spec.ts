import { type LeadParams, leadResistanceOhm, type ServiceSplitPhaseParams } from '@controls/catalog';
import {
  GROUND_BAR_X,
  LC_BOND_OHM,
  LC_BRANCH_POLE_OHM,
  LC_FEED_OHM,
  LC_MAIN_POLE_OHM,
  LC_STAB_OHM,
  LOAD_CENTRE_REFS as LC,
  MAIN_X,
  MBJ_X,
  spaceMount,
  spacePositionMm,
} from '@controls/world-model/testing';
import { AMBIENT_TEMPERATURE_K } from '../constants';
import { BUSBAR, RESISTOR_100, RESISTOR_12 } from '../../testing/engine';
import {
  residentialBus,
  residentialTestOptions,
  RESIDENTIAL_TEST_CATALOG,
  ROD,
  ROD_OHM,
  SERVICE,
  SERVICE_PARAMS,
} from '../../testing/residential';
import { SourceHost } from '../../testing/sources';
import type { NetlistBranch, TerminalRef } from '../netlist/types';
import { wiringGraph } from '../netlist/wiring-graph';
import { splitPhaseTEquivalent } from './sources/ac-source';
import { serviceDropOhm } from './sources/netlist-models';

/*
 * The load centre headless (P4 PR 14a, ADR 0019's P4 PR 14 amendment), on world-model's TEST-ONLY
 * entries over the real kinds and the TEST-ONLY 25 kVA service (`service.spec.ts`'s): bus currents, the
 * neutral bar, a main-lug subpanel and a ground fault with and without the main bonding jumper. Every
 * wire is the test busbar link (R_BB = 17.24 nΩ, no contact) so the hand values stay readable.
 *
 * Hand calculations (complex phasors at 60 Hz, every value from the parameters, never from the engine):
 *
 * - the service (`service.spec.ts`): line arm Z_h = Z_full / 2 = 10.30380 + j20.60760 mΩ, neutral arm
 *   Z_n = Z_LN − Z_h = −2.57595 − j8.24304 mΩ (inside the coupled 2 × 2 source impedance), the drop
 *   R_L = 25.2125 mΩ per line and R_N = 40.0907 mΩ;
 * - the test entries: the main breaker's poles 1 mΩ, its two `mainFeed` contacts 0.5 mΩ, a branch
 *   breaker's pole 5 mΩ and its stab contact 5 mΩ, the jumper's two contacts and the ground bar kit's
 *   contact 2 mΩ each; the neutral bar, the ground bar and the bus bars are ideal (no bar resistance);
 * - **the main-breaker panel** (`busCurrents`): 12 Ω on spaces 1 and 2 (both busL1) and 100 Ω on space
 *   3 (busL2). Per leg the feed is Z_f = R_BB + 1 + 0.5 mΩ; each branch is
 *   Z_b(R) = 5 + 5 mΩ + 2 R_BB + R; L1 sees Z_1 = Z_f + Z_b(12) ∥ Z_b(12), L2 Z_2 = Z_f + Z_b(100), and the
 *   neutral Z_c = Z_n + R_N + R_BB is common to both meshes:
 *     [120; −120] = [[Z_h + R_L + Z_1 + Z_c, Z_c], [Z_c, Z_h + R_L + Z_2 + Z_c]] [I_1; I_2],
 *   so I_1 = 19.7458 A, I_2 = 1.20639 A (magnitudes) and the neutral carries |I_1 + I_2| = 18.5394 A;
 *   each 12 Ω branch carries I_1 / 2 = 9.87288 A (the two branches are equal);
 * - **the main-lug subpanel** (`subpanel`): main lugs on `mainFeed`, no jumper, a ground bar kit; 12 Ω on
 *   space 1: I = 120 / |Z_LN + R_L + R_N + R_BB + (R_BB + 0.5 mΩ) + Z_b(12)| = 9.93087 A;
 * - **a ground fault from space 1's load screw onto the ground bar** (`groundFault`), the GEC from the
 *   ground bar to a rod (39.9 Ω; the utility grounds x0 through 5 Ω):
 *   - with the jumper the fault returns over metal, the kit contact, the jumper's two contacts, the
 *     neutral lead and the drop neutral (R_m = 2 + 2 + 2 mΩ + R_BB + R_N = 46.0907 mΩ), in parallel with
 *     the earth path (R_e = R_BB + 39.9 + 5 Ω): I = 120 / |Z_LN + R_L + Z_f + 10 mΩ + R_BB + R_m ∥ R_e|
 *     = 1313.99 A, of which the jumper carries I · R_e / (R_m + R_e) = 1312.64 A; far above the 20 A
 *     breaker's 240–400 A band, so it opens magnetically within its 8–20 ms opening time, and below the
 *     main's (test) 2000 A, so the main stays closed;
 *   - without the jumper only earth returns it: I = 120 / |Z_LN + R_L + Z_f + 10 mΩ + R_BB + R_e| =
 *     2.66996 A, nothing trips, and the can stands at I · (R_BB + 39.9) = 106.532 V above remote earth.
 */

const p = SERVICE_PARAMS as ServiceSplitPhaseParams;
const OMEGA = 2 * Math.PI * 60;
type Complex = [number, number];
const add = (...zs: Complex[]): Complex => zs.reduce(([a, b], [c, d]) => [a + c, b + d], [0, 0] as Complex);
const sub = ([a, b]: Complex, [c, d]: Complex): Complex => [a - c, b - d];
const mul = ([a, b]: Complex, [c, d]: Complex): Complex => [a * c - b * d, a * d + b * c];
const div = ([a, b]: Complex, [c, d]: Complex): Complex => {
  const m = c * c + d * d;
  return [(a * c + b * d) / m, (b * c - a * d) / m];
};
const abs = ([re, im]: Complex) => Math.hypot(re, im);
const re = (r: number): Complex => [r, 0];
const parallel = (a: Complex, b: Complex): Complex => div(mul(a, b), add(a, b));

const T = splitPhaseTEquivalent(p, 60);
const Z_H: Complex = [T.line.ohms, T.line.henries * OMEGA];
const Z_LN: Complex = [T.lineToNeutral.ohms, T.lineToNeutral.henries * OMEGA];
const Z_N = sub(Z_LN, Z_H);
const R_L = serviceDropOhm(p, p.dropLineAreaM2);
const R_N = serviceDropOhm(p, p.dropNeutralAreaM2);
const R_BB = leadResistanceOhm(
  RESIDENTIAL_TEST_CATALOG.device(BUSBAR)?.model.params as LeadParams,
  AMBIENT_TEMPERATURE_K.value,
);
/** A main-breaker feed: the service lead, the main's pole and its `mainFeed` contact. */
const Z_FEED_MAIN = re(R_BB + LC_MAIN_POLE_OHM + LC_FEED_OHM);
/** A branch breaker's stab contact and pole, its two leads and its load. */
const branchZ = (ohms: number): Complex => re(LC_STAB_OHM + LC_BRANCH_POLE_OHM + 2 * R_BB + ohms);

/** Engine against hand calculation (the plan's ≤ 0.5 %, held far tighter here: same model, exact arithmetic). */
const ENGINE_TOL = 1e-5;
const near = (got: number, want: number, rel: number) => expect(Math.abs(got / want - 1)).toBeLessThan(rel);

function host(): SourceHost {
  return new SourceHost(residentialBus(), residentialTestOptions());
}
function place(h: SourceHost, ref: object, positionMm: object, mountedOn: object | null = null): number {
  h.exec('entity.place', { ref, positionMm, mountedOn });
  return h.bus.state.nextEntityId - 1;
}
const at = (x: number, y = 0, z = 0) => ({ x, y, z });
const t = (entity: number, terminal: string): TerminalRef => ({ entity, terminal });
const busbar = (h: SourceHost, a: TerminalRef, b: TerminalRef) => {
  h.exec('lead.connect', { ref: BUSBAR, a, b });
  return h.bus.state.nextConnectionId - 1;
};
const on = (h: SourceHost, id: number) => h.exec('device.operate', { id, control: 'on', value: true });
const branch = (h: SourceHost, space: number, panel: number) => {
  const id = place(h, LC.branch20, spacePositionMm(space), { entity: panel, mount: spaceMount(space) });
  on(h, id);
  return id;
};

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

/** The service (1), a load centre (2) at the origin fed by `feed` on `mainFeed` (3), its neutral bar on the service neutral. */
function panel(feed: object): { h: SourceHost; service: number; lc: number; main: number } {
  const h = host();
  const service = place(h, SERVICE, at(0, 0, 3000));
  const lc = place(h, LC.loadCentre, at(0));
  const main = place(h, feed, at(MAIN_X), { entity: lc, mount: 'main' });
  const [l1, l2] = feed === LC.main ? ['line1', 'line2'] : ['l1', 'l2'];
  busbar(h, t(service, 'l1'), t(main, l1));
  busbar(h, t(service, 'l2'), t(main, l2));
  busbar(h, t(service, 'n'), t(lc, 'neutral'));
  if (feed === LC.main) on(h, main);
  return { h, service, lc, main };
}

/** A resistor `ref` from branch `breaker`'s load screw to neutral-bar terminal `n`; returns its neutral lead. */
function load(h: SourceHost, breaker: number, ref: object, lc: number, n: string): number {
  const r = place(h, ref, at(0, 0, 2000 + 100 * breaker));
  busbar(h, t(breaker, 'load'), t(r, 'a'));
  return busbar(h, t(r, 'b'), t(lc, n));
}

describe('the main-breaker load centre: bus and neutral-bar currents', () => {
  it('the feed contact on each leg carries that bus bar’s current (the sum of its stabs); the neutral lead the bar’s', () => {
    const { h, lc, main } = panel(LC.main);
    const a = branch(h, 1, lc);
    const b = branch(h, 2, lc);
    const c = branch(h, 3, lc);
    load(h, a, RESISTOR_12, lc, 'n1');
    load(h, b, RESISTOR_12, lc, 'n2');
    load(h, c, RESISTOR_100, lc, 'n3');
    expect(h.engine.netlist.diagnostics).toStrictEqual([]);

    const Z_1 = add(Z_FEED_MAIN, parallel(branchZ(12), branchZ(12)));
    const Z_2 = add(Z_FEED_MAIN, branchZ(100));
    const Z_C = add(Z_N, re(R_N + R_BB));
    const a11 = add(Z_H, re(R_L), Z_1, Z_C);
    const a22 = add(Z_H, re(R_L), Z_2, Z_C);
    const det = sub(mul(a11, a22), mul(Z_C, Z_C));
    const I1 = div(sub(mul(re(120), a22), mul(Z_C, re(-120))), det);
    const I2 = div(sub(mul(a11, re(-120)), mul(Z_C, re(120))), det);
    near(abs(I1), 19.7458, 1e-4);
    near(abs(I2), 1.20639, 1e-4);
    near(abs(add(I1, I2)), 18.5394, 1e-4);

    // Bus currents: the feed contact on each leg, which by KCL is the sum of that bar's stab contacts.
    const feed1 = current(h, contact(main, 'load1'));
    const feed2 = current(h, contact(main, 'load2'));
    near(abs(feed1), abs(I1), ENGINE_TOL);
    near(abs(feed2), abs(I2), ENGINE_TOL);
    // A contact's current runs from the dependent device (end a) to the host (end b): into the bar from
    // the feed, out of it into each breaker. KCL at the bar, at the plan's floor (1e-9 · max|I| + 1e-12 A).
    const stabs1 = add(current(h, contact(a, 'line1')), current(h, contact(b, 'line1')));
    const floor = 1e-9 * abs(feed1) + 1e-12;
    expect(abs(add(stabs1, feed1))).toBeLessThan(floor);
    expect(abs(add(current(h, contact(c, 'line1')), feed2))).toBeLessThan(floor);
    near(abs(current(h, contact(a, 'line1'))), abs(I1) / 2, ENGINE_TOL);
    // The neutral bar's current, read from the neutral conductor (connection 3): |I_1 + I_2|.
    near(abs(current(h, connection(3))), abs(add(I1, I2)), ENGINE_TOL);
    near(abs(current(h, connection(3))), 18.5394, ENGINE_TOL);
    // The engine's own reading of the feed contact (what protocol 8's busL1CurrentA will publish).
    near(
      h.engine.branchAmps({ kind: 'contact', entity: main, relation: 'mount', contact: 'load1' }),
      abs(I1),
      ENGINE_TOL,
    );
  });

  it('with nothing on mainFeed the bus is unfed: the island holds no source, nothing is reported, no current', () => {
    const h = host();
    const lc = place(h, LC.loadCentre, at(0));
    const a = branch(h, 1, lc);
    load(h, a, RESISTOR_12, lc, 'n1');
    expect(h.engine.netlist.diagnostics).toStrictEqual([]);
    h.advance(20);
    expect(abs(current(h, contact(a, 'line1')))).toBe(0);
    // Every island is dead (no source) and solved; nothing is flagged.
    for (const island of h.engine.islandDiagnostics()) {
      expect(island).toMatchObject({ kind: 'empty', status: 'solved', bandReason: 'no-source', flags: 0 });
    }
  });

  it('the load centre enters an island’s entity list and survives a save and load bit for bit', () => {
    const { h, lc } = panel(LC.main);
    const a = branch(h, 1, lc);
    load(h, a, RESISTOR_12, lc, 'n1');
    h.exec('panel.directory', { id: lc, space: 1, text: 'KITCHEN' });
    const island = h.engine.islands().find((i) => i.entities.includes(lc));
    expect(island).toMatchObject({ kind: 'ac', status: 'solved' });
    h.advance(30);
    const loaded = h.reload();
    const saved = loaded.bus.state.entities.find((e) => e.id === lc);
    expect(saved?.state['directory1']).toBe('KITCHEN');
    expect(saved?.sim).toStrictEqual({});
    loaded.advance(30);
    h.advance(30);
    expect(loaded.materialised()).toStrictEqual(h.materialised());
    expect(loaded.engine.snapshotHash()).toBe(h.engine.snapshotHash());
  });
});

describe('a main-lug subpanel (no main bonding jumper)', () => {
  it('feeds the bus through the lugs’ contacts; its neutral and its can stay separate, the ground bar on the can', () => {
    const { h, lc, main } = panel(LC.mainLugs);
    const bar = place(h, LC.groundBar, at(GROUND_BAR_X), { entity: lc, mount: 'groundBar' });
    const a = branch(h, 1, lc);
    load(h, a, RESISTOR_12, lc, 'n1');
    const want = 120 / abs(add(Z_LN, re(R_L + R_N + R_BB + R_BB + LC_FEED_OHM), branchZ(12)));
    near(want, 9.93087, 1e-4);
    near(abs(current(h, contact(main, 'l1'))), want, ENGINE_TOL);
    near(abs(current(h, connection(3))), want, ENGINE_TOL);
    const netlist = h.engine.netlist;
    const nodeOf = (ref: TerminalRef) =>
      netlist.nodes.find((n) => n.members.some((m) => m.entity === ref.entity && m.terminal === ref.terminal))?.index;
    expect(nodeOf(t(lc, 'neutral'))).not.toBe(nodeOf(t(lc, 'chassis')));
    const graph = wiringGraph(h.bus.state, RESIDENTIAL_TEST_CATALOG);
    expect(graph.joined(t(lc, 'neutral'), t(lc, 'chassis'))).toBe(false);
    expect(graph.joined(t(bar, 'g1'), t(lc, 'chassis'))).toBe(true);
    expect(graph.joined(t(bar, 'g1'), t(lc, 'n1'))).toBe(false);
  });
});

describe('a ground fault on a branch (the EGC on the ground bar, the GEC to a rod)', () => {
  /** The main-breaker panel, a 20 A breaker in space 1 faulted onto g1, the GEC from g2 to a rod; with or without the jumper. */
  function faulted(bonded: boolean) {
    const { h, lc, main } = panel(LC.main);
    const bar = place(h, LC.groundBar, at(GROUND_BAR_X), { entity: lc, mount: 'groundBar' });
    const mbj = bonded ? place(h, LC.mbj, at(MBJ_X), { entity: lc, mount: 'mbj' }) : -1;
    const rod = place(h, ROD, at(0, 0, 5000));
    busbar(h, t(bar, 'g2'), t(rod, 'clamp'));
    const a = branch(h, 1, lc);
    const fault = busbar(h, t(a, 'load'), t(bar, 'g1'));
    return { h, lc, main, bar, mbj, rod, a, fault };
  }
  const R_E = R_BB + ROD_OHM + p.utilityGroundingOhm;
  const LOOP = add(Z_LN, re(R_L), Z_FEED_MAIN, re(LC_STAB_OHM + LC_BRANCH_POLE_OHM + R_BB));

  it('with the jumper the fault returns over metal through it, at 1.31 kA, and the branch breaker opens magnetically', () => {
    const { h, main, mbj, a, fault } = faulted(true);
    const R_M = LC_BOND_OHM + 2 * LC_BOND_OHM + R_BB + R_N;
    const want = 120 / abs(add(LOOP, parallel(re(R_M), re(R_E))));
    near(want, 1313.99, 1e-4);
    near(abs(current(h, connection(fault))), want, ENGINE_TOL);
    const viaJumper = (want * R_E) / (R_M + R_E);
    near(viaJumper, 1312.64, 1e-4);
    near(abs(current(h, contact(mbj, 'neutral'))), viaJumper, ENGINE_TOL);
    near(abs(current(h, contact(mbj, 'chassis'))), viaJumper, ENGINE_TOL);
    // It opens inside its opening time (8–20 ms), magnetically; the main (2000 A and up) doesn't.
    h.advance(7);
    expect(h.sim(a)['tripped']).toBe(false);
    h.advance(15);
    expect(h.sim(a)).toMatchObject({ tripped: true, tripCause: 'magnetic' });
    expect(h.sim(main)).toMatchObject({ tripped: false, tripCause: null });
    expect(abs(current(h, connection(fault)))).toBe(0);
  });

  it('without it only earth returns the fault: 2.67 A, nothing trips, and the can stands at 106.5 V above earth', () => {
    const { h, a, fault, lc } = faulted(false);
    const want = 120 / abs(add(LOOP, re(R_E)));
    near(want, 2.66996, 1e-4);
    near(abs(current(h, connection(fault))), want, ENGINE_TOL);
    const touch = want * (R_BB + ROD_OHM);
    near(touch, 106.532, 1e-4);
    const reading = h.engine.probe(t(lc, 'chassis'), { entity: 0, terminal: 'earth' });
    expect(reading.kind).toBe('ac');
    if (reading.kind === 'ac') near(reading.rmsVolts, touch, ENGINE_TOL);
    h.advance(3000);
    expect(h.sim(a)['tripped']).toBe(false);
    near(abs(current(h, connection(fault))), want, ENGINE_TOL);
  });
});
