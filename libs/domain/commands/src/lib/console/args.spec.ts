import fc from 'fast-check';
import { z } from 'zod';
import { defineCommand, succeed } from '../command';
import { CommandRegistry } from '../registry';
import { consoleArgs, ConsoleFormatError, formatConsoleLine, parseConsoleCommand } from './args';
import { type ConsoleCommandLine, parseConsoleLine } from './parse';

const Int = z.int();
const Place = z.strictObject({
  ref: z.strictObject({ id: z.string().regex(/^[a-z.]+$/), version: Int.min(1) }),
  positionMm: z.strictObject({ x: Int, y: Int, z: Int }),
  orientationMdeg: z.strictObject({ yaw: Int, pitch: Int, roll: Int }).default({ yaw: 0, pitch: 0, roll: 0 }),
});
const Misc = z.strictObject({
  id: Int.min(1),
  label: z.string().optional(),
  visible: z.boolean().default(false),
  mode: z.enum(['walk', 'work']).optional(),
  tag: z
    .string()
    .transform((s) => s.toUpperCase())
    .optional(),
  version: z.literal(1).optional(),
  kind: z.literal('box').optional(),
  flag: z.literal(true).optional(),
  either: z.union([z.string(), z.number()]).optional(),
  ratio: z.number().nullable().optional(),
});

const registry = new CommandRegistry<number>()
  .register(
    defineCommand({
      id: 'entity.place',
      title: 'Place',
      category: 'T',
      args: Place,
      undoable: true,
      run: () => succeed(),
    }),
  )
  .register(
    defineCommand({ id: 'misc.cmd', title: 'Misc', category: 'T', args: Misc, undoable: false, run: () => succeed() }),
  )
  .register(
    defineCommand({
      id: 'edit.undo',
      title: 'Undo',
      category: 'T',
      args: z.strictObject({}),
      undoable: false,
      run: () => succeed(),
    }),
  );

function parsed(source: string): ConsoleCommandLine {
  const result = parseConsoleLine(source);
  if (!result.ok || !result.line) throw new Error(`bad test line ${source}`);
  return result.line;
}

function args(source: string): Record<string, unknown> {
  const result = parseConsoleCommand(registry, source);
  if (!result.ok) throw new Error(`unexpected error: ${result.error.message} (column ${result.error.column})`);
  if (!result.command) throw new Error('expected a command');
  return result.command.args;
}

function mappingError(source: string) {
  const result = parseConsoleCommand(registry, source);
  if (result.ok) throw new Error(`expected an error for ${source}`);
  return result.error;
}

describe('consoleArgs', () => {
  it('maps dotted flags onto nested objects and types numbers from the schema', () => {
    expect(
      args('entity.place --ref.id prop.crate --ref.version 1 --positionMm.x 100 --positionMm.y 0 --positionMm.z -200'),
    ).toEqual({ ref: { id: 'prop.crate', version: 1 }, positionMm: { x: 100, y: 0, z: -200 } });
  });

  it('fills positional words into the shape keys in declaration order', () => {
    expect(args('misc.cmd 3 hello')).toEqual({ id: 3, label: 'hello' });
    expect(args('misc.cmd 3 --label "two words"')).toEqual({ id: 3, label: 'two words' });
  });

  it('types words by their leaf schema', () => {
    expect(args('misc.cmd --id 1 --label 12 --visible --mode work --tag x --version 1 --kind box')).toEqual({
      id: 1,
      label: '12', // a string field keeps the text
      visible: true,
      mode: 'work',
      tag: 'x', // pipes are typed by their input
      version: 1,
      kind: 'box',
    });
    expect(args('misc.cmd --id 1 --visible false')).toEqual({ id: 1, visible: false });
    expect(args('misc.cmd --id 1 --visible true')).toEqual({ id: 1, visible: true });
    expect(args('misc.cmd --id 1 --ratio 0.5')).toEqual({ id: 1, ratio: 0.5 });
    expect(args('misc.cmd --id 1 --ratio null')).toEqual({ id: 1, ratio: null });
  });

  it('gives unclassifiable leaves (unions, mixed literals) the lexical type', () => {
    expect(args('misc.cmd 1 --either 5')).toEqual({ id: 1, either: 5 });
    expect(args('misc.cmd 1 --either "5"')).toEqual({ id: 1, either: '5' });
    expect(args('misc.cmd 1 --either abc')).toEqual({ id: 1, either: 'abc' });
    expect(args('misc.cmd 1 --either true')).toEqual({ id: 1, either: true });
    expect(args('misc.cmd 1 --either false')).toEqual({ id: 1, either: false });
    expect(args('misc.cmd 1 --either 1e999')).toEqual({ id: 1, either: '1e999' });
    expect(args('misc.cmd 1 --flag true')).toEqual({ id: 1, flag: true });
  });

  it('maps a command without arguments to {}', () => {
    expect(args('edit.undo')).toEqual({});
  });

  it.each([
    ['nope.nope', 1, /Unknown command "nope.nope"/],
    ['misc.cmd --nope 1', 10, /Unknown argument --nope/],
    ['misc.cmd --id.sub 1', 10, /Unknown argument --id.sub/],
    ['misc.cmd --__proto__.x 1', 10, /Unknown argument/],
    ['misc.cmd --constructor 1', 10, /Unknown argument/],
    ['misc.cmd --id x', 15, /--id expects a number, found "x"/],
    ['misc.cmd --id "1"', 15, /expects a number/],
    ['misc.cmd --id 01', 15, /expects a number/],
    ['misc.cmd --id 1e999', 15, /expects a number/],
    ['misc.cmd --id', 10, /--id needs a value/],
    ['misc.cmd 1 --visible maybe', 22, /expects true or false/],
    ['misc.cmd 1 --visible "true"', 22, /expects true or false/],
    ['misc.cmd 1 --version two', 22, /expects a number/],
    ['misc.cmd 1 --id 2', 12, /Argument id is given twice/],
    ['misc.cmd --id 1 --id 2', 17, /given twice/],
    ['entity.place --ref x', 14, /--ref is an object/],
    ['entity.place --positionMm.x 1 --positionMm 2', 31, /positionMm is given twice/],
    ['entity.place --ref.id a --ref.id b', 25, /ref.id is given twice/],
    ['edit.undo 1', 11, /takes no positional arguments/],
    ['misc.cmd 1 a true walk b 1 box true c 1 extra', 41, /at most 10 positional arguments/],
    ['entity.place x', 14, /ref is an object/],
    ['x.y "a', 5, /Unterminated/],
  ])('reports %j at column %i', (source, column, message) => {
    const e = mappingError(source);
    expect(e.column).toBe(column);
    expect(e.message).toMatch(message);
  });

  it('reports a conflicting nested flag after a scalar', () => {
    const schema = z.strictObject({ a: z.union([z.string(), z.strictObject({ b: z.string() })]) });
    // A union leaf is lexical, so `--a x` sets a string; `--a.b` can't then descend into it.
    expect(consoleArgs(schema, parsed('x.y --a x --a.b y'))).toMatchObject({ ok: false, error: { column: 11 } });
  });

  it('says how many positional arguments a one-key command takes', () => {
    const one = z.strictObject({ id: Int });
    expect(consoleArgs(one, parsed('x.y 1 2'))).toMatchObject({
      ok: false,
      error: { message: 'x.y takes at most 1 positional argument (id)', column: 7 },
    });
  });

  it('treats a non-object schema as taking no arguments', () => {
    expect(consoleArgs(z.string(), parsed('x.y'))).toEqual({ ok: true, args: {} });
    expect(consoleArgs(z.string(), parsed('x.y --a 1'))).toMatchObject({ ok: false, error: { column: 5 } });
  });

  it('returns null for blank and comment lines', () => {
    expect(parseConsoleCommand(registry, '  # nothing')).toEqual({ ok: true, command: null });
  });
});

describe('formatConsoleLine', () => {
  it('writes every argument as a sorted flag', () => {
    expect(
      formatConsoleLine('entity.place', {
        positionMm: { z: -200, x: 100, y: 0 },
        ref: { id: 'prop.crate', version: 1 },
      }),
    ).toBe('entity.place --positionMm.x 100 --positionMm.y 0 --positionMm.z -200 --ref.id prop.crate --ref.version 1');
    expect(formatConsoleLine('edit.undo')).toBe('edit.undo');
    expect(formatConsoleLine('misc.cmd', { id: 1, label: undefined, visible: true, ratio: null })).toBe(
      'misc.cmd --id 1 --ratio null --visible true',
    );
  });

  it('quotes strings that would otherwise read back differently', () => {
    expect(
      formatConsoleLine('misc.cmd', {
        a: '',
        b: 'two words',
        c: '12',
        d: 'true',
        e: '--x',
        f: '#c',
        g: 'q"\\',
        h: "'",
      }),
    ).toBe(`misc.cmd --a "" --b "two words" --c "12" --d "true" --e "--x" --f "#c" --g "q\\"\\\\" --h "'"`);
  });

  it.each([
    ['an array', { a: [1] }, /array/],
    ['an empty object', { a: {} }, /empty object/],
    ['NaN', { a: Number.NaN }, /finite/],
    ['a newline', { a: 'line\nbreak' }, /control character/],
    ['a bigint', { a: 1n }, /console word/],
    ['a key that is not a flag name', { 'bad key': 1 }, /flag name/],
  ])('refuses %s', (_label, value, message) => {
    expect(() => formatConsoleLine('x.y', value)).toThrow(ConsoleFormatError);
    expect(() => formatConsoleLine('x.y', value)).toThrow(message);
  });

  it('round-trips through parseConsoleCommand (property)', () => {
    const text = fc
      .string({ maxLength: 12 })
      .filter((s) => [...s].every((ch) => ch === '\t' || (ch >= ' ' && ch !== '\u007f')));
    const int = fc.integer({ min: -1_000_000, max: 1_000_000 });
    fc.assert(
      fc.property(
        fc.record({
          id: fc.integer({ min: 1, max: 1_000_000 }),
          label: fc.option(text, { nil: undefined }),
          visible: fc.boolean(),
          mode: fc.option(fc.constantFrom('walk' as const, 'work' as const), { nil: undefined }),
          either: fc.option(fc.oneof(int, fc.boolean(), fc.stringMatching(/^[a-z]{1,6}$/)), { nil: undefined }),
          ratio: fc.option(fc.double({ noNaN: true, noDefaultInfinity: true }), { nil: undefined }),
        }),
        (value) => {
          const expected = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
          expect(args(formatConsoleLine('misc.cmd', value))).toEqual(expected);
        },
      ),
    );
  });
});
