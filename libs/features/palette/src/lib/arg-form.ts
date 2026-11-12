import { ARG_REF_KEYWORD, ARG_REF_KINDS, type ArgRefKind } from '@controls/commands';
import * as z from 'zod';

/*
 * Palette argument forms, generated from a command's Zod `args` (plan F1.3). The schema goes through
 * `z.toJSONSchema` (input side, so defaulted and optional keys are not required) and the resulting
 * JSON Schema is turned into a small field model. `.meta()` hints add labels (`title`), help text
 * (`description`) and reference kinds (`x-controls-ref`, see `@controls/commands` arg hints).
 *
 * The form only shapes and types what the player typed; validation is the command's own schema
 * (`validateArgs`), the same one `exec`, the console and scripts use. Shapes the form can't express
 * (records, recursion, tuples, unions other than the ones below) make `buildArgForm` fail, and a
 * spec builds a form for every registered command, so a new command can't silently break the
 * palette. The shapes it can express:
 *
 * - objects, strings, numbers, booleans, enums and consts;
 * - a union of JSON scalar types (`device.operate`'s `value`): a text field typed like a console word;
 * - a nullable scalar (`z.string().nullable()`): a text field where blank is `null` (ADR 0015);
 * - a choice (ADR 0015): an `anyOf` of `null`, const or enum scalars and at most one object, such as
 *   a nullable object or `'auto' | TerminationArgs`. A radio group; the object's fields show when chosen;
 * - a list (`z.array`) of any of these, with `minItems` and `maxItems`. Item field ids carry the
 *   index (`route.3.positionMm.x`), so Zod issue paths map onto them.
 */

interface FieldBase {
  /** Key in the parent object (the index as text for a list item). */
  readonly key: string;
  /** Dotted path from the args root (`positionMm.x`, `route.3.kind`): the field's id in values and errors. */
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  /** Must be given: no `.optional()` and no `.default()`. */
  readonly required: boolean;
  /** The schema's default (input side), if it has one. */
  readonly defaultValue: unknown;
}

export interface StringField extends FieldBase {
  readonly kind: 'string';
  readonly minLength: number | null;
  readonly maxLength: number | null;
  /** Accepts `null`: a blank field is `null` when the key has no default (else it is left out). */
  readonly nullable: boolean;
}

export interface NumberField extends FieldBase {
  readonly kind: 'number';
  readonly integer: boolean;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly exclusiveMinimum: number | null;
  readonly exclusiveMaximum: number | null;
  /** What the number refers to (an entity, connection or cable id), so the form offers the selection. */
  readonly ref: ArgRefKind | null;
  /** Accepts `null`: a blank field is `null` when the key has no default (else it is left out). */
  readonly nullable: boolean;
}

export interface BooleanField extends FieldBase {
  readonly kind: 'boolean';
}

/** A JSON primitive an enum option can be. */
export type EnumOption = string | number | boolean | null;

export interface EnumField extends FieldBase {
  readonly kind: 'enum';
  readonly options: readonly EnumOption[];
}

/** A JSON scalar type a scalar field accepts. */
export type ScalarType = 'boolean' | 'number' | 'string';

/**
 * A field whose schema is a union of JSON scalar types (`z.union([z.boolean(), z.number(), z.string()])`):
 * one text field, typed like a console word (`true`/`false` → boolean, a JSON number → number, else text).
 */
export interface ScalarField extends FieldBase {
  readonly kind: 'scalar';
  /** The types the union accepts, in schema order. */
  readonly types: readonly ScalarType[];
  /** Accepts `null` too: blank is `null` when the key has no default. */
  readonly nullable: boolean;
}

export interface ObjectField extends FieldBase {
  readonly kind: 'object';
  readonly fields: readonly ArgField[];
}

/** One option of a {@link ChoiceField}: a scalar value (`null`, `'auto'`) or the union's object. */
export type ChoiceOption =
  | { readonly kind: 'value'; readonly value: EnumOption; readonly label: string }
  | { readonly kind: 'object'; readonly label: string };

/**
 * A union of `null`, const/enum scalars and at most one object (a nullable object, `'auto' | {…}`):
 * a radio group. The object's fields (ids under this field's id, as for an object) apply only while
 * the object option is chosen.
 */
export interface ChoiceField extends FieldBase {
  readonly kind: 'choice';
  readonly options: readonly ChoiceOption[];
  /** The object member, or `null` if the union has none. Its `id` is this field's id. */
  readonly object: ObjectField | null;
}

/**
 * An array (`z.array(item)`): a list of item fieldsets the player can add to, remove from and
 * reorder. `item` is a template whose id is `<list id>.#`; {@link listItem} makes the field for an
 * index. The item count is the value at the list's id.
 */
export interface ListField extends FieldBase {
  readonly kind: 'list';
  readonly item: ArgField;
  /** What one item is called ("Waypoint"): the items' `title`, else "Item". */
  readonly itemLabel: string;
  readonly minItems: number;
  readonly maxItems: number | null;
}

export type ArgField =
  StringField | NumberField | BooleanField | EnumField | ScalarField | ObjectField | ChoiceField | ListField;

/** A command's argument form: the fields of its args object (empty for argument-less commands). */
export interface ArgForm {
  readonly fields: readonly ArgField[];
}

export type ArgFormResult =
  | { readonly ok: true; readonly form: ArgForm }
  | { readonly ok: false; readonly path: string; readonly reason: string };

type JsonSchema = Readonly<Record<string, unknown>>;

class Unsupported extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(reason);
  }
}

/** The id segment standing for "any index" in a list's item template. */
const ITEM = '#';

const UNITS: Readonly<Record<string, string>> = { Mm: 'mm', Mdeg: 'millidegrees', Nm: 'N·m' };
const WORDS: Readonly<Record<string, string>> = { id: 'ID', ref: 'Catalogue item' };

/** `positionMm` → `Position (mm)`, `deltaMdeg` → `Delta (millidegrees)`, `id` → `ID`. */
export function humaniseKey(key: string): string {
  if (Object.prototype.hasOwnProperty.call(WORDS, key)) return WORDS[key];
  const words = key.split(/(?=[A-Z])/);
  const unit = words.length > 1 ? UNITS[words[words.length - 1]] : undefined;
  const base = (unit ? words.slice(0, -1) : words).join(' ').toLowerCase();
  const text = base.charAt(0).toUpperCase() + base.slice(1);
  return unit ? `${text} (${unit})` : text;
}

const isObject = (v: unknown): v is JsonSchema => typeof v === 'object' && v !== null && !Array.isArray(v);
const numberOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const isPrimitive = (v: unknown): v is EnumOption =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const isRefKind = (v: unknown): v is ArgRefKind => (ARG_REF_KINDS as readonly unknown[]).includes(v);

/** Builds the form for an args schema. Fails (never throws) with the path of a shape it can't express. */
export function buildArgForm(schema: z.ZodType): ArgFormResult {
  let root: JsonSchema;
  try {
    root = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'throw' }) as JsonSchema;
  } catch (error) {
    return { ok: false, path: '', reason: `not representable as JSON Schema: ${(error as Error).message}` };
  }
  const defs = isObject(root['$defs']) ? root['$defs'] : {};
  try {
    const node = resolve(root, defs, '', []);
    if (node.schema['type'] !== 'object') throw new Unsupported('', 'args must be an object');
    return { ok: true, form: { fields: objectFields(node.schema, defs, '', node.refs) } };
  } catch (error) {
    if (error instanceof Unsupported) return { ok: false, path: error.path, reason: error.message };
    throw error;
  }
}

/** Follows a local `$ref` (keeping sibling keywords such as `default`), refusing recursion. */
function resolve(
  schema: JsonSchema,
  defs: JsonSchema,
  path: string,
  refs: readonly string[],
): { schema: JsonSchema; refs: readonly string[] } {
  const ref = schema['$ref'];
  if (ref === undefined) return { schema, refs };
  const prefix = '#/$defs/';
  if (typeof ref !== 'string' || !ref.startsWith(prefix))
    throw new Unsupported(path, `unsupported $ref ${String(ref)}`);
  const name = ref.slice(prefix.length);
  if (refs.includes(name)) throw new Unsupported(path, `recursive schema ${name}`);
  const target = defs[name];
  if (!isObject(target)) throw new Unsupported(path, `missing $defs/${name}`);
  const siblings = Object.fromEntries(Object.entries(schema).filter(([k]) => k !== '$ref'));
  return resolve({ ...target, ...siblings }, defs, path, [...refs, name]);
}

function objectFields(schema: JsonSchema, defs: JsonSchema, path: string, refs: readonly string[]): ArgField[] {
  const extra = schema['additionalProperties'];
  if (extra !== undefined && extra !== false)
    throw new Unsupported(path, 'records (open-ended keys) are not supported');
  for (const keyword of ['patternProperties', 'anyOf', 'oneOf', 'allOf']) {
    if (schema[keyword] !== undefined) throw new Unsupported(path, `${keyword} is not supported`);
  }
  const properties = isObject(schema['properties']) ? schema['properties'] : {};
  const required = new Set(Array.isArray(schema['required']) ? (schema['required'] as string[]) : []);
  return Object.entries(properties).map(([key, child]) => {
    const id = path === '' ? key : `${path}.${key}`;
    if (!isObject(child)) throw new Unsupported(id, 'not a schema');
    return field(key, id, child, required.has(key), defs, refs);
  });
}

/** Keywords describing a field (not its type), copied from a nullable wrapper onto its scalar member. */
const OUTER_KEYWORDS = ['title', 'description', 'default', ARG_REF_KEYWORD];

function field(
  key: string,
  id: string,
  raw: JsonSchema,
  required: boolean,
  defs: JsonSchema,
  outerRefs: readonly string[],
  nullable = false,
): ArgField {
  const { schema, refs } = resolve(raw, defs, id, outerRefs);
  const base: FieldBase = {
    key,
    id,
    label: typeof schema['title'] === 'string' ? schema['title'] : humaniseKey(key),
    description: typeof schema['description'] === 'string' ? schema['description'] : null,
    required,
    defaultValue: schema['default'],
  };
  const ref = schema[ARG_REF_KEYWORD];
  if (ref !== undefined && !isRefKind(ref)) throw new Unsupported(id, `unknown ${ARG_REF_KEYWORD} ${String(ref)}`);

  const union = unionMembers(schema, id);
  if (union !== null) {
    const nonNull = union.filter((m) => !isNullSchema(m));
    const hasNull = nonNull.length < union.length;
    const types = scalarUnion(nonNull);
    if (types !== null && nonNull.length > 1) return { ...base, kind: 'scalar', types, nullable: hasNull };
    // A nullable scalar (`z.int().nullable()`, `z.string().nullable()`): the member, with the wrapper's hints.
    if (hasNull && nonNull.length === 1 && isPlainScalar(nonNull[0])) {
      const outer = Object.fromEntries(OUTER_KEYWORDS.filter((k) => k in schema).map((k) => [k, schema[k]]));
      return field(key, id, { ...nonNull[0], ...outer }, required, defs, refs, true);
    }
    if (ref !== undefined) throw new Unsupported(id, 'references must be integers');
    return choiceField(base, union, defs, refs);
  }
  if (ref !== undefined && schema['type'] !== 'integer') throw new Unsupported(id, 'references must be integers');
  for (const keyword of ['oneOf', 'allOf', 'not']) {
    if (schema[keyword] !== undefined) throw new Unsupported(id, `${keyword} is not supported`);
  }
  if (Array.isArray(schema['enum']) || 'const' in schema) {
    const options = Array.isArray(schema['enum']) ? schema['enum'] : [schema['const']];
    if (options.length === 0 || !options.every(isPrimitive))
      throw new Unsupported(id, 'enum options must be JSON scalars');
    return { ...base, kind: 'enum', options: options as EnumOption[] };
  }
  switch (schema['type']) {
    case 'string':
      return {
        ...base,
        kind: 'string',
        minLength: numberOrNull(schema['minLength']),
        maxLength: numberOrNull(schema['maxLength']),
        nullable,
      };
    case 'integer':
    case 'number':
      return {
        ...base,
        kind: 'number',
        integer: schema['type'] === 'integer',
        minimum: numberOrNull(schema['minimum']),
        maximum: numberOrNull(schema['maximum']),
        exclusiveMinimum: numberOrNull(schema['exclusiveMinimum']),
        exclusiveMaximum: numberOrNull(schema['exclusiveMaximum']),
        ref: isRefKind(ref) ? ref : null,
        nullable,
      };
    case 'boolean':
      // An optional boolean without a default has three states (unset, true, false): offer a choice.
      return required || base.defaultValue !== undefined
        ? { ...base, kind: 'boolean' }
        : { ...base, kind: 'enum', options: [true, false] };
    case 'object':
      return { ...base, kind: 'object', fields: objectFields(schema, defs, id, refs) };
    case 'array':
      return listField(base, schema, defs, refs);
    default:
      throw new Unsupported(id, `type ${JSON.stringify(schema['type'] ?? null)} is not supported`);
  }
}

/** The members of an `anyOf`, or of a `type` list (how Zod writes a union of bare types), else `null`. */
function unionMembers(schema: JsonSchema, id: string): JsonSchema[] | null {
  const anyOf = schema['anyOf'];
  if (Array.isArray(anyOf)) {
    if (!anyOf.every(isObject)) throw new Unsupported(id, 'anyOf members must be schemas');
    return anyOf;
  }
  const type = schema['type'];
  if (!Array.isArray(type)) return null;
  // `{ type: ['string', 'null'], maxLength: 3 }`: the other keywords belong to the non-null type.
  const rest = Object.fromEntries(Object.entries(schema).filter(([k]) => k !== 'type' && !OUTER_KEYWORDS.includes(k)));
  return type.map((t: unknown) => (t === 'null' ? { type: 'null' } : { ...rest, type: t }));
}

/** Keywords a scalar union member may carry besides `type` (bounds and hints, never structure). */
const SCALAR_KEYWORDS = new Set([
  'type',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'title',
  'description',
]);

/**
 * The scalar types of union members that are each a plain `boolean`, `number`, `integer` or
 * `string` schema (no enum, const, object or nested union), or `null` if they aren't.
 */
function scalarUnion(members: readonly JsonSchema[]): ScalarType[] | null {
  if (members.length === 0) return null;
  const types: ScalarType[] = [];
  for (const member of members) {
    if (!Object.keys(member).every((k) => SCALAR_KEYWORDS.has(k))) return null;
    const type = member['type'] === 'integer' ? 'number' : member['type'];
    if (type !== 'boolean' && type !== 'number' && type !== 'string') return null;
    if (!types.includes(type)) types.push(type);
  }
  return types;
}

const isNullSchema = (s: JsonSchema): boolean => s['type'] === 'null' || ('const' in s && s['const'] === null);

/** A plain `string`/`number`/`integer` schema (bounds and hints allowed, no enum or const). */
function isPlainScalar(s: JsonSchema): boolean {
  return (
    (s['type'] === 'string' || s['type'] === 'number' || s['type'] === 'integer') &&
    !('const' in s) &&
    s['enum'] === undefined
  );
}

function choiceField(
  base: FieldBase,
  members: readonly JsonSchema[],
  defs: JsonSchema,
  refs: readonly string[],
): ChoiceField {
  const options: ChoiceOption[] = [];
  let object: ObjectField | null = null;
  const addValue = (value: unknown) => {
    if (!isPrimitive(value)) throw new Unsupported(base.id, 'choice values must be JSON scalars');
    if (options.some((o) => o.kind === 'value' && o.value === value)) return;
    options.push({ kind: 'value', value, label: valueLabel(value) });
  };
  for (const raw of members) {
    const member = resolve(raw, defs, base.id, refs).schema;
    if (isNullSchema(member)) addValue(null);
    else if ('const' in member) addValue(member['const']);
    else if (Array.isArray(member['enum'])) member['enum'].forEach(addValue);
    else if (member['type'] === 'boolean') [true, false].forEach(addValue);
    else if (member['type'] === 'object') {
      if (object !== null) throw new Unsupported(base.id, 'a union may have at most one object member');
      object = {
        ...base,
        kind: 'object',
        label: typeof member['title'] === 'string' ? member['title'] : base.label,
        fields: objectFields(member, defs, base.id, resolve(raw, defs, base.id, refs).refs),
      };
      options.push({ kind: 'object', label: typeof member['title'] === 'string' ? member['title'] : 'Specify' });
    } else {
      throw new Unsupported(base.id, 'unions other than null, constants and one object are not supported');
    }
  }
  if (options.length < 2) throw new Unsupported(base.id, 'a choice needs at least two options');
  return { ...base, kind: 'choice', options, object };
}

function valueLabel(value: EnumOption): string {
  if (value === null) return 'None';
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return String(value);
}

function listField(base: FieldBase, schema: JsonSchema, defs: JsonSchema, refs: readonly string[]): ListField {
  const items = schema['items'];
  if (!isObject(items)) throw new Unsupported(base.id, 'arrays need one item schema (tuples are not supported)');
  if (schema['prefixItems'] !== undefined) throw new Unsupported(base.id, 'tuples are not supported');
  if (schema['uniqueItems'] === true) throw new Unsupported(base.id, 'uniqueItems is not supported');
  const resolved = resolve(items, defs, base.id, refs).schema;
  const itemLabel = typeof resolved['title'] === 'string' ? resolved['title'] : 'Item';
  const item = field(ITEM, `${base.id}.${ITEM}`, items, true, defs, refs);
  const minItems = numberOrNull(schema['minItems']) ?? 0;
  return {
    ...base,
    kind: 'list',
    item: { ...item, label: itemLabel },
    itemLabel,
    minItems,
    maxItems: numberOrNull(schema['maxItems']),
  };
}

/** Re-bases a field's id (and its descendants') from prefix `from` to `to`. */
function rebase(f: ArgField, from: string, to: string): ArgField {
  const id = to + f.id.slice(from.length);
  switch (f.kind) {
    case 'object':
      return { ...f, id, fields: f.fields.map((c) => rebase(c, from, to)) };
    case 'choice':
      return { ...f, id, object: f.object ? (rebase(f.object, from, to) as ObjectField) : null };
    case 'list':
      return { ...f, id, item: rebase(f.item, from, to) };
    default:
      return { ...f, id };
  }
}

const itemCache = new WeakMap<ListField, ArgField[]>();

/** The field for item `index` of `list` (ids like `route.3.positionMm.x`). Cached per list field. */
export function listItem(list: ListField, index: number): ArgField {
  let items = itemCache.get(list);
  if (!items) itemCache.set(list, (items = []));
  const cached = items[index];
  if (cached) return cached;
  const rebased = rebase(list.item, list.item.id, `${list.id}.${index}`);
  // A scalar item is labelled with its number ("Tag 2"); an object item's fieldset legend says it.
  const label = rebased.kind === 'object' ? rebased.label : `${list.itemLabel} ${index + 1}`;
  const made = { ...rebased, key: String(index), label };
  items[index] = made;
  return made;
}

/**
 * Every field in the form with a fixed id, depth first (objects before their children). A choice's
 * object fields and a list's items depend on the values: see {@link visibleFields}.
 */
export function allFields(fields: readonly ArgField[]): ArgField[] {
  return fields.flatMap((f) => (f.kind === 'object' ? [f, ...allFields(f.fields)] : [f]));
}

/**
 * The value at each field id: text for strings, numbers and scalars, `true`/`false` for booleans
 * and for whether an optional object (no default) is included, the option index as text for enums
 * and choices (`''` = not chosen), and the item count (a number) for a list.
 */
export type ArgValue = string | boolean | number;
export type ArgValues = Readonly<Record<string, ArgValue>>;

/** The current selection, offered to reference fields. Missing keys mean nothing of that kind is selected. */
export interface ArgFormContext {
  readonly selectedEntityId: number | null;
  readonly selectedConnectionId?: number | null;
  readonly selectedCableId?: number | null;
}

function selected(context: ArgFormContext, kind: ArgRefKind): number | null {
  const id =
    kind === 'entity'
      ? context.selectedEntityId
      : kind === 'connection'
        ? context.selectedConnectionId
        : context.selectedCableId;
  return typeof id === 'number' ? id : null;
}

/** Whether an object field is included only when the player asks for it (optional, no default). */
export const isOptionalObject = (f: ObjectField): boolean => !f.required && f.defaultValue === undefined;

/** The chosen option of a choice field, if any. */
export function chosenOption(f: ChoiceField, values: ArgValues): ChoiceOption | null {
  const raw = values[f.id];
  return typeof raw === 'string' && raw !== '' ? (f.options[Number(raw)] ?? null) : null;
}

/** A list's item count in `values`. */
export function itemCount(f: ListField, values: ArgValues): number {
  const raw = values[f.id];
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

/** Writes `f`'s initial values (from `value`, else defaults, else the selection for references) into `out`. */
function fill(f: ArgField, value: unknown, context: ArgFormContext, out: Record<string, ArgValue>): void {
  switch (f.kind) {
    case 'object':
      if (isOptionalObject(f)) out[f.id] = false;
      for (const child of f.fields) fill(child, childValue(child, value), context, out);
      return;
    case 'boolean':
      out[f.id] = value === true;
      return;
    case 'enum': {
      const index = value === undefined ? -1 : f.options.indexOf(value as EnumOption);
      out[f.id] = index < 0 ? '' : String(index);
      return;
    }
    case 'choice': {
      const index =
        value === undefined
          ? -1
          : isObjectValue(value)
            ? f.options.findIndex((o) => o.kind === 'object')
            : f.options.findIndex((o) => o.kind === 'value' && o.value === value);
      out[f.id] = index < 0 ? '' : String(index);
      if (f.object) for (const child of f.object.fields) fill(child, childValue(child, value), context, out);
      return;
    }
    case 'list': {
      const items = Array.isArray(value) ? value : [];
      const count = Array.isArray(value) ? items.length : f.minItems;
      out[f.id] = count;
      for (let i = 0; i < count; i++) fill(listItem(f, i), items[i], context, out);
      return;
    }
    case 'number': {
      // A nullable reference isn't prefilled: blank means null there, and the selection would change that.
      const pick = f.ref !== null && !f.nullable ? selected(context, f.ref) : null;
      out[f.id] = typeof value === 'number' ? String(value) : pick !== null ? String(pick) : '';
      return;
    }
    case 'string':
      out[f.id] = typeof value === 'string' ? value : '';
      return;
    case 'scalar':
      out[f.id] = value === undefined || value === null ? '' : String(value);
      return;
  }
}

/** A child's starting value: its own default, else its parent's value at its key. */
function childValue(child: ArgField, parent: unknown): unknown {
  if (child.defaultValue !== undefined) return child.defaultValue;
  return isObjectValue(parent) ? parent[child.key] : undefined;
}

/** Initial values: schema defaults (also from a parent object's default), else the selection for references. */
export function initialValues(form: ArgForm, context: ArgFormContext): Record<string, ArgValue> {
  const values: Record<string, ArgValue> = {};
  for (const f of form.fields) fill(f, f.defaultValue, context, values);
  return values;
}

function isObjectValue(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The JSON-number grammar, as the console uses (no `+`, no hex, no leading zeros). */
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** What a blank nullable field means: `null` when the key has no default, else "not given" (the default applies). */
const blank = (f: FieldBase & { readonly nullable: boolean }): unknown =>
  f.nullable && f.defaultValue === undefined ? null : undefined;

/**
 * The args object the values describe. Blank optional fields are left out (so defaults apply),
 * blank nullable fields are `null` unless they have a default, and a number field that isn't a
 * number is passed through as text, so the schema reports it.
 */
export function argsFromValues(form: ArgForm, values: ArgValues): Record<string, unknown> {
  const build = (fields: readonly ArgField[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const value = valueOf(f);
      if (value !== undefined) out[f.key] = value;
    }
    return out;
  };
  const valueOf = (f: ArgField): unknown => {
    const raw = values[f.id];
    switch (f.kind) {
      case 'object':
        return isOptionalObject(f) && raw !== true ? undefined : build(f.fields);
      case 'boolean':
        return raw === true;
      case 'enum':
        return typeof raw === 'string' && raw !== '' ? f.options[Number(raw)] : undefined;
      case 'choice': {
        const option = chosenOption(f, values);
        if (option === null) return undefined;
        return option.kind === 'value' ? option.value : build(f.object?.fields ?? []);
      }
      case 'list': {
        const count = itemCount(f, values);
        if (count === 0 && !f.required && f.defaultValue === undefined) return undefined;
        return Array.from({ length: count }, (_, i) => valueOf(listItem(f, i)));
      }
      case 'number': {
        const text = typeof raw === 'string' ? raw.trim() : '';
        if (text === '') return blank(f);
        return NUMBER.test(text) ? Number(text) : text;
      }
      case 'string': {
        const text = typeof raw === 'string' ? raw : '';
        if (text === '' && f.nullable) return blank(f);
        return text === '' && !f.required ? undefined : text;
      }
      case 'scalar': {
        const value = scalarValue(f, typeof raw === 'string' ? raw.trim() : '');
        return value === undefined ? blank(f) : value;
      }
    }
  };
  return build(form.fields);
}

/**
 * A scalar field's text as the value a console word would give it, limited to the field's types:
 * `true`/`false` → boolean, a JSON number → number, anything else → the text. Blank is "not given".
 */
export function scalarValue(f: ScalarField, text: string): unknown {
  if (text === '') return undefined;
  if (f.types.includes('boolean') && (text === 'true' || text === 'false')) return text === 'true';
  if (f.types.includes('number') && NUMBER.test(text)) return Number(text);
  return text;
}

/**
 * The fields the values make visible, depth first: {@link allFields} plus the chosen object's
 * fields of each choice and every item of each list (at the current counts).
 */
export function visibleFields(fields: readonly ArgField[], values: ArgValues): ArgField[] {
  return fields.flatMap((f): ArgField[] => {
    switch (f.kind) {
      case 'object':
        return [f, ...visibleFields(f.fields, values)];
      case 'choice':
        return chosenOption(f, values)?.kind === 'object' && f.object
          ? [f, ...visibleFields(f.object.fields, values)]
          : [f];
      case 'list': {
        const items = Array.from({ length: itemCount(f, values) }, (_, i) => listItem(f, i));
        return [f, ...visibleFields(items, values)];
      }
      default:
        return [f];
    }
  });
}

/** Validation messages: per field id, plus messages that belong to no field. */
export interface ArgErrors {
  readonly fields: Readonly<Record<string, readonly string[]>>;
  readonly form: readonly string[];
}

export type ValidateResult =
  { readonly ok: true; readonly args: unknown } | { readonly ok: false; readonly errors: ArgErrors };

/**
 * Validates `args` with the command's own schema and maps each Zod issue to the field at its path
 * (or to the nearest enclosing field): `route.3.positionMm.x` for an item of a list. A missing value
 * reads "Required"; every other message is Zod's own, so the palette, console and scripts report the
 * same rules. `values` (when given) decides which choice objects and list items exist.
 */
export function validateArgs(
  schema: z.ZodType,
  form: ArgForm,
  args: Record<string, unknown>,
  values: ArgValues = {},
): ValidateResult {
  const parsed = schema.safeParse(args);
  if (parsed.success) return { ok: true, args: parsed.data };
  const ids = new Set(visibleFields(form.fields, values).map((f) => f.id));
  const fields: Record<string, string[]> = {};
  const formErrors: string[] = [];
  for (const issue of parsed.error.issues) {
    const path = issue.path.map(String);
    const missing = path.length > 0 && valueAt(args, path) === undefined;
    const message = missing ? 'Required' : issue.message;
    let target: string | null = null;
    for (let n = path.length; n > 0 && target === null; n--) {
      const id = path.slice(0, n).join('.');
      if (ids.has(id)) target = id;
    }
    if (target === null) formErrors.push(message);
    else (fields[target] ??= []).push(message);
  }
  return { ok: false, errors: { fields, form: formErrors } };
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || !Object.prototype.hasOwnProperty.call(current, key)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Item `index`'s values (keys `<list>.<index>` and below), re-keyed for index `to`. */
function itemEntries(list: ListField, values: ArgValues, index: number, to: number): [string, ArgValue][] {
  const from = `${list.id}.${index}`;
  const target = `${list.id}.${to}`;
  return Object.entries(values)
    .filter(([k]) => k === from || k.startsWith(`${from}.`))
    .map(([k, v]) => [target + k.slice(from.length), v]);
}

/** `values` without any item of `list` (count kept). */
function withoutItems(list: ListField, values: ArgValues): Record<string, ArgValue> {
  const prefix = `${list.id}.`;
  return Object.fromEntries(Object.entries(values).filter(([k]) => !k.startsWith(prefix)));
}

/** Rebuilds a list's items from an index order (`order[i]` is the old index now at `i`). */
function reorder(list: ListField, values: ArgValues, order: readonly number[]): Record<string, ArgValue> {
  const out = withoutItems(list, values);
  order.forEach((from, to) => {
    for (const [k, v] of itemEntries(list, values, from, to)) out[k] = v;
  });
  out[list.id] = order.length;
  return out;
}

/** Whether another item may be added (below `maxItems`). */
export const canAddItem = (list: ListField, values: ArgValues): boolean =>
  list.maxItems === null || itemCount(list, values) < list.maxItems;

/** Whether an item may be removed (above `minItems`). */
export const canRemoveItem = (list: ListField, values: ArgValues): boolean => itemCount(list, values) > list.minItems;

/** `values` with a new item at the end of `list`, filled from the item's defaults. */
export function addListItem(list: ListField, values: ArgValues, context: ArgFormContext): Record<string, ArgValue> {
  const count = itemCount(list, values);
  const out: Record<string, ArgValue> = { ...values, [list.id]: count + 1 };
  fill(listItem(list, count), list.item.defaultValue, context, out);
  return out;
}

/** `values` without item `index` of `list`; later items move up one. */
export function removeListItem(list: ListField, values: ArgValues, index: number): Record<string, ArgValue> {
  const order = Array.from({ length: itemCount(list, values) }, (_, i) => i).filter((i) => i !== index);
  return reorder(list, values, order);
}

/** `values` with item `from` of `list` moved to `to` (the items between shift by one). */
export function moveListItem(list: ListField, values: ArgValues, from: number, to: number): Record<string, ArgValue> {
  const order = Array.from({ length: itemCount(list, values) }, (_, i) => i);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  return reorder(list, values, order);
}

/** Short help for a number field's bounds: "Whole number, 1 to 9". */
export function numberHint(f: NumberField): string {
  const kind = f.integer ? 'Whole number' : 'Number';
  const safe = (n: number | null) => (n !== null && Math.abs(n) < Number.MAX_SAFE_INTEGER ? n : null);
  const min = safe(f.minimum);
  const max = safe(f.maximum);
  const parts: string[] = [];
  if (min !== null && max !== null) parts.push(`${min} to ${max}`);
  else if (min !== null) parts.push(`at least ${min}`);
  else if (max !== null) parts.push(`at most ${max}`);
  if (f.exclusiveMinimum !== null) parts.push(`more than ${f.exclusiveMinimum}`);
  if (f.exclusiveMaximum !== null) parts.push(`less than ${f.exclusiveMaximum}`);
  return parts.length > 0 ? `${kind}, ${parts.join(', ')}` : kind;
}

/** Short help for a scalar field: "true or false, a number, or text". */
export function scalarHint(f: ScalarField): string {
  const words = f.types.map((t) => ({ boolean: 'true or false', number: 'a number', string: 'text' })[t]);
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')}, or ${words.at(-1)}`;
}

/** Short help for a list's size: "1 to 1024 waypoints", "At most 4 items", "Any number of items". */
export function listHint(f: ListField): string {
  const noun = `${f.itemLabel.toLowerCase()}s`;
  if (f.maxItems !== null && f.minItems === f.maxItems) return `Exactly ${f.minItems} ${noun}`;
  if (f.maxItems !== null && f.minItems > 0) return `${f.minItems} to ${f.maxItems} ${noun}`;
  if (f.maxItems !== null) return `At most ${f.maxItems} ${noun}`;
  if (f.minItems > 0) return `At least ${f.minItems} ${noun}`;
  return `Any number of ${noun}`;
}
