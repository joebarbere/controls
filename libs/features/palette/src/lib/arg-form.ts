import { ARG_REF_KEYWORD, type ArgRefKind } from '@controls/commands';
import { z } from 'zod';

/*
 * Palette argument forms, generated from a command's Zod `args` (plan F1.3). The schema goes through
 * `z.toJSONSchema` (input side, so defaulted and optional keys are not required) and the resulting
 * JSON Schema is turned into a small field model. `.meta()` hints add labels (`title`), help text
 * (`description`) and reference kinds (`x-controls-ref`, see `@controls/commands` arg hints).
 *
 * The form only shapes and types what the player typed; validation is the command's own schema
 * (`validateArgs`), the same one `exec`, the console and scripts use. Shapes the form can't express
 * (arrays, unions, records, recursion) make `buildArgForm` fail, and a spec builds a form for every
 * registered command, so a new command can't silently break the palette.
 */

interface FieldBase {
  /** Key in the parent object. */
  readonly key: string;
  /** Dotted path from the args root (`positionMm.x`): the field's id in values and errors. */
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
}

export interface NumberField extends FieldBase {
  readonly kind: 'number';
  readonly integer: boolean;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly exclusiveMinimum: number | null;
  readonly exclusiveMaximum: number | null;
  /** What the number refers to (`entity`: an entity id, so the form offers the selection). */
  readonly ref: ArgRefKind | null;
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

export interface ObjectField extends FieldBase {
  readonly kind: 'object';
  readonly fields: readonly ArgField[];
}

export type ArgField = StringField | NumberField | BooleanField | EnumField | ObjectField;

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

const UNITS: Readonly<Record<string, string>> = { Mm: 'mm', Mdeg: 'millidegrees' };
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

function field(
  key: string,
  id: string,
  raw: JsonSchema,
  required: boolean,
  defs: JsonSchema,
  outerRefs: readonly string[],
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
  if (ref !== undefined && ref !== 'entity') throw new Unsupported(id, `unknown ${ARG_REF_KEYWORD} ${String(ref)}`);
  if (ref !== undefined && schema['type'] !== 'integer')
    throw new Unsupported(id, 'entity references must be integers');

  for (const keyword of ['anyOf', 'oneOf', 'allOf', 'not']) {
    if (schema[keyword] !== undefined) throw new Unsupported(id, `${keyword} (unions) is not supported`);
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
        ref: ref === 'entity' ? 'entity' : null,
      };
    case 'boolean':
      // An optional boolean without a default has three states (unset, true, false): offer a choice.
      return required || base.defaultValue !== undefined
        ? { ...base, kind: 'boolean' }
        : { ...base, kind: 'enum', options: [true, false] };
    case 'object':
      return { ...base, kind: 'object', fields: objectFields(schema, defs, id, refs) };
    default:
      throw new Unsupported(id, `type ${JSON.stringify(schema['type'] ?? null)} is not supported`);
  }
}

/** Every field in the form, depth first (objects before their children). */
export function allFields(fields: readonly ArgField[]): ArgField[] {
  return fields.flatMap((f) => (f.kind === 'object' ? [f, ...allFields(f.fields)] : [f]));
}

/**
 * What the player has entered, by field id: text for strings and numbers, `true`/`false` for
 * booleans, the option index as text for enums (`''` = not chosen), and for an optional object
 * without a default whether it is included.
 */
export type ArgValues = Readonly<Record<string, string | boolean>>;

/** Context for initial values: the selected world entity, offered to entity-reference fields. */
export interface ArgFormContext {
  readonly selectedEntityId: number | null;
}

/** Whether an object field is included only when the player asks for it (optional, no default). */
export const isOptionalObject = (f: ObjectField): boolean => !f.required && f.defaultValue === undefined;

/** Initial values: schema defaults (also from a parent object's default), else the selection for entity refs. */
export function initialValues(form: ArgForm, context: ArgFormContext): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  const visit = (fields: readonly ArgField[], inherited: unknown) => {
    for (const f of fields) {
      const fromParent = isObjectValue(inherited) ? inherited[f.key] : undefined;
      const value = f.defaultValue !== undefined ? f.defaultValue : fromParent;
      switch (f.kind) {
        case 'object':
          if (isOptionalObject(f)) values[f.id] = false;
          visit(f.fields, value);
          break;
        case 'boolean':
          values[f.id] = value === true;
          break;
        case 'enum': {
          const index = value === undefined ? -1 : f.options.indexOf(value as EnumOption);
          values[f.id] = index < 0 ? '' : String(index);
          break;
        }
        case 'number':
          if (typeof value === 'number') values[f.id] = String(value);
          else if (f.ref === 'entity' && context.selectedEntityId !== null)
            values[f.id] = String(context.selectedEntityId);
          else values[f.id] = '';
          break;
        case 'string':
          values[f.id] = typeof value === 'string' ? value : '';
          break;
      }
    }
  };
  visit(form.fields, undefined);
  return values;
}

function isObjectValue(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The JSON-number grammar, as the console uses (no `+`, no hex, no leading zeros). */
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * The args object the values describe. Blank optional fields are left out (so defaults apply), a
 * number field that isn't a number is passed through as text, so the schema reports it.
 */
export function argsFromValues(form: ArgForm, values: ArgValues): Record<string, unknown> {
  const build = (fields: readonly ArgField[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const value = valueOf(f, values);
      if (value !== undefined) out[f.key] = value;
    }
    return out;
  };
  const valueOf = (f: ArgField, v: ArgValues): unknown => {
    const raw = v[f.id];
    switch (f.kind) {
      case 'object':
        return isOptionalObject(f) && raw !== true ? undefined : build(f.fields);
      case 'boolean':
        return raw === true;
      case 'enum':
        return typeof raw === 'string' && raw !== '' ? f.options[Number(raw)] : undefined;
      case 'number': {
        const text = typeof raw === 'string' ? raw.trim() : '';
        if (text === '') return undefined;
        return NUMBER.test(text) ? Number(text) : text;
      }
      case 'string': {
        const text = typeof raw === 'string' ? raw : '';
        return text === '' && !f.required ? undefined : text;
      }
    }
  };
  return build(form.fields);
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
 * (or to the nearest enclosing field). A missing value reads "Required"; every other message is
 * Zod's own, so the palette, console and scripts report the same rules.
 */
export function validateArgs(schema: z.ZodType, form: ArgForm, args: Record<string, unknown>): ValidateResult {
  const parsed = schema.safeParse(args);
  if (parsed.success) return { ok: true, args: parsed.data };
  const ids = new Set(allFields(form.fields).map((f) => f.id));
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
    if (!isObjectValue(current) || !Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = current[key];
  }
  return current;
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
