import type { ContextValue, WhenExpr } from '../when';

/*
 * "Provably disjoint" `when` contexts (plan F1.4, ADR 0006 "Keybindings"). Two bindings on the same
 * chord conflict unless no context can make both `when`s true. Deciding that exactly is a SAT
 * problem, so this is deliberately **conservative**: it only answers "disjoint" when it can prove
 * it, and every unclear case counts as a conflict (shown to the player, never silently shadowed).
 *
 * The proof:
 * 1. Push negations inward (De Morgan, `!(k == v)` → `k != v`) and expand to disjunctive normal
 *    form: an OR of terms, each an AND of atoms. More than {@link MAX_DNF_TERMS} terms gives up.
 * 2. Atoms are `k == v`, `k != v`, `k` (truthy), `!k` (falsy) and constants. Anything else (two keys
 *    compared, a literal compared with a negation, …) is opaque and contradicts nothing.
 * 3. Two `when`s are disjoint when **every** pair of terms (one from each side) is contradictory:
 *    the same key is required to equal two different values, to equal and not equal one value, to
 *    be truthy and falsy, or to equal a value of the wrong truthiness; or a term contains `false`.
 *
 * Falsy values are those `evaluateWhen` treats as false: `null` (also a missing key), `false`, `0`
 * and `''`. A binding with no `when` is always active, so it is never disjoint from anything.
 */

/** Largest DNF expansion attempted per expression before assuming overlap. */
export const MAX_DNF_TERMS = 64;

type Atom =
  | { readonly type: 'eq' | 'neq'; readonly key: string; readonly value: ContextValue }
  | { readonly type: 'truthy' | 'falsy'; readonly key: string }
  | { readonly type: 'false' }
  | { readonly type: 'opaque' };

type Term = readonly Atom[];

const isFalsy = (v: ContextValue): boolean => v === null || v === false || v === 0 || v === '';

/** `when` → DNF terms, or `null` if the expansion is too large to analyse. */
function dnf(expr: WhenExpr, negated: boolean): Term[] | null {
  switch (expr.type) {
    case 'not':
      return dnf(expr.operand, !negated);
    case 'and':
    case 'or': {
      // De Morgan: under negation, AND becomes OR and vice versa.
      const conjunction = (expr.type === 'and') !== negated;
      const left = dnf(expr.left, negated);
      const right = dnf(expr.right, negated);
      if (!left || !right) return null;
      if (!conjunction) return left.length + right.length > MAX_DNF_TERMS ? null : [...left, ...right];
      if (left.length * right.length > MAX_DNF_TERMS) return null;
      return left.flatMap((l) => right.map((r) => [...l, ...r]));
    }
    case 'equals':
    case 'notEquals':
      return [[comparison(expr.left, expr.right, (expr.type === 'equals') !== negated)]];
    case 'key':
      return [[{ type: negated ? 'falsy' : 'truthy', key: expr.key }]];
    case 'literal':
      return isFalsy(expr.value) !== negated ? [[{ type: 'false' }]] : [[]];
  }
}

function comparison(left: WhenExpr, right: WhenExpr, equal: boolean): Atom {
  const [key, literal] =
    left.type === 'key' && right.type === 'literal'
      ? [left.key, right.value]
      : right.type === 'key' && left.type === 'literal'
        ? [right.key, left.value]
        : [null, null];
  if (key !== null) return { type: equal ? 'eq' : 'neq', key, value: literal };
  if (left.type === 'literal' && right.type === 'literal') {
    return (left.value === right.value) === equal ? { type: 'opaque' } : { type: 'false' };
  }
  return { type: 'opaque' };
}

/** Whether no context can satisfy every atom of `term`. */
function contradictory(term: Term): boolean {
  const byKey = new Map<string, Atom[]>();
  for (const atom of term) {
    if (atom.type === 'false') return true;
    if (atom.type === 'opaque') continue;
    const atoms = byKey.get(atom.key) ?? [];
    for (const other of atoms) if (clash(atom, other)) return true;
    atoms.push(atom);
    byKey.set(atom.key, atoms);
  }
  return false;
}

/** Two atoms on the same key that can't both hold. */
function clash(a: Atom, b: Atom): boolean {
  if (a.type === 'eq' && b.type === 'eq') return a.value !== b.value;
  if (a.type === 'eq' && b.type === 'neq') return a.value === b.value;
  if (a.type === 'neq' && b.type === 'eq') return a.value === b.value;
  if (a.type === 'eq' && b.type === 'truthy') return isFalsy(a.value);
  if (a.type === 'truthy' && b.type === 'eq') return isFalsy(b.value);
  if (a.type === 'eq' && b.type === 'falsy') return !isFalsy(a.value);
  if (a.type === 'falsy' && b.type === 'eq') return !isFalsy(b.value);
  return (a.type === 'truthy' && b.type === 'falsy') || (a.type === 'falsy' && b.type === 'truthy');
}

/**
 * Whether two `when` expressions can never both be true (see the module comment). `null` means "no
 * `when`" (always true). Conservative: `false` means "could overlap", not "does overlap".
 */
export function provablyDisjoint(a: WhenExpr | null, b: WhenExpr | null): boolean {
  if (a === null || b === null) return false;
  const left = dnf(a, false);
  const right = dnf(b, false);
  if (!left || !right) return false;
  return left.every((l) => right.every((r) => contradictory([...l, ...r])));
}
