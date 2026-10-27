/*
 * Console lines (plan §4.6 surface 3, F1.5 grammar, ADR 0008): the `verb.noun --flag value` syntax
 * shared by the in-game dev console (F1.5), console-line files (`run <file>`) and `sim-cli`.
 * Hand-written, like `when`: the renderer's CSP bans `eval`, and a fixed grammar gives errors with
 * a column. This file is purely lexical; `consoleArgs` maps a parsed line onto a command's Zod
 * args schema.
 *
 *   line       := ws* ( command ws* )? comment?
 *   command    := id ( ws+ ( flag | word ) )*
 *   id         := segment ( '.' segment )*          segment := [a-z][a-zA-Z0-9]*
 *   flag       := '--' name ( ws+ word )?           name := ident ( '.' ident )*, ident := [A-Za-z_][A-Za-z0-9_]*
 *   word       := bare | quoted
 *   bare       := any run of non-space characters not starting with '"', "'", '#' or '--'
 *   quoted     := '...' or "..." with \\ \' \" escapes, followed by a space or the end
 *   comment    := '#' to the end of the line (only where a word could start)
 *
 * - A flag takes the next word as its value unless that word is another flag or the line ends; a
 *   bare `--flag` means `true`. So positional words go before the flags.
 * - Words are typed later, against the schema (`consoleArgs`): `12` is a number for a number field
 *   and the string "12" for a string field. Quoted words are always strings.
 * - Dotted flag names address nested objects: `--positionMm.x 100`.
 */

/** One argument word, before it is typed against a schema. */
export interface ConsoleWord {
  /** The word's text, with quotes removed and escapes decoded. */
  readonly text: string;
  /** Whether it was quoted (a quoted word is always a string). */
  readonly quoted: boolean;
  /** 1-based column of the word's first character (its opening quote, if quoted). */
  readonly column: number;
}

export interface ConsoleFlag {
  /** Dotted flag name without the leading `--`, e.g. `positionMm.x`. */
  readonly name: string;
  /** 1-based column of the `--`. */
  readonly column: number;
  /** The value word, or `null` for a bare flag (which means `true`). */
  readonly value: ConsoleWord | null;
}

/** A parsed console line that names a command. */
export interface ConsoleCommandLine {
  readonly id: string;
  /** 1-based column of the id. */
  readonly column: number;
  readonly positionals: readonly ConsoleWord[];
  readonly flags: readonly ConsoleFlag[];
}

export interface ConsoleError {
  readonly message: string;
  /** 1-based column in the line where the problem was found. */
  readonly column: number;
}

/** `line` is `null` for a blank or comment-only line. */
export type ConsoleParseResult =
  | { readonly ok: true; readonly line: ConsoleCommandLine | null }
  | { readonly ok: false; readonly error: ConsoleError };

/** Longest console line accepted (characters). */
export const MAX_CONSOLE_LINE_LENGTH = 4096;

const ID = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/;
const FLAG_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const ESCAPES: Readonly<Record<string, string>> = { '\\': '\\', "'": "'", '"': '"' };

class ConsoleSyntaxError extends Error {
  constructor(
    message: string,
    readonly column: number,
  ) {
    super(message);
  }
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t';
}

interface RawWord extends ConsoleWord {
  /** An unquoted word starting with `--`. */
  readonly flag: boolean;
}

function readQuoted(source: string, start: number): { word: RawWord; end: number } {
  const quote = source[start];
  let text = '';
  let i = start + 1;
  for (;;) {
    if (i >= source.length) throw new ConsoleSyntaxError('Unterminated string', start + 1);
    const ch = source[i];
    if (ch === quote) break;
    if (ch === '\\') {
      const next = source[i + 1] ?? '';
      if (!Object.prototype.hasOwnProperty.call(ESCAPES, next)) {
        throw new ConsoleSyntaxError('Unknown escape (use \\\\, \\\' or \\")', i + 1);
      }
      text += ESCAPES[next];
      i += 2;
      continue;
    }
    text += ch;
    i++;
  }
  const end = i + 1;
  if (end < source.length && !isSpace(source[end])) {
    throw new ConsoleSyntaxError('Expected a space after the closing quote', end + 1);
  }
  return { word: { text, quoted: true, column: start + 1, flag: false }, end };
}

function tokenise(source: string): RawWord[] {
  const words: RawWord[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (isSpace(ch)) {
      i++;
      continue;
    }
    if (ch === '#') break;
    if (ch === '"' || ch === "'") {
      const { word, end } = readQuoted(source, i);
      words.push(word);
      i = end;
      continue;
    }
    const start = i;
    while (i < source.length && !isSpace(source[i])) {
      if (source[i] === '"' || source[i] === "'") {
        throw new ConsoleSyntaxError('Unexpected quote inside a word (quote the whole word)', i + 1);
      }
      i++;
    }
    const text = source.slice(start, i);
    words.push({ text, quoted: false, column: start + 1, flag: text.startsWith('--') });
  }
  return words;
}

function checkCharacters(source: string): void {
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
      throw new ConsoleSyntaxError('Control characters are not allowed', i + 1);
    }
  }
}

/**
 * Parses one console line. Blank and comment-only lines give `line: null`. Never throws; errors
 * carry a 1-based column. Doesn't consult the registry: see `consoleArgs` and `parseConsoleCommand`.
 */
export function parseConsoleLine(source: string): ConsoleParseResult {
  try {
    if (source.length > MAX_CONSOLE_LINE_LENGTH) {
      throw new ConsoleSyntaxError(`Line is longer than ${MAX_CONSOLE_LINE_LENGTH} characters`, 1);
    }
    checkCharacters(source);
    const words = tokenise(source);
    if (words.length === 0) return { ok: true, line: null };

    const [head, ...rest] = words;
    if (head.quoted || head.flag || !ID.test(head.text)) {
      throw new ConsoleSyntaxError(
        `Expected a command id like "entity.place", found ${JSON.stringify(head.text)}`,
        head.column,
      );
    }
    const positionals: ConsoleWord[] = [];
    const flags: ConsoleFlag[] = [];
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i];
      if (!word.flag) {
        if (flags.length > 0) {
          throw new ConsoleSyntaxError('Positional arguments must come before flags', word.column);
        }
        positionals.push(strip(word));
        continue;
      }
      const name = word.text.slice(2);
      if (!FLAG_NAME.test(name)) {
        throw new ConsoleSyntaxError(`Malformed flag ${JSON.stringify(word.text)}`, word.column);
      }
      const next = rest[i + 1];
      const value = next !== undefined && !next.flag ? strip(next) : null;
      if (value) i++;
      flags.push({ name, column: word.column, value });
    }
    return { ok: true, line: { id: head.text, column: head.column, positionals, flags } };
  } catch (error) {
    // Only ConsoleSyntaxError is thrown above.
    const { message, column } = error as ConsoleSyntaxError;
    return { ok: false, error: { message, column } };
  }
}

function strip(word: RawWord): ConsoleWord {
  return { text: word.text, quoted: word.quoted, column: word.column };
}

/** One line of a console-line file, with its 1-based line number. */
export interface ConsoleSourceLine {
  readonly lineNumber: number;
  readonly source: string;
}

/** Splits a console-line file into lines (`\n` or `\r\n`). Parse each with {@link parseConsoleLine}. */
export function splitConsoleLines(text: string): ConsoleSourceLine[] {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  return body.split('\n').map((line, index) => ({
    lineNumber: index + 1,
    source: line.endsWith('\r') ? line.slice(0, -1) : line,
  }));
}
