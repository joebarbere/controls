import fc from 'fast-check';
import * as z from 'zod';
import { defineCommand, succeed } from '../command';
import { CommandRegistry } from '../registry';
import { consoleArgs, consoleFields, ConsoleFormatError, formatConsoleLine, parseConsoleCommand } from './args';
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
    ['a non-finite number in an array', { a: [1, Number.POSITIVE_INFINITY] }, /--a\[1\] is not a finite number/],
    ['a hole in an array', { a: [1, undefined] }, /--a\[1\] is missing/],
    ['a function in an array', { a: [() => 1] }, /can't be written as JSON/],
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

describe('consoleFields', () => {
  const pick = (schema: z.ZodType) =>
    consoleFields(schema).map(({ path, kind, optional, position }) => ({ path, kind, optional, position }));

  it('lists dotted leaf paths in declaration order, with positions for top-level scalars', () => {
    expect(pick(Place)).toEqual([
      { path: 'ref.id', kind: 'string', optional: false, position: null },
      { path: 'ref.version', kind: 'number', optional: false, position: null },
      { path: 'positionMm.x', kind: 'number', optional: false, position: null },
      { path: 'positionMm.y', kind: 'number', optional: false, position: null },
      { path: 'positionMm.z', kind: 'number', optional: false, position: null },
      { path: 'orientationMdeg.yaw', kind: 'number', optional: true, position: null },
      { path: 'orientationMdeg.pitch', kind: 'number', optional: true, position: null },
      { path: 'orientationMdeg.roll', kind: 'number', optional: true, position: null },
    ]);
  });

  it('classifies leaves the way consoleArgs types them, with enum values and bounds', () => {
    const fields = Object.fromEntries(consoleFields(Misc).map((f) => [f.path, f]));
    expect(fields['id']).toMatchObject({ kind: 'number', optional: false, position: 0, min: 1, max: null });
    expect(fields['visible']).toMatchObject({ kind: 'boolean', values: [true, false], optional: true });
    expect(fields['mode']).toMatchObject({ kind: 'enum', values: ['walk', 'work'], optional: true, position: 3 });
    expect(fields['tag']).toMatchObject({ kind: 'string' }); // the pipe's input decides
    expect(fields['version']).toMatchObject({ kind: 'enum', values: [1] });
    expect(fields['either']).toMatchObject({ kind: 'other' });
    expect(fields['ratio']).toMatchObject({ kind: 'number', nullable: true });
    expect(consoleFields(z.strictObject({ n: z.number().describe('How many') }))[0].description).toBe('How many');
    expect(consoleFields(z.string())).toEqual([]);
  });

  it('offers only flags that consoleArgs accepts', () => {
    const line = (flags: string): ConsoleCommandLine => {
      const parsed = parseConsoleLine(`x.y ${flags}`);
      if (!parsed.ok || !parsed.line) throw new Error('parse');
      return parsed.line;
    };
    for (const schema of [Place, Misc, Shapes]) {
      for (const field of consoleFields(schema)) {
        const value =
          field.kind === 'number'
            ? '1'
            : field.kind === 'boolean'
              ? 'true'
              : field.kind === 'json'
                ? String(field.values[0] ?? (field.nullable ? 'null' : '[]'))
                : String(field.values[0] ?? 'a');
        expect(consoleArgs(schema, line(`--${field.path} ${value}`)).ok, field.path).toBe(true);
      }
    }
  });

  it('lists arrays, nullable objects and object-or-literal unions as JSON words, and walks into them', () => {
    const fields = Object.fromEntries(consoleFields(Shapes).map((f) => [f.path, f]));
    expect(Object.keys(fields)).toEqual([
      'route',
      'tags',
      'end',
      'end.entity',
      'end.termination',
      'end.termination.method',
      'end.termination.torqueNm',
      'mount',
      'mount.entity',
      'mount.mount',
      'label',
      'mode',
      'mode.rate',
    ]);
    expect(fields['route']).toMatchObject({ kind: 'json', values: [], nullable: false, position: 0 });
    expect(fields['end']).toMatchObject({ kind: 'json', values: [], nullable: true, position: 2 });
    expect(fields['end.termination']).toMatchObject({ kind: 'json', values: ['auto'], nullable: false });
    expect(fields['end.termination.torqueNm']).toMatchObject({ kind: 'number', nullable: true });
    expect(fields['mount']).toMatchObject({ kind: 'json', nullable: true, optional: true });
    expect(fields['mount.entity']).toMatchObject({ kind: 'number', optional: true });
    expect(fields['label']).toMatchObject({ kind: 'string', nullable: true });
    expect(fields['mode']).toMatchObject({ kind: 'json', values: ['fast', 'slow'], nullable: true });
  });
});

/** Arrays, nullable objects, unions with an object member and nullable scalars (ADR 0015 shapes). */
const Point = z.strictObject({
  kind: z.enum(['free', 'duct']),
  positionMm: z.strictObject({ x: Int, y: Int, z: Int }),
});
const Termination = z.strictObject({ method: z.string(), torqueNm: z.number().nullable() });
const Shapes = z.strictObject({
  route: z.array(Point).max(4),
  tags: z.array(z.string()).optional(),
  end: z.strictObject({ entity: Int.min(1), termination: z.union([z.literal('auto'), Termination]) }).nullable(),
  mount: z.strictObject({ entity: Int, mount: z.string() }).nullable().default(null),
  label: z.string().nullable(),
  mode: z
    .union([z.literal('fast'), z.literal('slow'), z.strictObject({ rate: Int })])
    .nullable()
    .optional(),
});

describe('JSON words, nullable objects and unions (ADR 0008 amendment)', () => {
  const shapes = new CommandRegistry<number>().register(
    defineCommand({ id: 'wire.add', title: 'Add', category: 'T', args: Shapes, undoable: true, run: () => succeed() }),
  );
  const map = (source: string, shorthand?: (id: string, path: string) => boolean) => {
    const result = parseConsoleCommand(shapes, source, shorthand);
    if (!result.ok) throw new Error(`unexpected error: ${result.error.message} (column ${result.error.column})`);
    return result.command?.args;
  };
  const fail = (source: string) => {
    const result = parseConsoleCommand(shapes, source);
    if (result.ok) throw new Error(`expected an error for ${source}`);
    return result.error;
  };
  const route = [{ kind: 'free', positionMm: { x: 0, y: 1, z: -2 } }];

  it('takes an array as one JSON word, by flag or positionally', () => {
    const json = JSON.stringify(route);
    expect(map(`wire.add --route ${json}`)).toEqual({ route });
    expect(map(`wire.add ${json} ["a b","#c"]`)).toEqual({ route, tags: ['a b', '#c'] });
    expect(map('wire.add --route [ ]')).toEqual({ route: [] }); // spaces inside the brackets are fine
  });

  it('takes null for a nullable object or union, and dotted flags into its object member', () => {
    expect(map('wire.add --end null --mount null --label null --mode null')).toEqual({
      end: null,
      mount: null,
      label: null,
      mode: null,
    });
    expect(map('wire.add --label "null"')).toEqual({ label: 'null' });
    expect(map('wire.add --end.entity 3 --end.termination auto')).toEqual({ end: { entity: 3, termination: 'auto' } });
    expect(map('wire.add --end.entity 3 --end.termination.method screw --end.termination.torqueNm 0.5')).toEqual({
      end: { entity: 3, termination: { method: 'screw', torqueNm: 0.5 } },
    });
    expect(map('wire.add --end.termination.torqueNm null --mode.rate 2')).toEqual({
      end: { termination: { torqueNm: null } },
      mode: { rate: 2 },
    });
  });

  it('takes a whole object or union value as a JSON word', () => {
    expect(map('wire.add --end {"entity":3,"termination":{"method":"screw","torqueNm":null}}')).toEqual({
      end: { entity: 3, termination: { method: 'screw', torqueNm: null } },
    });
    expect(map('wire.add --end.termination {"method":"x y","torqueNm":1}')).toEqual({
      end: { termination: { method: 'x y', torqueNm: 1 } },
    });
  });

  it('keeps a shorthand word lexical where the expander asks for it', () => {
    const shorthand = (id: string, path: string) => id === 'wire.add' && path === 'route';
    expect(map('wire.add --route auto', shorthand)).toEqual({ route: 'auto' });
    expect(map(`wire.add --route ${JSON.stringify(route)}`, shorthand)).toEqual({ route });
    // A quoted word is text, never shorthand.
    expect(parseConsoleCommand(shapes, 'wire.add --route "auto"', shorthand)).toMatchObject({ ok: false });
  });

  it.each([
    ['wire.add --route auto', 10, /--route is a list: give it as one JSON word/],
    ['wire.add --end 3', 10, /--end is an object/],
    ['wire.add --label ["x"]', 18, /takes one word, not a JSON value/],
    ['wire.add --route [1,2', 18, /Unterminated JSON value/],
    ['wire.add --route [1,]', 18, /Malformed JSON value/],
    ['wire.add --route [1]x', 21, /Expected a space after the JSON value/],
    ['wire.add --route [{"__proto__":1}]', 18, /__proto__/],
    [`wire.add --route ${'['.repeat(33)}${']'.repeat(33)}`, 18, /nested deeper than 32/],
    ['wire.add --end {"entity":3} --end.entity 4', 29, /end is given twice/],
    ['wire.add --end null --end.entity 4', 21, /end is given twice/],
    ['wire.add --end.entity 4 --end null', 25, /end is given twice/],
    ['wire.add --end.nope 4', 10, /Unknown argument --end.nope/],
    ['wire.add --end.termination.nope 4', 10, /Unknown argument/],
  ])('reports %j at column %i', (source, column, message) => {
    const e = fail(source);
    expect(e.message).toMatch(message);
    expect(e.column).toBe(column);
  });

  it('writes arrays and empty objects as compact JSON words with sorted keys, and reads them back', () => {
    const args = {
      route: [{ positionMm: { z: -2, y: 1, x: 0 }, kind: 'free' }],
      tags: [],
      end: { termination: 'auto', entity: 3 },
      mount: null,
      label: '[A]',
    };
    const line = formatConsoleLine('wire.add', args);
    expect(line).toBe(
      'wire.add --end.entity 3 --end.termination auto --label "[A]" --mount null ' +
        '--route [{"kind":"free","positionMm":{"x":0,"y":1,"z":-2}}] --tags []',
    );
    expect(map(line)).toEqual(args);
    expect(formatConsoleLine('x.y', { a: {} })).toBe('x.y --a {}');
    expect(formatConsoleLine('x.y', { a: ['line\nbreak', 'q"'] })).toBe('x.y --a ["line\\nbreak","q\\""]');
  });

  it('round-trips arbitrary shapes through formatConsoleLine and parseConsoleCommand (property)', () => {
    const int = fc.integer({ min: -10_000_000, max: 10_000_000 });
    const text = fc.string({ maxLength: 8 });
    const printable = text.filter((s) => [...s].every((ch) => ch === '\t' || (ch >= ' ' && ch !== '\u007f')));
    const point = fc.record({
      kind: fc.constantFrom('free', 'duct'),
      positionMm: fc.record({ x: int, y: int, z: int }),
    });
    const termination = fc.oneof(
      fc.constant('auto' as const),
      fc.record({ method: printable, torqueNm: fc.option(fc.double({ noNaN: true, noDefaultInfinity: true })) }),
    );
    fc.assert(
      fc.property(
        fc.record(
          {
            route: fc.array(point, { maxLength: 4 }),
            tags: fc.array(text, { maxLength: 3 }),
            end: fc.option(fc.record({ entity: fc.integer({ min: 1, max: 1_000_000 }), termination })),
            mount: fc.option(fc.record({ entity: int, mount: fc.stringMatching(/^[a-z]{1,4}$/) })),
            label: fc.option(printable),
            mode: fc.option(fc.oneof(fc.constantFrom('fast', 'slow'), fc.record({ rate: int }))),
          },
          { requiredKeys: ['route'] },
        ),
        (value) => {
          const expected = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
          expect(map(formatConsoleLine('wire.add', value))).toEqual(expected);
        },
      ),
    );
  });
});
