import { sha256Hex } from '@controls/world-model';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GMIN_S } from '../lib/constants';
import { ORACLE_DOMAINS, ORACLE_FREQUENCY_HZ, type OracleDomain } from './circuit';
import { ORACLE_CORPUS, oracleCorpus, oracleDeckPath, oracleResultsPath } from './corpus';
import { oracleDeck, oracleDeckOptions } from './deck';
import { oracleNetlist } from './netlist';
import { type OracleCircuitResult, parseOracleResults } from './results';

/*
 * The checked-in oracle corpus (plan F2.7, decision D5, ADR 0012), in `pnpm verify`. Hermetic: no
 * ngspice here, only the files under libs/domain/sim-core/oracle/.
 *
 * - **Staleness:** regenerating every deck from the pinned seeds reproduces the checked-in decks byte
 *   for byte, and the results were computed from exactly those decks (each records the deck's SHA-256).
 *   If this fails, the generator or the deck emitter changed: run `pnpm sim oracle regen` (it needs
 *   ngspice, docs/guides/oracle.md) and commit the decks and results together.
 * - **Consistency:** ngspice's solution satisfies each element's own equation, taken from the sim-core
 *   netlist (`oracleNetlist`), and KCL with `gmin`. That proves the deck and the netlist describe the
 *   same circuit with the same sign conventions, and that the results parse into the right slots,
 *   before any solver is compared against them.
 * - **The comparisons** are `dc-oracle.spec.ts` (F2.2 part 1) and `ac-oracle.spec.ts` (part 2).
 */

const corpusDir = join(import.meta.dirname, '../../oracle');

/** Each domain's circuits, decks and parsed results, read once. */
const corpus = Object.fromEntries(
  ORACLE_DOMAINS.map((domain) => {
    const circuits = oracleCorpus(domain);
    const decks = circuits.map((circuit) => oracleDeck(circuit));
    const results = parseOracleResults(readFileSync(join(corpusDir, oracleResultsPath(domain)), 'utf8'));
    return [domain, { circuits, decks, results }];
  }),
) as Record<
  OracleDomain,
  { circuits: ReturnType<typeof oracleCorpus>; decks: string[]; results: ReturnType<typeof parseOracleResults> }
>;

const REGEN_HINT = 'stale oracle corpus: run `pnpm sim oracle regen` (needs ngspice; docs/guides/oracle.md)';

describe.each(ORACLE_DOMAINS)('the %s oracle corpus', (domain) => {
  const { circuits, decks, results } = corpus[domain];

  it('holds at least 500 circuits (ADR 0012)', () => {
    expect(ORACLE_CORPUS[domain].count).toBeGreaterThanOrEqual(500);
    expect(circuits).toHaveLength(ORACLE_CORPUS[domain].count);
  });

  it('has exactly the decks the generator makes, and no others', () => {
    const files = readdirSync(join(corpusDir, domain)).sort();
    expect(files, REGEN_HINT).toStrictEqual(circuits.map((circuit) => `${circuit.name}.cir`));
  });

  it('decks regenerate byte for byte from the pinned seeds', () => {
    const stale = circuits.filter(
      (circuit, k) => readFileSync(join(corpusDir, oracleDeckPath(circuit)), 'utf8') !== decks[k],
    );
    expect(
      stale.map((circuit) => circuit.name),
      REGEN_HINT,
    ).toStrictEqual([]);
  });

  it('every deck sets .options sparse and prints at full precision', () => {
    for (const deck of decks) {
      expect(deck).toContain('\n.options sparse ');
      expect(deck).toContain('\nset numdgt=17\n');
    }
  });

  it('results header records the pinned seed, count, options and gmin, and Sparse 1.3', () => {
    expect(results.header).toStrictEqual({
      domain,
      ngspice: 'ngspice-47',
      solver: 'SPARSE 1.3',
      options: oracleDeckOptions(),
      gminS: GMIN_S.value,
      seed: ORACLE_CORPUS[domain].seed,
      count: ORACLE_CORPUS[domain].count,
    });
  });

  it('results were solved from the checked-in decks, one per circuit, in order', () => {
    const stale = results.circuits.filter(
      (result, k) => result.name !== circuits[k].name || result.deckSha256 !== sha256Hex(decks[k]),
    );
    expect(
      stale.map((result) => result.name),
      REGEN_HINT,
    ).toStrictEqual([]);
    results.circuits.forEach((result, k) => {
      expect(result.nodes).toHaveLength(2 * circuits[k].nodeCount);
      expect(result.branches).toHaveLength(2 * circuits[k].elements.length);
    });
  });

  it("ngspice's solution satisfies every element equation and KCL with gmin (the deck is the netlist)", () => {
    let worst = 0;
    results.circuits.forEach((result, k) => {
      worst = Math.max(worst, worstResidual(oracleNetlist(circuits[k]), result));
    });
    // Measured 2026-10-30 (ADR 0012): worst 2.9e-9 (DC) and 1.2e-9 (AC), all double rounding: a branch
    // current is only good to about ε · V · G_max ≈ 1e-12 A, which shows on high-resistance branches. A
    // wrong sign, slot or value would be of order 1.
    expect(worst).toBeLessThan(1e-7);
  });

  it('at least 95 % of branches carry real current, not just gmin (> 1e-6 of the circuit maximum)', () => {
    let live = 0;
    let total = 0;
    for (const result of results.circuits) {
      const magnitudes = [];
      for (let k = 0; k < result.branches.length; k += 2)
        magnitudes.push(Math.hypot(result.branches[k], result.branches[k + 1]));
      const largest = Math.max(...magnitudes);
      live += magnitudes.filter((m) => m > 1e-6 * largest).length;
      total += magnitudes.length;
    }
    expect(live / total).toBeGreaterThanOrEqual(0.95);
  });
});

/**
 * The worst residual of a solution against the netlist, each normalised by the circuit's own scale:
 * element equations by its largest node voltage, KCL by its largest branch current.
 */
function worstResidual(netlist: ReturnType<typeof oracleNetlist>, result: OracleCircuitResult): number {
  const omega = netlist.frequencyHz === null ? 0 : 2 * Math.PI * ORACLE_FREQUENCY_HZ;
  const v = (n: number): [number, number] => [result.nodes[2 * n], result.nodes[2 * n + 1]];
  const i = (k: number): [number, number] => [result.branches[2 * k], result.branches[2 * k + 1]];
  const abs = ([re, im]: [number, number]) => Math.hypot(re, im);
  let vScale = 0;
  for (let n = 0; n < netlist.nodeCount; n++) vScale = Math.max(vScale, abs(v(n)));
  let iScale = 0;
  netlist.branches.forEach((_, k) => (iScale = Math.max(iScale, abs(i(k)))));
  let worst = 0;
  // The netlist's own gmin, not the oracle constant: a wrong `gminS` in `oracleNetlist` must fail here.
  const kcl = Array.from({ length: netlist.nodeCount }, (_, n) => [netlist.gminS * v(n)[0], netlist.gminS * v(n)[1]]);
  for (const branch of netlist.branches) {
    const [va, vb, ik] = [v(branch.a), v(branch.b), i(branch.index)];
    const drop: [number, number] = [va[0] - vb[0], va[1] - vb[1]];
    const values = branch.values;
    let residual: [number, number];
    let scale = vScale;
    switch (branch.kind) {
      case 'resistor':
        residual = [drop[0] - ik[0] * values['resistanceOhm'], drop[1] - ik[1] * values['resistanceOhm']];
        break;
      case 'vsource': {
        const emf = netlist.domain === 'dc' ? [values['emfV'], 0] : [values['emfRe'], values['emfIm']];
        const r = values['internalResistanceOhm'];
        residual = [-drop[0] - (emf[0] - ik[0] * r), -drop[1] - (emf[1] - ik[1] * r)];
        break;
      }
      case 'isource':
        residual = [ik[0] - values['currentA'], ik[1]];
        scale = iScale;
        break;
      case 'inductor': {
        const x = omega * values['inductanceH'];
        residual = [drop[0] + x * ik[1], drop[1] - x * ik[0]];
        break;
      }
      case 'capacitor': {
        const b = omega * values['capacitanceF'];
        residual = [ik[0] + b * drop[1], ik[1] - b * drop[0]];
        scale = iScale;
        break;
      }
    }
    worst = Math.max(worst, abs(residual) / scale);
    kcl[branch.a][0] += ik[0];
    kcl[branch.a][1] += ik[1];
    kcl[branch.b][0] -= ik[0];
    kcl[branch.b][1] -= ik[1];
  }
  for (let n = 1; n < netlist.nodeCount; n++) worst = Math.max(worst, Math.hypot(kcl[n][0], kcl[n][1]) / iScale);
  return worst;
}
