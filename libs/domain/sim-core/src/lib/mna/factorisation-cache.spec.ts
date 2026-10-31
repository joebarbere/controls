import fc from 'fast-check';
import { FACTORISATION_CACHE_CAPACITY, FACTORISATION_CACHE_MODE_VARIANTS } from '../constants';
import { SparseFactors } from '../lu/sparse-lu';
import { FactorisationCache, type IslandSymbolic } from './factorisation-cache';

const symbolic = (tag: number, signature: readonly number[] = [1]): IslandSymbolic => ({
  unknowns: tag,
  signature: Uint8Array.from(signature),
  pattern: { n: 0, colPtr: new Int32Array(1), rowIdx: new Int32Array(0) },
  slots: new Int32Array(0),
  order: new Int32Array(0),
  factors: new SparseFactors(),
  codes: new Uint8Array(0),
  branches: new Int32Array(0),
  rhsTargets: new Int32Array(0),
  rhsCodes: new Uint8Array(0),
  rhsBranches: new Int32Array(0),
  comp: new Int32Array(0),
  ends: 0,
});
const sig = (...codes: number[]) => Uint8Array.from(codes);

describe('FactorisationCache', () => {
  it('defaults to the sourced capacities and validates its sizes', () => {
    const cache = new FactorisationCache();
    expect(cache.capacity).toBe(FACTORISATION_CACHE_CAPACITY.value);
    expect(cache.modeVariants).toBe(FACTORISATION_CACHE_MODE_VARIANTS.value);
    for (const constant of [FACTORISATION_CACHE_CAPACITY, FACTORISATION_CACHE_MODE_VARIANTS]) {
      expect(constant.kind).toBe('numerical');
      expect(constant.source).toMatch(/^numerical: /);
    }
    expect(() => new FactorisationCache(0)).toThrow(RangeError);
    expect(() => new FactorisationCache(1.5)).toThrow(RangeError);
    expect(() => new FactorisationCache(2, 0)).toThrow(RangeError);
  });

  it('counts a miss, then a hit, by topology, island and signature', () => {
    const cache = new FactorisationCache(4);
    expect(cache.find('a', 0, sig(1), 1)).toBeUndefined();
    const s = symbolic(10);
    cache.store('a', 0, s);
    expect(cache.find('a', 0, sig(1), 1)).toBe(s);
    expect(cache.find('a', 1, sig(1), 1)).toBeUndefined(); // another island
    expect(cache.find('a', 0, sig(3), 1)).toBeUndefined(); // another stamp mode
    expect(cache.find('a', 0, sig(1, 1), 2)).toBeUndefined(); // another length
    expect(cache.find('b', 0, sig(1), 1)).toBeUndefined(); // another topology
    // Only the first `length` codes of the scratch signature are compared.
    expect(cache.find('a', 0, sig(1, 9, 9), 1)).toBe(s);
    expect(cache.stats).toStrictEqual({ hits: 2, misses: 5, evictions: 0, topologies: 1 });
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    cache.clear();
    expect(cache.stats).toStrictEqual({ hits: 0, misses: 0, evictions: 0, topologies: 0 });
  });

  it('evicts the least recently used topology, counting a lookup as a use', () => {
    const cache = new FactorisationCache(2);
    cache.store('a', 0, symbolic(1));
    cache.store('b', 0, symbolic(2));
    expect(cache.find('a', 0, sig(1), 1)?.unknowns).toBe(1); // a is now more recent than b
    cache.store('c', 0, symbolic(3)); // evicts b
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.stats.evictions).toBe(1);
    // A miss on a held topology (another island) still makes it recent.
    expect(cache.find('a', 5, sig(1), 1)).toBeUndefined();
    cache.store('d', 0, symbolic(4)); // evicts c, not a
    expect([cache.has('a'), cache.has('c'), cache.has('d')]).toStrictEqual([true, false, true]);
    // Storing into a held topology adds no entry and evicts nothing.
    cache.store('a', 1, symbolic(5));
    expect(cache.stats).toMatchObject({ evictions: 2, topologies: 2 });
  });

  it('keeps up to `modeVariants` stamp-mode variants per island, most recently used first', () => {
    const cache = new FactorisationCache(2, 2);
    const cv = symbolic(1, [2]);
    const cc = symbolic(2, [3]);
    cache.store('a', 0, cv);
    cache.store('a', 0, cc);
    expect(cache.find('a', 0, sig(2), 1)).toBe(cv); // moves cv to the front
    cache.store('a', 0, symbolic(3, [1])); // drops the least recent variant: cc
    expect(cache.find('a', 0, sig(3), 1)).toBeUndefined();
    expect(cache.find('a', 0, sig(2), 1)).toBe(cv);
    expect(cache.find('a', 0, sig(1), 1)?.unknowns).toBe(3);
  });

  it('matches a reference LRU model on random sequences (property)', () => {
    const op = fc.record({ hash: fc.nat({ max: 5 }), island: fc.nat({ max: 1 }), store: fc.boolean() });
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), fc.array(op, { maxLength: 60 }), (capacity, ops) => {
        const cache = new FactorisationCache(capacity, 4);
        // The model: an array of [hash, islands], most recent last.
        const model: [string, Set<number>][] = [];
        const touch = (hash: string) => {
          const at = model.findIndex(([h]) => h === hash);
          if (at < 0) return undefined;
          const [entry] = model.splice(at, 1);
          model.push(entry);
          return entry;
        };
        for (const { hash, island, store } of ops) {
          const key = `t${hash}`;
          if (store) {
            let entry = touch(key);
            if (entry === undefined) {
              if (model.length >= capacity) model.shift();
              entry = [key, new Set()];
              model.push(entry);
            }
            entry[1].add(island);
            cache.store(key, island, symbolic(hash));
          } else {
            const entry = touch(key);
            const expected = entry !== undefined && entry[1].has(island);
            expect(cache.find(key, island, sig(1), 1) !== undefined).toBe(expected);
          }
          expect(cache.stats.topologies).toBe(model.length);
          for (const [h] of model) expect(cache.has(h)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});
