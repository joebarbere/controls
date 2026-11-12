import { combinationProblem } from './combination';

/*
 * A twist-on splice's combination check (ADR 0018 §4.4): integer µm² areas from AWG_GAUGES.areaUm2
 * (18 AWG 823 047, 14 AWG 2 080 910, 12 AWG 3 308 770). Test bounds: two to three of 18–12 AWG,
 * 1 646 094 to 7 000 000 µm² in all.
 */

const combination = {
  minConductors: 2,
  maxConductors: 3,
  awg: { smallest: 18, largest: 12 },
  totalAreaUm2: { min: 1646094, max: 7000000 },
};

describe('combinationProblem', () => {
  it('accepts a combination inside every bound, and exactly at each bound', () => {
    expect(combinationProblem(combination, [14, 14])).toBeNull(); // 4 161 820
    expect(combinationProblem(combination, [18, 18])).toBeNull(); // 1 646 094: the minimum exactly
    expect(combinationProblem(combination, [12, 14, 18])).toBeNull(); // 6 212 727, three at the size bounds
    const tight = { ...combination, totalAreaUm2: { min: 1646094, max: 6212727 } };
    expect(combinationProblem(tight, [12, 14, 18])).toBeNull(); // the maximum exactly
    expect(combinationProblem(tight, [12, 14, 14])).toContain('above the splice'); // 7 470 590
  });

  it('refuses too many conductors, a size outside the range, and a total above the maximum', () => {
    expect(combinationProblem(combination, [18, 18, 18, 18])).toContain('at most 3 conductors, not 4');
    expect(combinationProblem(combination, [14, 10])).toContain('10 AWG conductor is outside');
    expect(combinationProblem(combination, [14, 20])).toContain('20 AWG conductor is outside');
    expect(combinationProblem(combination, [12, 12, 14])).toContain('above the splice'); // 8 698 450
  });

  it('checks the minimum total only once the splice holds its minimum count (it is built one conductor at a time)', () => {
    const big = { ...combination, totalAreaUm2: { min: 4161821, max: 9000000 } };
    expect(combinationProblem(big, [14])).toBeNull(); // one conductor: still being made
    expect(combinationProblem(big, [14, 14])).toContain('below the splice'); // 4 161 820 < 4 161 821
    expect(combinationProblem({ ...big, totalAreaUm2: { min: 4161820, max: 9000000 } }, [14, 14])).toBeNull();
  });
});
