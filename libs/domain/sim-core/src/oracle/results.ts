import { type OracleCircuit, type OracleDomain, ORACLE_DOMAINS } from './circuit';
import { branchVectorNames, nodeVectorNames } from './deck';

/*
 * The corpus results (plan F2.7, ADR 0012): ngspice's solution of every deck, one text file per
 * domain (`dc.results.txt`, `ac.results.txt`), written by `pnpm sim oracle regen` and read by the
 * comparison specs. Plain text, so a regeneration diffs readably.
 *
 *   # comment lines
 *   domain dc
 *   ngspice ngspice-47
 *   solver SPARSE 1.3
 *   options .options sparse gmin=1e-12 noopac
 *   gmin 1e-12
 *   seed 20261030
 *   count 500
 *   circuit dc-0000 <SHA-256 of the deck text>
 *   v <node 1> <node 2> …          node voltages, nodes 1 … n − 1 (node 0 is the reference, 0 V)
 *   i <branch 0> <branch 1> …      branch currents, positive from a to b
 *   circuit dc-0001 …
 *
 * Each value is ngspice's own 17-significant-digit text, copied verbatim: `re,im` in AC, one number
 * in DC. The parser returns them as `re, im` pairs, interleaved like `WorldV2.sim` (ADR 0013), with
 * `im = 0` in DC and node 0 included, so index k of the pairs is node k or branch k.
 */

export interface OracleResultsHeader {
  readonly domain: OracleDomain;
  /** The ngspice version, as its banner prints it (`ngspice-47`). */
  readonly ngspice: string;
  /** The linear solver ngspice reported (`SPARSE 1.3`, from `.options sparse`). */
  readonly solver: string;
  /** The decks' `.options` line. */
  readonly options: string;
  /** The `gmin` (S) the decks stamp from every node to ground. */
  readonly gminS: number;
  readonly seed: number;
  readonly count: number;
}

/** One circuit's ngspice solution. */
export interface OracleCircuitResult {
  readonly name: string;
  /** SHA-256 (hex) of the deck text it was solved from: a stale result is caught against the deck. */
  readonly deckSha256: string;
  /** Node voltages (V) as `re, im` pairs, node 0 (0 V) first: 2 × nodeCount numbers. */
  readonly nodes: readonly number[];
  /** Branch currents (A) as `re, im` pairs, branch 0 first: 2 × elements numbers. */
  readonly branches: readonly number[];
}

export interface OracleResults {
  readonly header: OracleResultsHeader;
  readonly circuits: readonly OracleCircuitResult[];
}

/** One circuit's values as ngspice printed them (the regeneration's raw form, before writing). */
export interface OracleRawResult {
  readonly name: string;
  readonly deckSha256: string;
  readonly nodes: readonly string[];
  readonly branches: readonly string[];
}

export class OracleResultsError extends Error {
  override readonly name = 'OracleResultsError';
}

/** A decimal floating-point literal, as ngspice prints one (`-1.19989885330911736e+01`). */
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HEADER_KEYS = ['domain', 'ngspice', 'solver', 'options', 'gmin', 'seed', 'count'] as const;

function parseNumber(token: string, where: string): number {
  if (!NUMBER.test(token)) throw new OracleResultsError(`${where}: "${token}" is not a number`);
  return Number(token);
}

/** A value token as `[re, im]`: `re,im` in AC, a plain number (im = 0) in DC. */
function parseValue(domain: OracleDomain, token: string, where: string): [number, number] {
  if (domain === 'dc') return [parseNumber(token, where), 0];
  const parts = token.split(',');
  if (parts.length !== 2) throw new OracleResultsError(`${where}: "${token}" is not a complex value re,im`);
  return [parseNumber(parts[0], where), parseNumber(parts[1], where)];
}

/**
 * Pulls a circuit's values out of ngspice's batch-mode stdout (`name = value` lines from the deck's
 * `print` commands), as the text ngspice printed. Throws {@link OracleResultsError} naming what is
 * missing or malformed, so a failed run (a singular matrix, a parse error) never becomes a result.
 */
export function parseNgspiceOutput(
  circuit: OracleCircuit,
  stdout: string,
): { readonly solver: string; readonly nodes: string[]; readonly branches: string[] } {
  const printed = new Map<string, string>();
  let solver: string | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const solverMatch = /^Using (.+) as Direct Linear Solver$/.exec(line);
    if (solverMatch) solver = solverMatch[1];
    const match = /^(\S+) = (\S+)$/.exec(line);
    if (!match) continue;
    if (printed.has(match[1])) throw new OracleResultsError(`${circuit.name}: ngspice printed ${match[1]} twice`);
    printed.set(match[1], match[2]);
  }
  if (solver === null) throw new OracleResultsError(`${circuit.name}: ngspice did not report its linear solver`);
  const take = (name: string) => {
    const token = printed.get(name);
    if (token === undefined) throw new OracleResultsError(`${circuit.name}: ngspice printed no ${name}`);
    parseValue(circuit.domain, token, `${circuit.name} ${name}`);
    return token;
  };
  return { solver, nodes: nodeVectorNames(circuit).map(take), branches: branchVectorNames(circuit).map(take) };
}

/** The results file text for a domain: the header, then each circuit in order. LF, newline-terminated. */
export function formatOracleResults(header: OracleResultsHeader, circuits: readonly OracleRawResult[]): string {
  const lines = [
    `# Controls ngspice oracle results (plan F2.7, ADR 0012): ngspice's solution of every deck in ${header.domain}/.`,
    '# Generated by `pnpm sim oracle regen` (docs/guides/oracle.md): do not edit.',
    `domain ${header.domain}`,
    `ngspice ${header.ngspice}`,
    `solver ${header.solver}`,
    `options ${header.options}`,
    `gmin ${header.gminS}`,
    `seed ${header.seed}`,
    `count ${header.count}`,
  ];
  for (const circuit of circuits) {
    lines.push(`circuit ${circuit.name} ${circuit.deckSha256}`, `v ${circuit.nodes.join(' ')}`);
    lines.push(`i ${circuit.branches.join(' ')}`);
  }
  return `${lines.join('\n')}\n`;
}

function parseHeader(lines: readonly string[]): { header: OracleResultsHeader; next: number } {
  const values: Record<string, string> = {};
  let i = 0;
  while (i < lines.length && lines[i].startsWith('#')) i++;
  for (const key of HEADER_KEYS) {
    const line = lines[i] ?? '';
    const space = line.indexOf(' ');
    if (space < 0 || line.slice(0, space) !== key) {
      throw new OracleResultsError(`line ${i + 1}: expected the "${key}" header line`);
    }
    values[key] = line.slice(space + 1);
    i++;
  }
  const domain = values['domain'] as OracleDomain;
  if (!ORACLE_DOMAINS.includes(domain)) throw new OracleResultsError(`unknown domain "${values['domain']}"`);
  const integer = (key: string) => {
    const text = values[key];
    if (!/^\d+$/.test(text)) throw new OracleResultsError(`header ${key}: "${text}" is not an integer`);
    return Number(text);
  };
  return {
    header: {
      domain,
      ngspice: values['ngspice'],
      solver: values['solver'],
      options: values['options'],
      gminS: parseNumber(values['gmin'], 'header gmin'),
      seed: integer('seed'),
      count: integer('count'),
    },
    next: i,
  };
}

/** Parses a results file. Throws {@link OracleResultsError}, with the line, on anything malformed. */
export function parseOracleResults(text: string): OracleResults {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const { header, next } = parseHeader(lines);
  const circuits: OracleCircuitResult[] = [];
  for (let i = next; i < lines.length; i += 3) {
    const where = `line ${i + 1}`;
    const head = lines[i].split(' ');
    if (head.length !== 3 || head[0] !== 'circuit' || !SHA256.test(head[2])) {
      throw new OracleResultsError(`${where}: expected "circuit <name> <sha256>"`);
    }
    const row = (offset: number, tag: 'v' | 'i') => {
      const line = lines[i + offset];
      const tokens = line === undefined ? [] : line.split(' ');
      if (tokens[0] !== tag || tokens.length < 2) {
        throw new OracleResultsError(`line ${i + offset + 1}: expected the "${tag}" row of ${head[1]}`);
      }
      return tokens.slice(1).flatMap((token) => parseValue(header.domain, token, `line ${i + offset + 1}`));
    };
    circuits.push({ name: head[1], deckSha256: head[2], nodes: [0, 0, ...row(1, 'v')], branches: row(2, 'i') });
  }
  if (circuits.length !== header.count) {
    throw new OracleResultsError(`the header says ${header.count} circuits, but the file has ${circuits.length}`);
  }
  return { header, circuits };
}
