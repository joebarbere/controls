import { MAX_CONSOLE_LINE_LENGTH, parseConsoleLine, splitConsoleLines } from './parse';

function line(source: string) {
  const result = parseConsoleLine(source);
  if (!result.ok) throw new Error(`unexpected parse error: ${result.error.message} (column ${result.error.column})`);
  return result.line;
}

function error(source: string) {
  const result = parseConsoleLine(source);
  if (result.ok) throw new Error(`expected a parse error for ${JSON.stringify(source)}`);
  return result.error;
}

describe('parseConsoleLine', () => {
  it('parses a dotted id, positional words and flags with columns', () => {
    expect(line('entity.move 3 --positionMm.x 100 --positionMm.y -20')).toEqual({
      id: 'entity.move',
      column: 1,
      positionals: [{ text: '3', quoted: false, column: 13 }],
      flags: [
        { name: 'positionMm.x', column: 15, value: { text: '100', quoted: false, column: 30 } },
        { name: 'positionMm.y', column: 34, value: { text: '-20', quoted: false, column: 49 } },
      ],
    });
  });

  it('accepts single-segment verbs (help, run) for the console to handle', () => {
    expect(line('  help entity.place')).toMatchObject({
      id: 'help',
      column: 3,
      positionals: [{ text: 'entity.place' }],
    });
  });

  it('reads a bare flag as having no value, when followed by a flag or the end', () => {
    expect(line('x.y --a --b 1 --c')?.flags).toEqual([
      { name: 'a', column: 5, value: null },
      { name: 'b', column: 9, value: { text: '1', quoted: false, column: 13 } },
      { name: 'c', column: 15, value: null },
    ]);
  });

  it('decodes quoted strings with escapes, in both quote styles', () => {
    const parsed = line(`x.y "a b" 'it\\'s' "q\\"\\\\" '' --f "--not-a-flag"`);
    expect(parsed?.positionals.map((w) => [w.text, w.quoted])).toEqual([
      ['a b', true],
      ["it's", true],
      ['q"\\', true],
      ['', true],
    ]);
    expect(parsed?.flags[0].value).toEqual({ text: '--not-a-flag', quoted: true, column: 34 });
  });

  it('treats blank lines and comments as no command, and strips trailing comments', () => {
    expect(line('')).toBeNull();
    expect(line('   \t ')).toBeNull();
    expect(line('# a comment')).toBeNull();
    expect(line('  # indented comment')).toBeNull();
    expect(line('edit.undo # trailing')).toEqual({ id: 'edit.undo', column: 1, positionals: [], flags: [] });
    // `#` inside a word or a quoted string is not a comment.
    expect(line('x.y a#b "#c"')?.positionals.map((w) => w.text)).toEqual(['a#b', '#c']);
  });

  it.each([
    ['"entity.place"', 1, /command id/],
    ['--flag', 1, /command id/],
    ['Entity.place', 1, /command id/],
    ['entity..place', 1, /command id/],
    ['x.y "open', 5, /Unterminated/],
    ['x.y "a\\nb"', 7, /Unknown escape/],
    ['x.y "a\\', 7, /Unknown escape/],
    ['x.y "a"b', 8, /space after the closing quote/],
    ['x.y ab"c"', 7, /Unexpected quote/],
    ['x.y --a 1 pos', 11, /before flags/],
    ['x.y --', 5, /Malformed flag/],
    ['x.y --a..b', 5, /Malformed flag/],
    ['x.y --1a', 5, /Malformed flag/],
    ['x.y \u0001', 5, /Control characters/],
    ['x.y \u007f', 5, /Control characters/],
  ])('rejects %j at column %i', (source, column, message) => {
    const e = error(source);
    expect(e.column).toBe(column);
    expect(e.message).toMatch(message);
  });

  it('caps the line length', () => {
    expect(error(`x.y ${'a'.repeat(MAX_CONSOLE_LINE_LENGTH)}`)).toMatchObject({ column: 1, message: /longer than/ });
    expect(line(`x.y ${'a'.repeat(MAX_CONSOLE_LINE_LENGTH - 4)}`)?.positionals).toHaveLength(1);
  });

  it('allows tabs as separators', () => {
    expect(line('x.y\t1\t--a\t2')).toMatchObject({ positionals: [{ text: '1' }], flags: [{ name: 'a' }] });
  });
});

describe('splitConsoleLines', () => {
  it('splits on LF and CRLF, numbers lines from 1 and drops a BOM', () => {
    expect(splitConsoleLines('﻿a.b\r\n\nc.d 1\n')).toEqual([
      { lineNumber: 1, source: 'a.b' },
      { lineNumber: 2, source: '' },
      { lineNumber: 3, source: 'c.d 1' },
      { lineNumber: 4, source: '' },
    ]);
  });
});
