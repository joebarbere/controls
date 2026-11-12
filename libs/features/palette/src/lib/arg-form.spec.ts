import { ARG_REF_KEYWORD, cableRefMeta, connectionRefMeta, entityRefMeta, fileCommands } from '@controls/commands';
import { createWorldRegistry } from '@controls/world-model';
import * as z from 'zod';
import {
  addListItem,
  allFields,
  type ArgForm,
  type ArgFormContext,
  argsFromValues,
  buildArgForm,
  canAddItem,
  canRemoveItem,
  type ChoiceField,
  humaniseKey,
  initialValues,
  listHint,
  listItem,
  type ListField,
  moveListItem,
  numberHint,
  type NumberField,
  removeListItem,
  scalarHint,
  type ScalarField,
  scalarValue,
  validateArgs,
  visibleFields,
} from './arg-form';

function formOf(schema: z.ZodType): ArgForm {
  const result = buildArgForm(schema);
  if (!result.ok) throw new Error(`${result.path}: ${result.reason}`);
  return result.form;
}

const none: ArgFormContext = { selectedEntityId: null };

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
    [
      'a union of text and an object',
      z.strictObject({ v: z.union([z.string(), z.strictObject({ a: z.int() })]) }),
      'v',
    ],
    [
      'a union with two objects',
      z.strictObject({ v: z.union([z.strictObject({ a: z.int() }), z.strictObject({ b: z.int() })]) }),
      'v',
    ],
    ['a tuple', z.strictObject({ t: z.tuple([z.int(), z.string()]) }), 't'],
    ['a list of records', z.strictObject({ l: z.array(z.record(z.string(), z.int())) }), 'l.#'],
    ['a record', z.strictObject({ bag: z.record(z.string(), z.int()) }), 'bag'],
    ['a ref on a choice', z.strictObject({ v: z.union([z.literal('a'), z.literal(1)]).meta(entityRefMeta) }), 'v'],
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

describe('scalar unions (a boolean, a number or text in one field)', () => {
  const Operate = z.strictObject({ value: z.union([z.boolean(), z.number(), z.string().min(1).max(32)]) });

  it('build one text field typed like a console word', () => {
    const [field] = formOf(Operate).fields as ScalarField[];
    expect(field).toMatchObject({ kind: 'scalar', types: ['boolean', 'number', 'string'], required: true });
    expect(initialValues(formOf(Operate), none)).toStrictEqual({ value: '' });
    const typed = (text: string) => argsFromValues(formOf(Operate), { value: text });
    expect(typed('true')).toStrictEqual({ value: true });
    expect(typed(' false ')).toStrictEqual({ value: false });
    expect(typed('12.5')).toStrictEqual({ value: 12.5 });
    expect(typed('on')).toStrictEqual({ value: 'on' });
    expect(typed('')).toStrictEqual({});
    expect(validateArgs(Operate, formOf(Operate), typed(''))).toMatchObject({
      ok: false,
      errors: { fields: { value: ['Required'] } },
    });
  });

  it('also reads a bare type list (Zod writes a union of unconstrained scalars that way)', () => {
    const [field] = formOf(z.strictObject({ v: z.union([z.boolean(), z.string()]) })).fields as ScalarField[];
    expect(field).toMatchObject({ kind: 'scalar', types: ['boolean', 'string'] });
  });

  it('only types a word as a type the union has, and keeps a default', () => {
    const textOrNumber = formOf(z.strictObject({ v: z.union([z.int(), z.string()]).default(3) }));
    const [field] = textOrNumber.fields as ScalarField[];
    expect(field.types).toStrictEqual(['number', 'string']);
    expect(initialValues(textOrNumber, none)).toStrictEqual({ v: '3' });
    expect(scalarValue(field, 'true')).toBe('true');
    expect(scalarValue(field, '07')).toBe('07'); // not the JSON-number grammar
    expect(scalarHint(field)).toBe('a number, or text');
    expect(scalarHint({ ...field, types: ['boolean'] })).toBe('true or false');
    const [three] = formOf(Operate).fields as ScalarField[];
    expect(scalarHint(three)).toBe('true or false, a number, or text');
  });
});

/** ADR 0015 shapes, with test-only schemas (the wire commands land later). */
const Int = z.int();
const Termination = z
  .strictObject({ method: z.string().min(1), torqueNm: z.number().nullable() })
  .meta({ title: 'Termination' });
const Waypoint = z
  .strictObject({
    kind: z.enum(['free', 'duct']),
    positionMm: z.strictObject({ x: Int, y: Int, z: Int }),
    entity: Int.min(1).nullable().meta(entityRefMeta),
  })
  .meta({ title: 'Waypoint' });
const Wire = z.strictObject({
  a: z
    .strictObject({ entity: Int.min(1).meta(entityRefMeta), termination: z.union([z.literal('auto'), Termination]) })
    .nullable(),
  mountedOn: z.strictObject({ entity: Int, mount: z.string() }).nullable().default(null),
  route: z.array(Waypoint).min(1).max(3),
  tags: z.array(z.string().min(1)).max(2).optional(),
  label: z.string().min(1).nullable(),
  note: z.string().nullable().default('hi'),
  lengthMm: Int.min(1).nullable().optional(),
  wire: Int.min(1).meta(connectionRefMeta),
  cable: Int.min(1).meta(cableRefMeta),
  lit: z.boolean().nullable(),
});

describe('choice, nullable and list fields (ADR 0015)', () => {
  const form = formOf(Wire);
  const byId = (values: Record<string, unknown> = initialValues(form, none)) =>
    Object.fromEntries(visibleFields(form.fields, values as never).map((f) => [f.id, f]));

  it('builds a choice for a nullable object and an object-or-literal union', () => {
    const fields = byId();
    const a = fields['a'] as ChoiceField;
    expect(a).toMatchObject({ kind: 'choice', required: true });
    expect(a.options).toEqual([
      { kind: 'object', label: 'Specify' },
      { kind: 'value', value: null, label: 'None' },
    ]);
    expect(a.object?.fields.map((f) => f.id)).toEqual(['a.entity', 'a.termination']);
    const termination = a.object?.fields[1] as ChoiceField;
    expect(termination.options).toEqual([
      { kind: 'value', value: 'auto', label: 'auto' },
      { kind: 'object', label: 'Termination' },
    ]);
    expect(termination.object?.fields.map((f) => f.id)).toEqual(['a.termination.method', 'a.termination.torqueNm']);
    expect(fields['mountedOn']).toMatchObject({ kind: 'choice', defaultValue: null, required: false });
    expect(fields['lit']).toMatchObject({
      kind: 'choice',
      options: [
        { kind: 'value', value: true, label: 'Yes' },
        { kind: 'value', value: false, label: 'No' },
        { kind: 'value', value: null, label: 'None' },
      ],
    });
  });

  it('builds nullable scalars, keeping the wrapper hints and references', () => {
    const fields = byId();
    expect(fields['label']).toMatchObject({ kind: 'string', nullable: true, minLength: 1, required: true });
    expect(fields['note']).toMatchObject({ kind: 'string', nullable: true, defaultValue: 'hi' });
    expect(fields['lengthMm']).toMatchObject({ kind: 'number', nullable: true, minimum: 1, required: false });
    expect(fields['route.0.entity']).toMatchObject({ kind: 'number', nullable: true, ref: 'entity' });
    expect(fields['wire']).toMatchObject({ kind: 'number', ref: 'connection', nullable: false });
    expect(fields['cable']).toMatchObject({ kind: 'number', ref: 'cable' });
    const hinted = formOf(
      z.strictObject({ n: Int.nullable().meta({ ...entityRefMeta, title: 'Host', description: 'Where' }) }),
    ).fields[0];
    expect(hinted).toMatchObject({
      kind: 'number',
      ref: 'entity',
      nullable: true,
      label: 'Host',
      description: 'Where',
    });
  });

  it('builds lists with bounds, an item label and indexed item ids', () => {
    const route = form.fields.find((f) => f.id === 'route') as ListField;
    expect(route).toMatchObject({ kind: 'list', minItems: 1, maxItems: 3, itemLabel: 'Waypoint' });
    expect(listHint(route)).toBe('1 to 3 waypoints');
    const tags = form.fields.find((f) => f.id === 'tags') as ListField;
    expect(listHint(tags)).toBe('At most 2 items');
    expect(listItem(tags, 1)).toMatchObject({ id: 'tags.1', key: '1', label: 'Item 2', kind: 'string' });
    const second = listItem(route, 2);
    expect(second).toMatchObject({ id: 'route.2', label: 'Waypoint', kind: 'object' });
    expect(allFields([second]).map((f) => f.id)).toEqual([
      'route.2',
      'route.2.kind',
      'route.2.positionMm',
      'route.2.positionMm.x',
      'route.2.positionMm.y',
      'route.2.positionMm.z',
      'route.2.entity',
    ]);
    expect(listItem(route, 2)).toBe(second); // cached, so templates keep their views
  });

  it('starts lists at minItems (or the default) and choices unchosen (or at the default)', () => {
    const values = initialValues(form, { selectedEntityId: 7, selectedConnectionId: 4 });
    expect(values).toMatchObject({
      a: '',
      'a.entity': '7', // prefilled from the selection, used if the object is chosen
      'a.termination': '',
      mountedOn: '1', // the default, null
      route: 1,
      'route.0.kind': '',
      'route.0.entity': '', // a nullable reference is never prefilled: blank means null
      tags: 0,
      label: '',
      note: 'hi',
      wire: '4',
      cable: '', // no cable selected (the key may not be published yet)
    });
    const listed = formOf(z.strictObject({ ids: z.array(Int).default([3, 4]) }));
    expect(initialValues(listed, none)).toEqual({ ids: 2, 'ids.0': '3', 'ids.1': '4' });
    const chosen = formOf(
      z.strictObject({ t: z.union([z.literal('auto'), Termination]).default({ method: 'screw', torqueNm: 1 }) }),
    );
    expect(initialValues(chosen, none)).toEqual({ t: '1', 't.method': 'screw', 't.torqueNm': '1' });
  });

  it('turns choices, nullable blanks and list items into args', () => {
    const values = {
      ...initialValues(form, none),
      a: '0',
      'a.entity': '3',
      'a.termination': '1',
      'a.termination.method': 'screw',
      route: 2,
      'route.0.kind': '0',
      'route.0.positionMm.x': '1',
      'route.0.positionMm.y': '2',
      'route.0.positionMm.z': '3',
      'route.1.kind': '1',
      'route.1.positionMm.x': '4',
      'route.1.positionMm.y': '5',
      'route.1.positionMm.z': '6',
      'route.1.entity': '9',
      wire: '2',
      cable: '5',
      lit: '1',
    };
    const args = argsFromValues(form, values);
    expect(args).toEqual({
      a: { entity: 3, termination: { method: 'screw', torqueNm: null } },
      mountedOn: null,
      route: [
        { kind: 'free', positionMm: { x: 1, y: 2, z: 3 }, entity: null },
        { kind: 'duct', positionMm: { x: 4, y: 5, z: 6 }, entity: 9 },
      ],
      label: null, // blank, no default: null
      note: 'hi',
      lengthMm: null, // optional and nullable, no default: blank is null too
      wire: 2,
      cable: 5,
      lit: false,
    });
    expect(argsFromValues(form, { ...values, note: '' })).not.toHaveProperty('note'); // blank with a default: left out
    expect(validateArgs(Wire, form, args, values)).toMatchObject({ ok: true });
    expect(argsFromValues(form, { ...values, a: '1', 'a.termination': '0' })['a']).toBeNull();
    expect(argsFromValues(form, { ...values, 'a.termination': '0' })['a']).toEqual({ entity: 3, termination: 'auto' });
    expect(argsFromValues(form, { ...values, tags: 1, 'tags.0': 'x' })['tags']).toEqual(['x']);
  });

  it('maps Zod issues onto list items and chosen objects by their indexed ids', () => {
    const values = {
      ...initialValues(form, none),
      a: '0',
      'a.entity': '0',
      'a.termination': '1',
      route: 2,
      'route.0.kind': '0',
      'route.0.positionMm.x': '1',
      'route.0.positionMm.y': '2',
      'route.0.positionMm.z': '3',
      'route.1.kind': '0',
      'route.1.positionMm.x': '1.5',
      'route.1.positionMm.y': '0',
      'route.1.positionMm.z': '0',
      tags: 1,
      wire: '1',
      cable: '1',
      lit: '2',
    };
    const result = validateArgs(Wire, form, argsFromValues(form, values), values);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.fields['route.1.positionMm.x']?.[0]).toMatch(/int/i);
    expect(result.errors.fields['a.entity']?.[0]).toMatch(/>=1|1/);
    expect(result.errors.fields['a.termination.method']?.[0]).toMatch(/>=1 characters/);
    expect(result.errors.fields['tags.0']?.[0]).toMatch(/>=1 characters/);
    // Without the values, the same issues fall back to the list and the choice.
    const coarse = validateArgs(Wire, form, argsFromValues(form, values));
    expect(!coarse.ok && Object.keys(coarse.errors.fields).sort()).toEqual(['a', 'route', 'tags']);
  });

  it('adds, removes and moves list items, carrying every nested value', () => {
    const route = form.fields.find((f) => f.id === 'route') as ListField;
    let values: Record<string, unknown> = initialValues(form, none);
    values = addListItem(route, values as never, none);
    values = addListItem(route, values as never, none);
    expect(values['route']).toBe(3);
    expect(canAddItem(route, values as never)).toBe(false);
    values = { ...values, 'route.0.positionMm.x': 'a', 'route.1.positionMm.x': 'b', 'route.2.positionMm.x': 'c' };
    const x = (v: Record<string, unknown>) => [0, 1, 2].map((i) => v[`route.${i}.positionMm.x`]);
    const moved = moveListItem(route, values as never, 2, 0);
    expect(x(moved)).toEqual(['c', 'a', 'b']);
    const removed = removeListItem(route, moved, 1);
    expect(removed['route']).toBe(2);
    expect(x(removed)).toEqual(['c', 'b', undefined]);
    expect(Object.keys(removed).filter((k) => k.startsWith('route.2'))).toEqual([]);
    const one = removeListItem(route, removed, 0);
    expect(canRemoveItem(route, one)).toBe(false); // minItems 1
    expect(canRemoveItem(route, removed)).toBe(true);
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
    expect(ids).toEqual([
      'device.operate:id',
      'entity.delete:id',
      'entity.move:id',
      'entity.rotate:id',
      'lead.connect:a.entity',
      'lead.connect:b.entity',
    ]);
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
