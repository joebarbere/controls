/*
 * `when` context expressions (plan §4.6, ADR 0006). A small hand-written recursive-descent parser and
 * evaluator: the renderer's CSP bans `eval` and `new Function`, and a fixed grammar is easier to
 * reason about (F1.4 uses the AST to decide whether two bindings' contexts can overlap).
 *
 * Grammar, lowest precedence first:
 *
 *   expr     := or
 *   or       := and ( '||' and )*
 *   and      := equality ( '&&' equality )*
 *   equality := unary ( ( '==' | '!=' ) unary )?      (not chainable: `a == b == c` is an error)
 *   unary    := '!' unary | primary
 *   primary  := '(' expr ')' | literal | key
 *   literal  := 'true' | 'false' | 'null' | number | string
 *   key      := segment ( '.' segment )*               segment := [A-Za-z_][A-Za-z0-9_]*
 *   number   := '-'? digits ( '.' digits )?
 *   string   := '...' or "..." with \\ \' \" escapes
 *
 * `!` binds tighter than `==`, as in JavaScript. Values compare with strict equality. A bare key is
 * truthy unless it is missing, `null`, `false`, `0` or `''`. Missing keys read as `null`.
 */

/** A context value. Keys are flat dotted names: `{ mode: 'work', 'selection.kind': 'terminal' }`. */
export type ContextValue = string | number | boolean | null;
export type ContextKeys = Readonly<Record<string, ContextValue>>;

export type WhenExpr =
  | { readonly type: 'key'; readonly key: string }
  | { readonly type: 'literal'; readonly value: ContextValue }
  | { readonly type: 'not'; readonly operand: WhenExpr }
  | { readonly type: 'and' | 'or'; readonly left: WhenExpr; readonly right: WhenExpr }
  | { readonly type: 'equals' | 'notEquals'; readonly left: WhenExpr; readonly right: WhenExpr };

export interface WhenParseError {
  readonly message: string;
  /** 1-based column in the source where the problem was found. */
  readonly column: number;
}

export type WhenParseResult =
  { readonly ok: true; readonly expr: WhenExpr } | { readonly ok: false; readonly error: WhenParseError };

/** Longest `when` source accepted. Expressions come from code, but the bound keeps the parser cheap. */
export const MAX_WHEN_LENGTH = 512;
/** Deepest nesting of parentheses and `!` accepted, so recursion stays shallow. */
export const MAX_WHEN_DEPTH = 32;

type TokenKind = 'key' | 'literal' | '==' | '!=' | '&&' | '||' | '!' | '(' | ')' | 'end';

interface Token {
  readonly kind: TokenKind;
  readonly column: number;
  readonly key?: string;
  readonly value?: ContextValue;
}

class WhenSyntaxError extends Error {
  constructor(
    message: string,
    readonly column: number,
  ) {
    super(message);
  }
}

const SEGMENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const NUMBER = /-?\d+(?:\.\d+)?/y;
const KEYWORDS: Readonly<Record<string, ContextValue>> = { true: true, false: false, null: null };

function tokenise(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const column = i + 1;
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    const pair = source.slice(i, i + 2);
    if (pair === '==' || pair === '!=' || pair === '&&' || pair === '||') {
      tokens.push({ kind: pair, column });
      i += 2;
      continue;
    }
    if (ch === '!' || ch === '(' || ch === ')') {
      tokens.push({ kind: ch, column });
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const { value, end } = readString(source, i);
      tokens.push({ kind: 'literal', column, value });
      i = end;
      continue;
    }
    NUMBER.lastIndex = i;
    const number = NUMBER.exec(source);
    if (number) {
      tokens.push({ kind: 'literal', column, value: Number(number[0]) + 0 });
      i += number[0].length;
      continue;
    }
    const key = readKey(source, i);
    if (key) {
      tokens.push(
        Object.prototype.hasOwnProperty.call(KEYWORDS, key)
          ? { kind: 'literal', column, value: KEYWORDS[key] }
          : { kind: 'key', column, key },
      );
      i += key.length;
      continue;
    }
    throw new WhenSyntaxError(`Unexpected character '${ch}'`, column);
  }
  tokens.push({ kind: 'end', column: source.length + 1 });
  return tokens;
}

function readKey(source: string, start: number): string | null {
  let i = start;
  for (;;) {
    SEGMENT.lastIndex = i;
    const segment = SEGMENT.exec(source);
    if (!segment) {
      if (i === start) return null;
      throw new WhenSyntaxError('Expected a key segment after "."', i + 1);
    }
    i += segment[0].length;
    if (source[i] !== '.') return source.slice(start, i);
    i++;
  }
}

function readString(source: string, start: number): { value: string; end: number } {
  const quote = source[start];
  let value = '';
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === quote) return { value, end: i + 1 };
    if (ch === '\\') {
      const next = source[i + 1];
      if (next !== '\\' && next !== "'" && next !== '"') {
        throw new WhenSyntaxError('Unknown escape (only \\\\, \\\' and \\" are allowed)', i + 1);
      }
      value += next;
      i += 2;
      continue;
    }
    value += ch;
    i++;
  }
  throw new WhenSyntaxError('Unterminated string', start + 1);
}

class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): WhenExpr {
    const expr = this.or();
    const next = this.peek();
    if (next.kind !== 'end') throw new WhenSyntaxError(`Unexpected '${describe(next)}'`, next.column);
    return expr;
  }

  private peek(): Token {
    return this.tokens[this.index];
  }

  private take(): Token {
    return this.tokens[this.index++];
  }

  private or(): WhenExpr {
    let left = this.and();
    while (this.peek().kind === '||') {
      this.take();
      left = { type: 'or', left, right: this.and() };
    }
    return left;
  }

  private and(): WhenExpr {
    let left = this.equality();
    while (this.peek().kind === '&&') {
      this.take();
      left = { type: 'and', left, right: this.equality() };
    }
    return left;
  }

  private equality(): WhenExpr {
    const left = this.unary();
    const op = this.peek().kind;
    if (op !== '==' && op !== '!=') return left;
    this.take();
    const right = this.unary();
    const after = this.peek();
    if (after.kind === '==' || after.kind === '!=') {
      throw new WhenSyntaxError('Comparisons cannot be chained; use && or parentheses', after.column);
    }
    return { type: op === '==' ? 'equals' : 'notEquals', left, right };
  }

  private unary(): WhenExpr {
    const token = this.peek();
    if (token.kind === '!') {
      this.take();
      return this.nested(token, () => ({ type: 'not', operand: this.unary() }));
    }
    return this.primary();
  }

  private primary(): WhenExpr {
    const token = this.take();
    switch (token.kind) {
      case '(':
        return this.nested(token, () => {
          const expr = this.or();
          const close = this.take();
          if (close.kind !== ')')
            throw new WhenSyntaxError(`Expected ')' but found '${describe(close)}'`, close.column);
          return expr;
        });
      case 'key':
        return { type: 'key', key: token.key as string };
      case 'literal':
        return { type: 'literal', value: token.value as ContextValue };
      default:
        throw new WhenSyntaxError(
          token.kind === 'end' ? 'Expression ended early' : `Unexpected '${describe(token)}'`,
          token.column,
        );
    }
  }

  private nested(token: Token, parse: () => WhenExpr): WhenExpr {
    if (++this.depth > MAX_WHEN_DEPTH) {
      throw new WhenSyntaxError(`Nested deeper than ${MAX_WHEN_DEPTH} levels`, token.column);
    }
    const expr = parse();
    this.depth--;
    return expr;
  }
}

function describe(token: Token): string {
  if (token.kind === 'end') return 'end of expression';
  if (token.kind === 'key') return token.key as string;
  if (token.kind === 'literal') return JSON.stringify(token.value);
  return token.kind;
}

/** Parses a `when` expression. Never throws. */
export function parseWhen(source: string): WhenParseResult {
  if (source.length > MAX_WHEN_LENGTH) {
    return { ok: false, error: { message: `Longer than ${MAX_WHEN_LENGTH} characters`, column: 1 } };
  }
  try {
    return { ok: true, expr: new Parser(tokenise(source)).parse() };
  } catch (error) {
    if (error instanceof WhenSyntaxError) return { ok: false, error: { message: error.message, column: error.column } };
    throw error;
  }
}

function value(expr: WhenExpr, context: ContextKeys): ContextValue {
  switch (expr.type) {
    case 'key':
      return Object.prototype.hasOwnProperty.call(context, expr.key) ? context[expr.key] : null;
    case 'literal':
      return expr.value;
    default:
      return evaluateWhen(expr, context);
  }
}

/** Evaluates a parsed expression against the current context keys. */
export function evaluateWhen(expr: WhenExpr, context: ContextKeys): boolean {
  switch (expr.type) {
    case 'not':
      return !evaluateWhen(expr.operand, context);
    case 'and':
      return evaluateWhen(expr.left, context) && evaluateWhen(expr.right, context);
    case 'or':
      return evaluateWhen(expr.left, context) || evaluateWhen(expr.right, context);
    case 'equals':
      return value(expr.left, context) === value(expr.right, context);
    case 'notEquals':
      return value(expr.left, context) !== value(expr.right, context);
    default:
      return Boolean(value(expr, context));
  }
}
