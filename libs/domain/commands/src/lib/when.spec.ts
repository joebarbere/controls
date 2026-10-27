import fc from 'fast-check';
import { type ContextKeys, evaluateWhen, MAX_WHEN_DEPTH, MAX_WHEN_LENGTH, parseWhen, type WhenExpr } from './when';

function evaluate(source: string, context: ContextKeys): boolean {
  const parsed = parseWhen(source);
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.error.message} at ${parsed.error.column}`);
  return evaluateWhen(parsed.expr, context);
}

function parseError(source: string) {
  const parsed = parseWhen(source);
  if (parsed.ok) throw new Error(`expected "${source}" to fail`);
  return parsed.error;
}

describe('parseWhen', () => {
  it('builds an AST with the documented precedence (! > == > && > ||)', () => {
    const parsed = parseWhen('!a == b && c || d');
    expect(parsed).toEqual({
      ok: true,
      expr: {
        type: 'or',
        left: {
          type: 'and',
          left: {
            type: 'equals',
            left: { type: 'not', operand: { type: 'key', key: 'a' } },
            right: { type: 'key', key: 'b' },
          },
          right: { type: 'key', key: 'c' },
        },
        right: { type: 'key', key: 'd' },
      },
    } satisfies { ok: true; expr: WhenExpr });
  });

  it('reads dotted keys, keywords, numbers and both string quotes', () => {
    expect(parseWhen(`selection.kind != 'a\\'b' && n == -1.5 && s == "x\\"y\\\\" && z == null && t == true`)).toEqual({
      ok: true,
      expr: {
        type: 'and',
        left: {
          type: 'and',
          left: {
            type: 'and',
            left: {
              type: 'and',
              left: {
                type: 'notEquals',
                left: { type: 'key', key: 'selection.kind' },
                right: { type: 'literal', value: "a'b" },
              },
              right: { type: 'equals', left: { type: 'key', key: 'n' }, right: { type: 'literal', value: -1.5 } },
            },
            right: { type: 'equals', left: { type: 'key', key: 's' }, right: { type: 'literal', value: 'x"y\\' } },
          },
          right: { type: 'equals', left: { type: 'key', key: 'z' }, right: { type: 'literal', value: null } },
        },
        right: { type: 'equals', left: { type: 'key', key: 't' }, right: { type: 'literal', value: true } },
      },
    });
  });

  it('normalises -0 in number literals', () => {
    const parsed = parseWhen('-0');
    expect(parsed.ok && parsed.expr.type === 'literal' && Object.is(parsed.expr.value, 0)).toBe(true);
  });

  it.each([
    ['', 'Expression ended early', 1],
    ['a &&', 'Expression ended early', 5],
    ['a == b == c', 'Comparisons cannot be chained; use && or parentheses', 8],
    ['(a', "Expected ')' but found 'end of expression'", 3],
    ['a)', "Unexpected ')'", 2],
    ['a b', "Unexpected 'b'", 3],
    ['1 2', "Unexpected '2'", 3],
    ["'x' 'y'", 'Unexpected \'"y"\'', 5],
    ['a = b', "Unexpected character '='", 3],
    ['a & b', "Unexpected character '&'", 3],
    ['a.', 'Expected a key segment after "."', 3],
    ['a.1', 'Expected a key segment after "."', 3],
    ["'open", 'Unterminated string', 1],
    ["'\\n'", 'Unknown escape (only \\\\, \\\' and \\" are allowed)', 2],
    ['&&', "Unexpected '&&'", 1],
    ['$x', "Unexpected character '$'", 1],
  ])('rejects %j with a message and column', (source, message, column) => {
    expect(parseError(source)).toEqual({ message, column });
  });

  it('caps length and nesting depth instead of recursing without bound', () => {
    expect(parseError('a'.repeat(MAX_WHEN_LENGTH + 1)).message).toMatch(/Longer than/);
    expect(parseWhen('a'.repeat(MAX_WHEN_LENGTH)).ok).toBe(true);
    const deep = '('.repeat(MAX_WHEN_DEPTH + 1) + 'a' + ')'.repeat(MAX_WHEN_DEPTH + 1);
    expect(parseError(deep).message).toMatch(/Nested deeper/);
    expect(parseError('!'.repeat(MAX_WHEN_DEPTH + 1) + 'a').message).toMatch(/Nested deeper/);
    expect(parseWhen('!'.repeat(MAX_WHEN_DEPTH) + 'a').ok).toBe(true);
  });

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (source) => {
        const parsed = parseWhen(source);
        expect(typeof parsed.ok).toBe('boolean');
      }),
    );
  });

  it('accepts tabs as whitespace', () => {
    expect(parseWhen('a\t&&\tb').ok).toBe(true);
  });
});

describe('evaluateWhen', () => {
  const context: ContextKeys = {
    mode: 'work',
    'selection.kind': 'terminal',
    'history.canUndo': true,
    'history.canRedo': false,
    count: 0,
    empty: '',
    nothing: null,
  };

  it.each([
    ['mode == work', false], // `work` is a key (missing → null), not a string
    ["mode == 'work'", true],
    ["mode == 'work' && selection.kind == 'terminal'", true],
    ["mode == 'walk' || selection.kind == 'terminal'", true],
    ["mode != 'walk'", true],
    ["!(mode == 'work')", false],
    ['history.canUndo', true],
    ['history.canRedo', false],
    ['!history.canRedo', true],
    ['count', false],
    ['count == 0', true],
    ['empty', false],
    ['nothing', false],
    ['missing', false],
    ['missing == null', true],
    ['nothing == missing', true],
    ['!missing && history.canUndo', true],
    ['true', true],
    ['false || 1', true],
    ["'1' == 1", false],
    ['(history.canUndo || history.canRedo) && !(count != 0)', true],
  ])('%s → %s', (source, expected) => {
    expect(evaluate(source, context)).toBe(expected);
  });

  it('ignores inherited properties of the context object', () => {
    expect(evaluate('toString', {})).toBe(false);
    expect(evaluate('constructor == null', {})).toBe(true);
  });

  it('matches JavaScript semantics for &&, || and ! over boolean keys', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (a, b, c) => {
        const ctx = { a, b, c };
        expect(evaluate('a && !b || c', ctx)).toBe((a && !b) || c);
        expect(evaluate('a && (!b || c)', ctx)).toBe(a && (!b || c));
        expect(evaluate('!a == b', ctx)).toBe(!a === b);
        expect(evaluate('a != b && c', ctx)).toBe(a !== b && c);
      }),
    );
  });
});
