import fc from 'fast-check';
import { type ContextKeys, type ContextValue, evaluateWhen, parseWhen, type WhenExpr } from '../when';
import { MAX_DNF_TERMS, provablyDisjoint } from './disjoint';

const when = (source: string): WhenExpr => {
  const parsed = parseWhen(source);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.expr;
};
const disjoint = (a: string | null, b: string | null) =>
  provablyDisjoint(a === null ? null : when(a), b === null ? null : when(b));

describe('provablyDisjoint', () => {
  it('never calls a binding without `when` disjoint', () => {
    expect(disjoint(null, 'mode == "walk"')).toBe(false);
    expect(disjoint('false', null)).toBe(false);
    expect(disjoint(null, null)).toBe(false);
  });

  it('proves different values of one key disjoint', () => {
    expect(disjoint('mode == "walk"', 'mode == "work"')).toBe(true);
    expect(disjoint('mode == "walk"', '"work" == mode')).toBe(true);
    expect(disjoint('mode == "walk"', 'mode != "walk"')).toBe(true);
    expect(disjoint('mode != "walk"', 'mode == "walk"')).toBe(true);
    expect(disjoint('mode == 1', 'mode == "1"')).toBe(true); // strict equality
    expect(disjoint('!(mode != "walk")', 'mode == "work"')).toBe(true);
  });

  it('proves truthy against falsy disjoint, including falsy and truthy values', () => {
    expect(disjoint('viewport.focused', '!viewport.focused')).toBe(true);
    expect(disjoint('!viewport.focused', 'viewport.focused')).toBe(true);
    expect(disjoint('viewport.focused', 'viewport.focused == false')).toBe(true);
    expect(disjoint('viewport.focused == false', 'viewport.focused')).toBe(true);
    expect(disjoint('!k', 'k == "x"')).toBe(true);
    expect(disjoint('k == "x"', '!k')).toBe(true);
    expect(disjoint('k == 0', 'k')).toBe(true);
    expect(disjoint('k == ""', 'k')).toBe(true);
    expect(disjoint('k == null', 'k')).toBe(true);
  });

  it('handles conjunctions, disjunctions and De Morgan', () => {
    expect(disjoint('a && mode == "walk"', 'b && mode == "work"')).toBe(true);
    expect(disjoint('mode == "walk" || mode == "work"', 'mode == "editor"')).toBe(true);
    expect(disjoint('mode == "walk" || mode == "work"', 'mode == "work"')).toBe(false);
    expect(disjoint('!(a || b)', 'a')).toBe(true);
    expect(disjoint('!(a && b)', 'a && b')).toBe(true);
    expect(disjoint('!(a && b)', 'a')).toBe(false);
  });

  it('treats unsatisfiable expressions as disjoint from anything', () => {
    expect(disjoint('false', 'a')).toBe(true);
    expect(disjoint('0', 'a')).toBe(true);
    expect(disjoint('!true', 'a')).toBe(true);
    expect(disjoint('1 == 2', 'a')).toBe(true);
    expect(disjoint('1 != 1', 'a')).toBe(true);
    expect(disjoint('a == 1 && a == 2', 'b')).toBe(true);
  });

  it('is conservative for anything it cannot analyse', () => {
    expect(disjoint('a == b', 'a != b')).toBe(false); // key against key: opaque
    expect(disjoint('a != 1', 'a != 2')).toBe(false);
    expect(disjoint('a != null', '!a')).toBe(false); // satisfiable: a == false
    expect(disjoint('true', 'a')).toBe(false);
    expect(disjoint('1 == 1', 'a')).toBe(false);
    expect(disjoint('k == "x"', 'k')).toBe(false);
    expect(disjoint('!k', 'k == false')).toBe(false);
  });

  it('gives up (overlap) when the DNF would exceed the cap', () => {
    // (a1 || b1) && (a2 || b2) && … has 2^n terms.
    const wide = Array.from({ length: 7 }, (_, i) => `(a${i} || b${i})`).join(' && ');
    expect(2 ** 7).toBeGreaterThan(MAX_DNF_TERMS);
    expect(disjoint(`${wide} && mode == "x"`, 'mode == "y"')).toBe(false);
    const long = `(${Array.from({ length: MAX_DNF_TERMS + 1 }, (_, i) => `k${i}`).join('||')}) && m == "x"`;
    expect(disjoint(long, 'm == "z"')).toBe(false);
    expect(disjoint('m == "z"', long)).toBe(false);
  });

  it('is sound: no context satisfies two expressions it calls disjoint', () => {
    const keys = ['a', 'b', 'c'] as const;
    const values: ContextValue[] = [null, true, false, 0, 1, '', 'x'];
    const literal = fc.constantFrom(...values).map((v) => (typeof v === 'string' ? JSON.stringify(v) : String(v)));
    const key = fc.constantFrom(...keys);
    const atom = fc.oneof(
      key,
      literal,
      fc.tuple(key, fc.constantFrom('==', '!='), fc.oneof(literal, key)).map(([k, op, v]) => `${k} ${op} ${v}`),
    );
    const expr = fc.letrec<{ e: string }>((tie) => ({
      e: fc.oneof(
        { depthSize: 'small', withCrossShrink: true },
        atom,
        tie('e').map((e) => `!(${e})`),
        fc.tuple(tie('e'), fc.constantFrom('&&', '||'), tie('e')).map(([l, op, r]) => `(${l}) ${op} (${r})`),
      ),
    })).e;
    const contexts: ContextKeys[] = [];
    for (const a of values) for (const b of values) for (const c of [null, 'x', 0]) contexts.push({ a, b, c });
    fc.assert(
      fc.property(expr, expr, (left, right) => {
        const l = when(left);
        const r = when(right);
        if (!provablyDisjoint(l, r)) return;
        for (const context of contexts) expect(evaluateWhen(l, context) && evaluateWhen(r, context)).toBe(false);
      }),
      { numRuns: 400 },
    );
  });
});
