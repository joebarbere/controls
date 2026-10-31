import type { OracleCircuit } from './circuit';
import { compareOracleSolution, GOLDEN_RELATIVE_BOUND, ORACLE_TOLERANCE } from './compare';
import {
  formatOracleResults,
  type OracleCircuitResult,
  type OracleResultsHeader,
  OracleResultsError,
  parseNgspiceOutput,
  parseOracleResults,
} from './results';

/*
 * The results loader (F2.7): ngspice's batch output into raw values, the results file format, and
 * the parsed per-node and per-branch values the comparison specs will read; then the tolerance check.
 */

const one = { mantissa: 10, exponent: 0 };
const circuit = (domain: 'dc' | 'ac'): OracleCircuit => ({
  name: `${domain}-0001`,
  domain,
  seed: 1,
  index: 1,
  nodeCount: 3,
  elements: [
    { kind: 'resistor', a: 0, b: 1, resistanceOhm: one },
    { kind: 'resistor', a: 1, b: 2, resistanceOhm: one },
  ],
});

/** The shape of `ngspice -b` stdout (ngspice 47) for a deck's print lines. */
const DC_STDOUT = `
Note: No compatibility mode selected!

Circuit: controls oracle dc-0001

Doing analysis at TEMP = 27.000000 and TNOM = 27.000000

Using SPARSE 1.3 as Direct Linear Solver

No. of Data Rows : 1
v(1) = 1.19989885330911736e+01
v(2) = -9.97605472743713406e+00
i(vs0) = -2.0229338176527278e-03
i(vs1) = 0.00000000000000000e+00
Note: Simulation executed from .control section
`;

const AC_STDOUT = `Using SPARSE 1.3 as Direct Linear Solver\r
v(1) = -5.6220279517533605e+01,-1.0265373892752848e+02\r
v(2) = 2.32440849161704861e+01,0.00000000000000000e+00\r
i(vs0) = 7.55944096493273321e+00,2.53861905320832193e+00\r
i(vs1) = 1e-3,-2e-3\r
`;

const HEADER: OracleResultsHeader = {
  domain: 'dc',
  ngspice: 'ngspice-47',
  solver: 'SPARSE 1.3',
  options: '.options sparse gmin=1e-12 noopac',
  gminS: 1e-12,
  seed: 1,
  count: 1,
};
const SHA = 'ab'.repeat(32);

describe('parseNgspiceOutput', () => {
  it('takes each node voltage and branch current verbatim, and the solver', () => {
    expect(parseNgspiceOutput(circuit('dc'), DC_STDOUT)).toStrictEqual({
      solver: 'SPARSE 1.3',
      nodes: ['1.19989885330911736e+01', '-9.97605472743713406e+00'],
      branches: ['-2.0229338176527278e-03', '0.00000000000000000e+00'],
    });
  });

  it('reads complex AC values and CRLF output', () => {
    expect(parseNgspiceOutput(circuit('ac'), AC_STDOUT).branches).toStrictEqual([
      '7.55944096493273321e+00,2.53861905320832193e+00',
      '1e-3,-2e-3',
    ]);
  });

  it('refuses a run with a missing vector (a failed analysis), naming it', () => {
    expect(() => parseNgspiceOutput(circuit('dc'), DC_STDOUT.replace(/^i\(vs1\).*$/m, ''))).toThrow(
      new OracleResultsError('dc-0001: ngspice printed no i(vs1)'),
    );
  });

  it('refuses a vector printed twice, an unreported solver, and a malformed value', () => {
    expect(() => parseNgspiceOutput(circuit('dc'), `${DC_STDOUT}v(1) = 1\n`)).toThrow(/printed v\(1\) twice/);
    expect(() => parseNgspiceOutput(circuit('dc'), DC_STDOUT.replace(/^Using.*$/m, ''))).toThrow(
      /did not report its linear solver/,
    );
    expect(() => parseNgspiceOutput(circuit('dc'), DC_STDOUT.replace('1.19989885330911736e+01', 'nan'))).toThrow(
      /"nan" is not a number/,
    );
    expect(() => parseNgspiceOutput(circuit('ac'), AC_STDOUT.replace('1e-3,-2e-3', '1e-3'))).toThrow(
      /is not a complex value/,
    );
  });
});

describe('the results file', () => {
  const raw = { name: 'dc-0001', deckSha256: SHA, nodes: ['12', '-0.5'], branches: ['1e-3', '0'] };
  const text = formatOracleResults(HEADER, [raw]);

  it('round-trips: the header, and values as re, im pairs with node 0 first', () => {
    expect(parseOracleResults(text)).toStrictEqual({
      header: HEADER,
      circuits: [{ name: 'dc-0001', deckSha256: SHA, nodes: [0, 0, 12, 0, -0.5, 0], branches: [0.001, 0, 0, 0] }],
    });
  });

  it('reads AC values as re, im pairs', () => {
    const ac = formatOracleResults({ ...HEADER, domain: 'ac' }, [
      { ...raw, nodes: ['1,2', '3,-4'], branches: ['5,6', '0,0'] },
    ]);
    expect(parseOracleResults(ac).circuits[0]).toMatchObject({ nodes: [0, 0, 1, 2, 3, -4], branches: [5, 6, 0, 0] });
  });

  it.each([
    [
      'a header line out of order',
      (t: string) => t.replace('ngspice ngspice-47\nsolver SPARSE 1.3', 'solver SPARSE 1.3\nngspice ngspice-47'),
      /expected the "ngspice" header line/,
    ],
    ['an unknown domain', (t: string) => t.replace('domain dc', 'domain tran'), /unknown domain "tran"/],
    ['a non-integer seed', (t: string) => t.replace('seed 1', 'seed x'), /header seed: "x" is not an integer/],
    ['a bad gmin', (t: string) => t.replace('gmin 1e-12', 'gmin small'), /header gmin: "small" is not a number/],
    [
      'a bad circuit line',
      (t: string) => t.replace(`circuit dc-0001 ${SHA}`, 'circuit dc-0001 nope'),
      /expected "circuit <name> <sha256>"/,
    ],
    ['a missing current row', (t: string) => t.replace(/\ni .*\n$/, '\n'), /expected the "i" row of dc-0001/],
    ['a wrong row tag', (t: string) => t.replace('\nv 12', '\nx 12'), /expected the "v" row of dc-0001/],
    ['a count that disagrees', (t: string) => t.replace('count 1', 'count 2'), /says 2 circuits, but the file has 1/],
  ])('refuses %s', (_, mutate, message) => {
    expect(() => parseOracleResults(mutate(text))).toThrow(message);
  });
});

describe('compareOracleSolution', () => {
  const expected: OracleCircuitResult = {
    name: 'ac-0001',
    deckSha256: SHA,
    nodes: [0, 0, 100, -50, 1e-12, 0],
    branches: [2, 1, 0, 0],
  };

  it('stays far inside the 0.5 % golden bound (ADR 0012)', () => {
    expect(ORACLE_TOLERANCE.relative).toBeLessThanOrEqual(1e-6);
    expect(ORACLE_TOLERANCE.relative).toBeLessThan(GOLDEN_RELATIVE_BOUND);
  });

  it('accepts an exact match and errors within the relative tolerance or the floors', () => {
    expect(compareOracleSolution(expected, expected)).toStrictEqual([]);
    const close = { nodes: [0, 0, 100 + 1e-5, -50, 0, 0], branches: [2, 1 + 1e-6, 1e-10, 0] };
    expect(compareOracleSolution(expected, close)).toStrictEqual([]);
  });

  it('reports each value outside the tolerance, with its allowance; NaN never passes', () => {
    const off = { nodes: [0, 0, 100.01, -50, 0, 0], branches: [Number.NaN, 1, 0, 0] };
    const mismatches = compareOracleSolution(expected, off);
    expect(mismatches.map((m) => [m.quantity, m.index])).toStrictEqual([
      ['node', 1],
      ['branch', 0],
    ]);
    expect(mismatches[0].expected).toStrictEqual([100, -50]);
    expect(mismatches[0].error).toBeCloseTo(0.01, 12);
    expect(mismatches[0].allowed).toBeCloseTo(1e-6 * Math.hypot(100, 50) + 1e-9 * Math.hypot(100, 50), 15);
  });

  it('refuses a solution of the wrong size', () => {
    expect(() => compareOracleSolution(expected, { nodes: [0, 0], branches: expected.branches })).toThrow(RangeError);
  });
});
