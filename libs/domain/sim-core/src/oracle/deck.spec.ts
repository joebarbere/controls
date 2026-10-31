import { type OracleCircuit, phasorUnit, valueNumber, valueText } from './circuit';
import { oracleDeckPath, oracleResultsPath } from './corpus';
import { branchVectorNames, gminShuntText, nodeVectorNames, oracleDeck, oracleDeckOptions } from './deck';
import { oracleNetlist } from './netlist';

/*
 * The two emitters of one oracle circuit (F2.7): the SPICE deck and the sim-core netlist. A hand-built
 * circuit pins each deck line and each netlist value, so a change to either is deliberate.
 */

const v = (mantissa: number, exponent: number) => ({ mantissa, exponent });

/** Every element kind once: a source into a divider with a current source (DC). */
const DC: OracleCircuit = {
  name: 'dc-0007',
  domain: 'dc',
  seed: 11,
  index: 7,
  nodeCount: 3,
  elements: [
    { kind: 'vsource', a: 0, b: 1, emfV: v(12, 0), angleDeg: 0, internalResistanceOhm: v(23, -3) },
    { kind: 'resistor', a: 1, b: 2, resistanceOhm: v(47, 2) },
    { kind: 'resistor', a: 2, b: 0, resistanceOhm: v(10, 3) },
    { kind: 'isource', a: 0, b: 2, currentA: v(15, -4) },
  ],
};

/** A phasor source into an R, L and C (AC). */
const AC: OracleCircuit = {
  name: 'ac-0003',
  domain: 'ac',
  seed: 12,
  index: 3,
  nodeCount: 3,
  elements: [
    { kind: 'vsource', a: 0, b: 1, emfV: v(12, 1), angleDeg: -120, internalResistanceOhm: v(10, -2) },
    { kind: 'resistor', a: 1, b: 2, resistanceOhm: v(56, -1) },
    { kind: 'inductor', a: 2, b: 0, inductanceH: v(27, -3) },
    { kind: 'capacitor', a: 2, b: 0, capacitanceF: v(33, -6) },
  ],
};

describe('oracle values', () => {
  it('spell a decimal exactly and parse to its correctly rounded double', () => {
    expect(valueText(v(47, -3))).toBe('47e-3');
    expect(valueNumber(v(47, -3))).toBe(0.047);
    expect(valueNumber(v(82, 3))).toBe(82000);
  });

  it('phasor angles are exact constants (D6), not Math.cos/sin', () => {
    expect(phasorUnit(0)).toStrictEqual({ re: 1, im: 0 });
    expect(phasorUnit(180)).toStrictEqual({ re: -1, im: 0 });
    expect(phasorUnit(120)).toStrictEqual({ re: -0.5, im: Math.sqrt(3) / 2 });
    expect(phasorUnit(-120)).toStrictEqual({ re: -0.5, im: -Math.sqrt(3) / 2 });
  });
});

describe('oracleDeck', () => {
  it('writes a DC deck: explicit gmin shunts, sense sources, an op and full-precision prints', () => {
    expect(oracleDeck(DC)).toBe(
      [
        'controls oracle dc-0007',
        '* Generated (plan F2.7, ADR 0012): do not edit; regenerate with `pnpm sim oracle regen`. dc seed 11 index 7 nodes 3 elements 4',
        '.options sparse gmin=1e-12 noopac',
        'RG1 1 0 1000000000000',
        'RG2 2 0 1000000000000',
        'VS0 0 s0 0',
        'V0 e0 s0 DC 12e0',
        'RI0 e0 1 23e-3',
        'VS1 1 s1 0',
        'R1 s1 2 47e2',
        'VS2 2 s2 0',
        'R2 s2 0 10e3',
        'VS3 0 s3 0',
        'I3 s3 2 DC 15e-4',
        '.control',
        'set numdgt=17',
        'op',
        'print v(1) v(2)',
        'print i(vs0) i(vs1) i(vs2) i(vs3)',
        '.endc',
        '.end',
        '',
      ].join('\n'),
    );
  });

  it('writes an AC deck: the phasor as magnitude and angle, L and C, one 60 Hz point', () => {
    const lines = oracleDeck(AC).split('\n');
    expect(lines).toContain('V0 e0 s0 DC 0 AC 12e1 -120');
    expect(lines).toContain('L2 s2 0 27e-3');
    expect(lines).toContain('C3 s3 0 33e-6');
    expect(lines).toContain('ac lin 1 60 60');
    expect(lines).not.toContain('op');
  });

  it('prints at most ten vectors per line', () => {
    const big: OracleCircuit = {
      ...DC,
      nodeCount: 12,
      elements: Array.from({ length: 11 }, (_, k) => ({
        kind: 'resistor' as const,
        a: k,
        b: k + 1,
        resistanceOhm: v(10, 0),
      })),
    };
    const prints = oracleDeck(big)
      .split('\n')
      .filter((line) => line.startsWith('print '));
    expect(prints).toStrictEqual([
      `print ${nodeVectorNames(big).slice(0, 10).join(' ')}`,
      'print v(11)',
      `print ${branchVectorNames(big).slice(0, 10).join(' ')}`,
      'print i(vs10)',
    ]);
  });

  it('records options and the gmin shunt as the corpus header does', () => {
    expect(oracleDeckOptions()).toBe('.options sparse gmin=1e-12 noopac');
    expect(Number(gminShuntText()) * 1e-12).toBe(1);
  });

  it('places decks and results in the corpus directory', () => {
    expect(oracleDeckPath(DC)).toBe('dc/dc-0007.cir');
    expect(oracleResultsPath('ac')).toBe('ac.results.txt');
  });
});

describe('oracleNetlist', () => {
  it('gives the DC circuit as F2.1-style branches with sorted values', () => {
    expect(oracleNetlist(DC)).toStrictEqual({
      domain: 'dc',
      frequencyHz: null,
      nodeCount: 3,
      gminS: 1e-12,
      branches: [
        {
          index: 0,
          kind: 'vsource',
          source: 'dc',
          a: 0,
          b: 1,
          values: { emfV: 12, internalResistanceOhm: 0.023 },
        },
        { index: 1, kind: 'resistor', source: null, a: 1, b: 2, values: { resistanceOhm: 4700 } },
        { index: 2, kind: 'resistor', source: null, a: 2, b: 0, values: { resistanceOhm: 10000 } },
        { index: 3, kind: 'isource', source: 'dc', a: 0, b: 2, values: { currentA: 0.0015 } },
      ],
    });
  });

  it('gives an AC source its phasor from the exact angle constants', () => {
    const netlist = oracleNetlist(AC);
    expect(netlist.frequencyHz).toBe(60);
    expect(netlist.branches[0].values).toStrictEqual({
      emfIm: 120 * -(Math.sqrt(3) / 2),
      emfRe: -60,
      internalResistanceOhm: 0.1,
    });
    expect(netlist.branches.slice(1).map((branch) => [branch.kind, branch.values])).toStrictEqual([
      ['resistor', { resistanceOhm: 5.6 }],
      ['inductor', { inductanceH: 0.027 }],
      ['capacitor', { capacitanceF: 0.000033 }],
    ]);
  });
});
