import { UnionFind } from './union-find';

const roots = (sets: UnionFind, count: number) => Array.from({ length: count }, (_, i) => sets.find(i));

describe('UnionFind', () => {
  it('unions and finds', () => {
    const sets = new UnionFind(5);
    sets.union(0, 3);
    sets.union(3, 4);
    sets.union(1, 1);
    expect(sets.find(4)).toBe(sets.find(0));
    expect(new Set(roots(sets, 5)).size).toBe(3);
  });

  it('reset makes every element a singleton again, growing past its capacity and reusing it', () => {
    const sets = new UnionFind(3);
    sets.union(0, 1);
    sets.union(1, 2);
    sets.reset(6);
    expect(roots(sets, 6)).toStrictEqual([0, 1, 2, 3, 4, 5]);
    for (let i = 1; i < 6; i++) sets.union(0, i);
    sets.reset(2);
    expect(roots(sets, 2)).toStrictEqual([0, 1]);
    // Sizes reset too: union by size after a reset is as on a fresh instance.
    sets.reset(4);
    const fresh = new UnionFind(4);
    for (const s of [sets, fresh]) {
      s.union(2, 3);
      s.union(0, 2);
      s.union(1, 0);
    }
    expect(roots(sets, 4)).toStrictEqual(roots(fresh, 4));
  });

  it('joins the smaller set under the larger one, after a reset too (union by size keeps finds short)', () => {
    const sets = new UnionFind(8);
    for (let i = 1; i < 8; i++) sets.union(0, i);
    sets.reset(5);
    sets.union(0, 1);
    sets.union(2, 3);
    sets.union(3, 4);
    const larger = sets.find(2);
    sets.union(0, 4);
    expect(sets.find(0)).toBe(larger);
  });
});
