import { ARG_REF_KEYWORD, entityRefMeta, fileCommands } from '@controls/commands';
import { createWorldRegistry } from '@controls/world-model';
import { z } from 'zod';
import {
  allFields,
  type ArgForm,
  argsFromValues,
  buildArgForm,
  humaniseKey,
  initialValues,
  numberHint,
  type NumberField,
  validateArgs,
} from './arg-form';

function formOf(schema: z.ZodType): ArgForm {
  const result = buildArgForm(schema);
  if (!result.ok) throw new Error(`${result.path}: ${result.reason}`);
  return result.form;
}

const none = { selectedEntityId: null };

/** One schema with every shape the palette supports. */
const Kitchen = z.strictObject({
  name: z.string().min(1).max(8).meta({ description: 'What to call it' }),
  count: z.int().min(1).max(9),
  ratio: z.number().gt(0).lt(1).optional(),
  enabled: z.boolean(),
  verbose: z.boolean().default(true),
  maybe: z.boolean().optional(),
  colour: z.enum(['red', 'green']),
  size: z.enum(['s', 'm', 'l']).default('m'),
  label: z.string().optional(),
  nested: z.strictObject({ a: z.int(), b: z.strictObject({ c: z.string() }) }),
  extra: z.strictObject({ note: z.string() }).optional(),
  offset: z.strictObject({ dx: z.int(), dy: z.int() }).default({ dx: 5, dy: -5 }),
  target: z
    .int()
    .min(1)
    .meta({ ...entityRefMeta, title: 'Target' }),
  literal: z.literal('only'),
});

describe('buildArgForm', () => {
  it('describes every supported shape', () => {
    const form = formOf(Kitchen);
    const byId = Object.fromEntries(allFields(form.fields).map((f) => [f.id, f]));
    expect(byId['name']).toMatchObject({ kind: 'string', required: true, minLength: 1, maxLength: 8 });
    expect(byId['name'].description).toBe('What to call it');
    expect(byId['count']).toMatchObject({ kind: 'number', integer: true, minimum: 1, maximum: 9, required: true });
    expect(byId['ratio']).toMatchObject({ kind: 'number', integer: false, exclusiveMinimum: 0, exclusiveMaximum: 1 });
    expect(byId['ratio'].required).toBe(false);
    expect(byId['enabled']).toMatchObject({ kind: 'boolean', required: true });
    expect(byId['verbose']).toMatchObject({ kind: 'boolean', required: false, defaultValue: true });
    // An optional boolean without a default has three states, so it becomes a choice.
    expect(byId['maybe']).toMatchObject({ kind: 'enum', options: [true, false], required: false });
    expect(byId['colour']).toMatchObject({ kind: 'enum', options: ['red', 'green'], required: true });
    expect(byId['size']).toMatchObject({ kind: 'enum', defaultValue: 'm' });
    expect(byId['nested.b.c']).toMatchObject({ kind: 'string', key: 'c' });
    expect(byId['extra']).toMatchObject({ kind: 'object', required: false });
    expect(byId['offset']).toMatchObject({ kind: 'object', defaultValue: { dx: 5, dy: -5 } });
    expect(byId['target']).toMatchObject({ kind: 'number', ref: 'entity', label: 'Target' });
    expect(byId['literal']).toMatchObject({ kind: 'enum', options: ['only'] });
    expect(form.fields.map((f) => f.key)).toEqual(Object.keys(Kitchen.shape));
  });

  it('builds an empty form for argument-less commands', () => {
    expect(formOf(z.strictObject({})).fields).toEqual([]);
  });

  it.each([
    ['an array', z.strictObject({ ids: z.array(z.int()) }), 'ids'],
    ['a union', z.strictObject({ v: z.union([z.string(), z.int()]) }), 'v'],
    ['a record', z.strictObject({ bag: z.record(z.string(), z.int()) }), 'bag'],
    ['a nullable', z.strictObject({ v: z.int().nullable() }), 'v'],
    ['an object with open keys', z.looseObject({ a: z.int() }), ''],
    ['a non-object root', z.int(), ''],
    ['a ref on a string', z.strictObject({ id: z.string().meta(entityRefMeta) }), 'id'],
    ['an unknown ref kind', z.strictObject({ id: z.int().meta({ [ARG_REF_KEYWORD]: 'wire' }) }), 'id'],
  ])('refuses %s with its path', (_name, schema, path) => {
    const result = buildArgForm(schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.path).toBe(path);
  });

  it('refuses recursive schemas instead of looping', () => {
    type Node = { next?: Node };
    const NodeSchema: z.ZodType<Node> = z
      .lazy(() => z.strictObject({ next: NodeSchema.optional() }))
      .meta({ id: 'Node' });
    const result = buildArgForm(z.strictObject({ head: NodeSchema }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/recursive/);
  });

  it('refuses schemas JSON Schema cannot represent', () => {
    expect(buildArgForm(z.strictObject({ when: z.date() })).ok).toBe(false);
  });

  it('humanises keys, with units', () => {
    expect(humaniseKey('positionMm')).toBe('Position (mm)');
    expect(humaniseKey('deltaMdeg')).toBe('Delta (millidegrees)');
    expect(humaniseKey('yaw')).toBe('Yaw');
    expect(humaniseKey('id')).toBe('ID');
    expect(humaniseKey('ref')).toBe('Catalogue item');
    expect(humaniseKey('toString')).toBe('To string'); // not a lookup-table hit
  });

  it('explains number bounds', () => {
    const hint = (schema: z.ZodType) => numberHint(formOf(z.strictObject({ n: schema })).fields[0] as NumberField);
    expect(hint(z.int().min(1).max(9))).toBe('Whole number, 1 to 9');
    expect(hint(z.int().min(1))).toBe('Whole number, at least 1');
    expect(hint(z.int().max(3))).toBe('Whole number, at most 3');
    expect(hint(z.int())).toBe('Whole number');
    expect(hint(z.number().gt(0).lt(1))).toBe('Number, more than 0, less than 1');
  });
});

describe('values and validation', () => {
  const form = formOf(Kitchen);

  it('starts from the schema defaults, including a parent object default', () => {
    const values = initialValues(form, none);
    expect(values).toMatchObject({
      name: '',
      count: '',
      enabled: false,
      verbose: true,
      maybe: '',
      colour: '',
      size: '1',
      extra: false,
      'offset.dx': '5',
      'offset.dy': '-5',
      target: '',
    });
  });

  it('offers the selected entity to entity-reference fields', () => {
    expect(initialValues(form, { selectedEntityId: 7 })['target']).toBe('7');
  });

  it('turns filled-in values into args the schema accepts', () => {
    const values = {
      ...initialValues(form, none),
      name: 'crate',
      count: '3',
      ratio: '0.5',
      enabled: true,
      maybe: '1',
      colour: '1',
      'nested.a': '-2',
      'nested.b.c': 'x',
      target: '4',
      literal: '0',
    };
    const args = argsFromValues(form, values);
    expect(args).toEqual({
      name: 'crate',
      count: 3,
      ratio: 0.5,
      enabled: true,
      verbose: true,
      maybe: false,
      colour: 'green',
      size: 'm',
      nested: { a: -2, b: { c: 'x' } },
      offset: { dx: 5, dy: -5 },
      target: 4,
      literal: 'only',
    });
    expect(validateArgs(Kitchen, form, args)).toEqual({ ok: true, args: Kitchen.parse(args) });
  });

  it('includes an optional object only when asked', () => {
    const values = { ...initialValues(form, none), 'extra.note': 'hi' };
    expect(argsFromValues(form, values)['extra']).toBeUndefined();
    expect(argsFromValues(form, { ...values, extra: true })['extra']).toEqual({ note: 'hi' });
  });

  it('reports Zod issues inline on the field they belong to', () => {
    const values = {
      ...initialValues(form, none),
      name: 'much too long',
      count: '12',
      ratio: 'abc',
      'nested.a': '1.5',
    };
    const result = validateArgs(Kitchen, form, argsFromValues(form, values));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const { fields } = result.errors;
    expect(fields['name']?.[0]).toMatch(/8/);
    expect(fields['count']?.[0]).toMatch(/9/);
    expect(fields['ratio']?.[0]).toMatch(/number/);
    expect(fields['nested.a']?.[0]).toMatch(/int/i);
    expect(fields['colour']).toEqual(['Required']);
    expect(fields['target']).toEqual(['Required']);
    expect(fields['nested.b.c']).toBeUndefined(); // '' is a valid string
    expect(result.errors.form).toEqual([]);
  });

  it('keeps issues no field owns at form level', () => {
    const Refined = z
      .strictObject({ a: z.int(), b: z.int() })
      .refine((v) => v.a < v.b, { message: 'a must be less than b' });
    const refinedForm = formOf(Refined);
    const result = validateArgs(Refined, refinedForm, { a: 2, b: 1 });
    expect(!result.ok && result.errors).toEqual({ fields: {}, form: ['a must be less than b'] });
  });
});

describe('every registered command', () => {
  // The palette must be able to run any command a player or a script can. A command whose args
  // the form can't express fails here, at registration time, not in front of a player.
  const commands = createWorldRegistry().registerAll(fileCommands()).list(); // plus the game host's file.* (F1.8b)

  it.each(commands.map((c) => [c.id, c] as const))('%s has a palette form', (_id, command) => {
    const result = buildArgForm(command.args);
    expect(result.ok ? 'ok' : `${result.path}: ${result.reason}`).toBe('ok');
  });

  it('marks entity ids as entity references', () => {
    const ids = createWorldRegistry()
      .list()
      .flatMap((c) => {
        const result = buildArgForm(c.args);
        return result.ok ? allFields(result.form.fields).map((f) => [c.id, f] as const) : [];
      })
      .filter(([, f]) => f.kind === 'number' && f.ref === 'entity')
      .map(([id, f]) => `${id}:${f.id}`);
    expect(ids).toEqual(['entity.delete:id', 'entity.move:id', 'entity.rotate:id']);
  });

  it('entity.place fills its default orientation', () => {
    const place = createWorldRegistry().get('entity.place');
    if (!place) throw new Error('entity.place missing');
    const placeForm = formOf(place.args);
    expect(initialValues(placeForm, none)).toMatchObject({
      'orientationMdeg.yaw': '0',
      'orientationMdeg.pitch': '0',
      'orientationMdeg.roll': '0',
    });
  });
});
