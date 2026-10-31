import { type OracleCircuit, type OracleDomain } from './circuit';
import { generateOracleCircuit } from './generate';

/*
 * The pinned corpus (ADR 0012): per domain, the seed its circuits are drawn from and how many there
 * are. The checked-in decks under `libs/domain/sim-core/oracle/<domain>/` are exactly
 * `oracleCorpus(domain)` emitted by `oracleDeck`, which the staleness test checks byte for byte.
 * Changing a seed or a count, or anything the generator or the deck emitter does, means regenerating
 * the corpus with `pnpm sim oracle regen` (which needs ngspice) and committing decks and results
 * together.
 */

export interface OracleCorpusSpec {
  readonly seed: number;
  readonly count: number;
}

export const ORACLE_CORPUS: Readonly<Record<OracleDomain, OracleCorpusSpec>> = {
  dc: { seed: 20_261_030, count: 500 },
  ac: { seed: 20_261_031, count: 500 },
};

/** Every circuit of a domain's corpus, in index order. */
export function oracleCorpus(domain: OracleDomain): OracleCircuit[] {
  const { seed, count } = ORACLE_CORPUS[domain];
  return Array.from({ length: count }, (_, index) => generateOracleCircuit(domain, seed, index));
}

/** A deck's path inside the corpus directory: `dc/dc-0042.cir`. */
export function oracleDeckPath(circuit: Pick<OracleCircuit, 'domain' | 'name'>): string {
  return `${circuit.domain}/${circuit.name}.cir`;
}

/** A domain's results file inside the corpus directory: `dc.results.txt`. */
export function oracleResultsPath(domain: OracleDomain): string {
  return `${domain}.results.txt`;
}
