import { ORACLE_DOMAINS, type OracleCircuit, type OracleElement, PHASOR_ANGLES, valueNumber } from './circuit';
import { oracleCorpus } from './corpus';
import {
  generateOracleCircuit,
  isExcited,
  ORACLE_MAX_NODES,
  ORACLE_MIN_NODES,
  ORACLE_RANGES,
  oracleCircuitName,
  oracleStreamKey,
} from './generate';

/*
 * The seeded random-circuit generator (F2.7). The corpus is generated once per domain at module
 * level; every property is checked over all of it (1,000 circuits, a few ms).
 */

const corpora = { dc: oracleCorpus('dc'), ac: oracleCorpus('ac') };

/** Whether every node reaches node 0 through elements other than current sources. */
function connected(circuit: OracleCircuit): boolean {
  const reached = new Set([0]);
  for (let grew = true; grew;) {
    grew = false;
    for (const { kind, a, b } of circuit.elements) {
      if (kind === 'isource' || reached.has(a) === reached.has(b)) continue;
      reached.add(a).add(b);
      grew = true;
    }
  }
  return reached.size === circuit.nodeCount;
}

function valueOf(element: OracleElement): [keyof typeof ORACLE_RANGES, number][] {
  switch (element.kind) {
    case 'resistor':
      return [['resistanceOhm', valueNumber(element.resistanceOhm)]];
    case 'vsource':
      return [
        ['emfV', valueNumber(element.emfV)],
        ['internalResistanceOhm', valueNumber(element.internalResistanceOhm)],
      ];
    case 'isource':
      return [['currentA', valueNumber(element.currentA)]];
    case 'inductor':
      return [['inductanceH', valueNumber(element.inductanceH)]];
    case 'capacitor':
      return [['capacitanceF', valueNumber(element.capacitanceF)]];
  }
}

describe('generateOracleCircuit', () => {
  it('is a pure function of the domain, seed and index', () => {
    expect(generateOracleCircuit('dc', 7, 3)).toStrictEqual(generateOracleCircuit('dc', 7, 3));
    expect(generateOracleCircuit('dc', 7, 3)).not.toStrictEqual(generateOracleCircuit('dc', 7, 4));
    expect(generateOracleCircuit('dc', 7, 3)).not.toStrictEqual(generateOracleCircuit('dc', 8, 3));
  });

  it('names circuits and streams stably', () => {
    expect(oracleCircuitName('ac', 42)).toBe('ac-0042');
    expect(oracleStreamKey('dc', 42)).toBe('oracle:dc:42');
  });

  describe.each(ORACLE_DOMAINS)('over the %s corpus', (domain) => {
    const circuits = corpora[domain];
    const kinds =
      domain === 'dc' ? ['isource', 'resistor', 'vsource'] : ['capacitor', 'inductor', 'resistor', 'vsource'];

    it('has 2–30 nodes, and reaches both ends of the range', () => {
      const counts = circuits.map((circuit) => circuit.nodeCount);
      expect(Math.min(...counts)).toBe(ORACLE_MIN_NODES);
      expect(Math.max(...counts)).toBe(ORACLE_MAX_NODES);
    });

    it('uses only its domain kinds, and all of them', () => {
      const seen = new Set(circuits.flatMap((circuit) => circuit.elements.map((element) => element.kind)));
      expect([...seen].sort()).toStrictEqual(kinds);
    });

    it('elements join two distinct nodes in range', () => {
      // Collected, not asserted per element: thousands of expect calls are slow on Windows CI.
      const bad = circuits.filter((circuit) =>
        circuit.elements.some(({ a, b }) => a === b || [a, b].some((n) => n < 0 || n >= circuit.nodeCount)),
      );
      expect(bad.map((circuit) => circuit.name)).toStrictEqual([]);
    });

    it('every node has a finite-impedance path to the reference, and every circuit is excited', () => {
      for (const circuit of circuits) {
        expect(connected(circuit), circuit.name).toBe(true);
        expect(isExcited(circuit.elements, circuit.nodeCount), circuit.name).toBe(true);
      }
    });

    it('node 0 is the reference sim-core picks: the negative end of the first voltage source', () => {
      for (const circuit of circuits) {
        const first = circuit.elements.find((element) => element.kind === 'vsource');
        if (first !== undefined) expect(first.a, circuit.name).toBe(0);
      }
    });

    it('values lie in their ranges', () => {
      const out = circuits.flatMap((circuit) =>
        circuit.elements.flatMap((element) =>
          valueOf(element).filter(([key, value]) => {
            const range = ORACLE_RANGES[key];
            return value < Number(`10e${range.minExponent}`) || value > Number(`82e${range.maxExponent}`);
          }),
        ),
      );
      expect(out).toStrictEqual([]);
    });

    it(domain === 'ac' ? 'uses every exact phasor angle' : 'gives DC sources angle 0', () => {
      const angles = new Set(
        circuits.flatMap((circuit) => circuit.elements.flatMap((e) => (e.kind === 'vsource' ? [e.angleDeg] : []))),
      );
      expect([...angles].sort()).toStrictEqual(domain === 'ac' ? [...PHASOR_ANGLES].sort() : [0]);
    });
  });
});

describe('isExcited', () => {
  const r = { mantissa: 10, exponent: 0 };
  const resistor = (a: number, b: number): OracleElement => ({ kind: 'resistor', a, b, resistanceOhm: r });
  const vsource = (a: number, b: number): OracleElement => ({
    kind: 'vsource',
    a,
    b,
    emfV: r,
    angleDeg: 0,
    internalResistanceOhm: r,
  });

  it('a voltage source on no loop drives nothing but gmin', () => {
    expect(isExcited([vsource(0, 1), resistor(1, 2)], 3)).toBe(false);
    expect(isExcited([resistor(0, 1)], 2)).toBe(false);
  });

  it('a loop through a voltage source, or any current source, drives current', () => {
    expect(isExcited([vsource(0, 1), resistor(1, 2), resistor(2, 0)], 3)).toBe(true);
    expect(isExcited([resistor(0, 1), { kind: 'isource', a: 0, b: 1, currentA: r }], 2)).toBe(true);
  });

  it('a lone voltage source drives nothing', () => {
    expect(isExcited([vsource(0, 1)], 2)).toBe(false);
  });
});
