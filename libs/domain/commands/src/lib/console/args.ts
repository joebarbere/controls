import type * as z from 'zod';
import type { CommandRegistry } from '../registry';
import {
  type ConsoleCommandLine,
  type ConsoleError,
  type ConsoleFlag,
  type ConsoleWord,
  parseConsoleLine,
} from './parse';

/*
 * Mapping a parsed console line onto a command's Zod `args` (ADR 0008). The mapping only shapes and
 * types the words; the command's own schema still validates the result inside `exec`, so bounds,
 * patterns and strictness are checked in exactly one place for every surface.
 *
 * - Flags address the args object by dotted path: `--positionMm.x 100`. A path that isn't in the
 *   schema's object shape is an error here (with a column), not just a Zod issue later. A dotted
 *   path may also go inside a nullable object, or the one object member of a union
 *   (`--a.termination.method screw` for `termination: 'auto' | { method, … }`).
 * - Positional words fill the shape's keys in declaration order, so `entity.delete 3` means
 *   `{ id: 3 }`. A key can't be given both ways, or twice.
 * - Words are typed by the leaf schema: a number field needs a number literal, a boolean field takes
 *   a bare flag, `true` or `false`, and string-like fields take the text as written (`12` → "12").
 *   Leaves the mapping can't classify (scalar unions, `unknown`) get the word's lexical type.
 * - A JSON word (`[…]` or `{…}`, ADR 0008 amendment) gives a whole array, object or union value; it
 *   is the only way to give an array. A nullable value (an object or union included) takes `null`.
 */

/** A JSON-ish value a scalar console word can become. */
export type ConsoleArgValue = string | number | boolean | null;

export type ConsoleArgsResult =
  { readonly ok: true; readonly args: Record<string, unknown> } | { readonly ok: false; readonly error: ConsoleError };

export type ConsoleCommandResult =
  | { readonly ok: true; readonly command: { readonly id: string; readonly args: Record<string, unknown> } | null }
  | { readonly ok: false; readonly error: ConsoleError };

/** Options for {@link consoleArgs} and {@link parseConsoleCommand}. */
export interface ConsoleArgsOptions {
  /**
   * Console shorthand (ADR 0015, `expandConsoleArgs` in `@controls/scripting-api`): for a dotted
   * argument path where this returns true, an unquoted, non-JSON word keeps its lexical type
   * instead of being typed by the schema, so `--route auto` reaches the expander as `'auto'` and
   * `--lengthMm 3000` is still a number. The expander must replace it before `exec`.
   */
  readonly shorthand?: (path: string) => boolean;
}

interface SchemaDef {
  readonly type: string;
  readonly innerType?: z.ZodType;
  readonly in?: z.ZodType;
  readonly shape?: Readonly<Record<string, z.ZodType>>;
  readonly values?: readonly unknown[];
  readonly options?: readonly z.ZodType[];
}

const WRAPPERS = new Set(['optional', 'default', 'prefault', 'nullable', 'readonly', 'catch', 'nonoptional']);
/** Wrappers that let a key be left out (for help and completion only; `exec` decides). */
const OPTIONAL_WRAPPERS = new Set(['optional', 'default', 'prefault']);
/** Schema types whose value is given as one JSON word (or by dotted flags, for objects). */
const JSON_TYPES = new Set(['array', 'object', 'tuple', 'record', 'union', 'unknown', 'any']);
/** Same as the JSON-number grammar (no leading zeros, no `+`, no hex). */
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** One segment of a dotted flag name (the parser's grammar). */
const FLAG_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function defOf(schema: z.ZodType): SchemaDef {
  return schema._zod.def as unknown as SchemaDef;
}

interface Unwrapped {
  readonly def: SchemaDef;
  /** A wrapper, a `null` member or a `null` literal accepts `null`. */
  readonly nullable: boolean;
  readonly optional: boolean;
  readonly inner: z.ZodType;
}

/**
 * Strips optional/default/nullable/pipe wrappers down to the schema that decides a word's type, and
 * notes whether `null` is accepted (so `--x null` works for a nullable number or object).
 */
function unwrap(schema: z.ZodType): Unwrapped {
  let inner = schema;
  let def = defOf(schema);
  let nullable = false;
  let optional = false;
  for (let depth = 0; depth < 16; depth++) {
    if (def.type === 'nullable') nullable = true;
    if (OPTIONAL_WRAPPERS.has(def.type)) optional = true;
    if (WRAPPERS.has(def.type) && def.innerType) inner = def.innerType;
    else if (def.type === 'pipe' && def.in) inner = def.in;
    else break;
    def = defOf(inner);
  }
  if (def.type === 'union' && unionMembers(def).some((m) => isNullMember(m.def))) nullable = true;
  return { def, nullable, optional, inner };
}

function unionMembers(def: SchemaDef): Unwrapped[] {
  return (def.options ?? []).map((option) => unwrap(option));
}

function isNullMember(def: SchemaDef): boolean {
  return def.type === 'null' || (def.type === 'literal' && (def.values ?? []).includes(null));
}

/**
 * The object a dotted flag can descend into: the schema itself (unwrapped), or the one object
 * member of a union (`'auto' | { … }`, `{ … } | null`). Two object members would be ambiguous.
 */
function objectOf(schema: z.ZodType): z.ZodType | null {
  const { def, inner } = unwrap(schema);
  if (def.type === 'object') return inner;
  if (def.type !== 'union') return null;
  const objects = unionMembers(def).filter((m) => m.def.type === 'object');
  return objects.length === 1 ? objects[0].inner : null;
}

function shapeOf(schema: z.ZodType): Readonly<Record<string, z.ZodType>> | null {
  const object = objectOf(schema);
  const shape = object ? defOf(object).shape : undefined;
  return shape ?? null;
}

/** The scalar literal values of a union's literal and enum members, in declaration order. */
function unionLiterals(def: SchemaDef): (string | number | boolean)[] {
  const values: (string | number | boolean)[] = [];
  for (const member of unionMembers(def)) {
    const kind = fieldKind(member.def);
    if (kind.kind === 'enum') for (const v of kind.values) if (!values.includes(v)) values.push(v);
  }
  return values;
}

class MappingError extends Error {
  constructor(
    message: string,
    readonly column: number,
  ) {
    super(message);
  }
}

function lexical(word: ConsoleWord): ConsoleArgValue {
  if (word.quoted) return word.text;
  if (word.text === 'true') return true;
  if (word.text === 'false') return false;
  if (word.text === 'null') return null;
  if (NUMBER.test(word.text)) {
    const n = Number(word.text);
    if (Number.isFinite(n)) return n;
  }
  return word.text;
}

function numberOf(word: ConsoleWord, label: string): number {
  const n = word.quoted || !NUMBER.test(word.text) ? Number.NaN : Number(word.text);
  if (!Number.isFinite(n)) {
    throw new MappingError(`${label} expects a number, found ${JSON.stringify(word.text)}`, word.column);
  }
  return n;
}

function typed(
  schema: z.ZodType,
  path: string,
  label: string,
  value: ConsoleWord | null,
  column: number,
  options: ConsoleArgsOptions,
): unknown {
  const { def, nullable } = unwrap(schema);
  if (value === null) {
    if (def.type === 'boolean') return true;
    throw new MappingError(`${label} needs a value`, column);
  }
  if (value.json) {
    if (JSON_TYPES.has(def.type)) return JSON.parse(value.text) as unknown;
    throw new MappingError(`${label} takes one word, not a JSON value (quote it for text)`, value.column);
  }
  if (!value.quoted && options.shorthand?.(path)) return lexical(value);
  if (nullable && !value.quoted && value.text === 'null') return null;
  switch (def.type) {
    case 'object':
      throw new MappingError(
        `${label} is an object: give its fields as flags (${label}.<field>) or the whole object as JSON`,
        column,
      );
    case 'array':
    case 'tuple':
      throw new MappingError(`${label} is a list: give it as one JSON word, like [1,2]`, column);
    case 'record':
      throw new MappingError(`${label} is a map: give it as one JSON word, like {"key":1}`, column);
    case 'boolean':
      if (!value.quoted && (value.text === 'true' || value.text === 'false')) return value.text === 'true';
      throw new MappingError(`${label} expects true or false, found ${JSON.stringify(value.text)}`, value.column);
    case 'number':
      return numberOf(value, label);
    case 'string':
    case 'enum':
    case 'template_literal':
      return value.text;
    case 'literal': {
      const literals = def.values ?? [];
      if (literals.every((v) => typeof v === 'string')) return value.text;
      if (literals.every((v) => typeof v === 'number')) return numberOf(value, label);
      return lexical(value);
    }
    default:
      return lexical(value);
  }
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** One line's mapping: the args object and the nested objects the flags themselves created. */
interface Mapping {
  readonly args: Record<string, unknown>;
  /** Objects made by dotted flags (a JSON word's objects are complete and can't be added to). */
  readonly built: WeakSet<object>;
  readonly options: ConsoleArgsOptions;
}

/** Sets `path` in the mapping, creating nested objects; `flagLabel` names it in errors. */
function assign(
  mapping: Mapping,
  root: z.ZodType,
  path: readonly string[],
  value: ConsoleWord | null,
  column: number,
  flagLabel: string,
): void {
  let schema = root;
  let object = mapping.args;
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    const label = path.slice(0, i + 1).join('.');
    const shape = shapeOf(schema);
    if (FORBIDDEN_KEYS.has(key) || !shape || !hasOwn(shape, key)) {
      throw new MappingError(`Unknown argument ${flagLabel}`, column);
    }
    schema = shape[key];
    if (i === path.length - 1) {
      if (hasOwn(object, key)) throw new MappingError(`Argument ${label} is given twice`, column);
      object[key] = typed(schema, label, flagLabel, value, column, mapping.options);
      return;
    }
    if (!hasOwn(object, key)) {
      const child = {};
      mapping.built.add(child);
      object[key] = child;
    }
    const child = object[key];
    if (typeof child !== 'object' || child === null || !mapping.built.has(child)) {
      throw new MappingError(`Argument ${label} is given twice`, column);
    }
    object = child as Record<string, unknown>;
  }
}

/**
 * Maps a parsed console line onto `schema` (a command's `args`), producing the raw args object to
 * pass to `exec`. Errors carry the column of the offending word or flag. Doesn't validate bounds or
 * required fields: `exec` does that with the same schema.
 */
export function consoleArgs(
  schema: z.ZodType,
  line: ConsoleCommandLine,
  options: ConsoleArgsOptions = {},
): ConsoleArgsResult {
  try {
    const mapping: Mapping = { args: {}, built: new WeakSet(), options };
    const keys = Object.keys(shapeOf(schema) ?? {});
    line.positionals.forEach((word, index) => {
      const key = keys[index];
      if (key === undefined) {
        throw new MappingError(
          keys.length === 0
            ? `${line.id} takes no positional arguments`
            : `${line.id} takes at most ${keys.length} positional argument${keys.length === 1 ? '' : 's'} (${keys.join(', ')})`,
          word.column,
        );
      }
      assign(mapping, schema, [key], word, word.column, key);
    });
    for (const flag of line.flags) assignFlag(mapping, schema, flag);
    return { ok: true, args: mapping.args };
  } catch (error) {
    // Only MappingError is thrown above.
    const { message, column } = error as MappingError;
    return { ok: false, error: { message, column } };
  }
}

function assignFlag(mapping: Mapping, schema: z.ZodType, flag: ConsoleFlag): void {
  assign(mapping, schema, flag.name.split('.'), flag.value, flag.column, `--${flag.name}`);
}

/**
 * Parses a console line and resolves it against `registry`: the command id and its raw args, or
 * `null` for a blank or comment line. An unknown id is an error at the id's column.
 * `shorthand(id, path)` marks console shorthand paths (see {@link ConsoleArgsOptions}).
 */
export function parseConsoleCommand<S>(
  registry: CommandRegistry<S>,
  source: string,
  shorthand?: (id: string, path: string) => boolean,
): ConsoleCommandResult {
  const parsed = parseConsoleLine(source);
  if (!parsed.ok) return parsed;
  if (parsed.line === null) return { ok: true, command: null };
  const def = registry.get(parsed.line.id);
  if (!def) {
    return { ok: false, error: { message: `Unknown command "${parsed.line.id}"`, column: parsed.line.column } };
  }
  const mapped = consoleArgs(def.args, parsed.line, shorthand ? { shorthand: (path) => shorthand(def.id, path) } : {});
  return mapped.ok ? { ok: true, command: { id: def.id, args: mapped.args } } : mapped;
}

/**
 * How a console word for a field is typed (see `consoleArgs`). `json` is a value given as one JSON
 * word (an array, a nullable object or an object-or-literal union); its `values` are the union's
 * literal words (`auto`), and a nullable one also takes `null`. Plain objects are given by their fields.
 */
export type ConsoleFieldKind = 'number' | 'boolean' | 'string' | 'enum' | 'json' | 'other';

/** One flag a command accepts: what `help` documents and what Tab completion offers (F1.5). */
export interface ConsoleField {
  /** Dotted flag path without `--`, e.g. `positionMm.x`. */
  readonly path: string;
  readonly kind: ConsoleFieldKind;
  /** Allowed values of an enum or literal field, in declaration order; `[true, false]` for booleans. */
  readonly values: readonly (string | number | boolean)[];
  /** The key (or an object around it) may be left out: optional, or has a default. */
  readonly optional: boolean;
  /** `null` is accepted. */
  readonly nullable: boolean;
  /** 0-based position for a top-level key that can be given positionally, else `null`. */
  readonly position: number | null;
  /** Numeric bounds, where the schema declares them. */
  readonly min: number | null;
  readonly max: number | null;
  /** The field's `.describe()` / `.meta({ description })`, if any. */
  readonly description: string | null;
}

interface NumberBounds {
  readonly minValue?: number | null;
  readonly maxValue?: number | null;
  readonly description?: string;
}

function fieldKind(def: SchemaDef): Pick<ConsoleField, 'kind' | 'values'> {
  switch (def.type) {
    case 'number':
      return { kind: 'number', values: [] };
    case 'boolean':
      return { kind: 'boolean', values: [true, false] };
    case 'string':
    case 'template_literal':
      return { kind: 'string', values: [] };
    case 'enum': {
      const entries = (def as SchemaDef & { entries?: Readonly<Record<string, string | number>> }).entries ?? {};
      return { kind: 'enum', values: Object.values(entries) };
    }
    case 'literal': {
      const values = (def.values ?? []).filter(
        (v): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
      );
      return { kind: 'enum', values };
    }
    default:
      return { kind: 'other', values: [] };
  }
}

/** A union given as a JSON word: it has an object or array member (else it is a scalar union, typed lexically). */
function isStructuredUnion(def: SchemaDef): boolean {
  return def.type === 'union' && unionMembers(def).some((m) => JSON_TYPES.has(m.def.type) && m.def.type !== 'union');
}

/**
 * Every flag path `consoleArgs` accepts for `schema` (a command's `args`), depth first in key
 * declaration order, so completion and `help` can never offer a flag the mapping would reject.
 * Object-valued keys are expanded into their fields (an object is given as dotted flags); a
 * nullable object, an object-or-literal union and an array are also listed themselves, as `json`
 * (a JSON word, `null`, or one of the union's literal words), and a union's object member is expanded.
 */
export function consoleFields(schema: z.ZodType): ConsoleField[] {
  const fields: ConsoleField[] = [];
  const walk = (node: z.ZodType, prefix: string, optionalParent: boolean, depth: number) => {
    const shape = shapeOf(node);
    if (!shape || depth > 16) return;
    Object.keys(shape).forEach((key, index) => {
      if (FORBIDDEN_KEYS.has(key) || !FLAG_SEGMENT.test(key)) return;
      const path = prefix ? `${prefix}.${key}` : key;
      const { def, nullable, optional, inner } = unwrap(shape[key]);
      const outer = shape[key] as unknown as NumberBounds;
      const meta = inner as unknown as NumberBounds;
      const common = {
        path,
        optional: optionalParent || optional,
        nullable,
        position: prefix ? null : index,
        min: null,
        max: null,
        description: outer.description ?? meta.description ?? null,
      };
      const structured = isStructuredUnion(def);
      if (structured || def.type === 'array' || def.type === 'tuple' || (def.type === 'object' && nullable)) {
        fields.push({ ...common, kind: 'json', values: def.type === 'union' ? unionLiterals(def) : [] });
      }
      if (def.type === 'object' || structured) {
        walk(shape[key], path, optionalParent || optional, depth + 1);
        return;
      }
      if (def.type === 'array' || def.type === 'tuple') return;
      // `z.int()` reports the safe-integer range as its bounds; that isn't a declared bound.
      const bound = (v: number | null | undefined) =>
        typeof v === 'number' && Number.isFinite(v) && Math.abs(v) !== Number.MAX_SAFE_INTEGER ? v : null;
      fields.push({
        ...common,
        ...fieldKind(def),
        min: def.type === 'number' ? bound(meta.minValue) : null,
        max: def.type === 'number' ? bound(meta.maxValue) : null,
      });
    });
  };
  walk(schema, '', false, 0);
  return fields;
}

/** Thrown by {@link formatConsoleLine} for args the grammar can't express (non-finite numbers, holes, odd keys). */
export class ConsoleFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsoleFormatError';
  }
}

/** Unquoted words that would read back as something else, so a string with this text is quoted. */
function needsQuotes(text: string): boolean {
  return (
    text === '' ||
    /[\s"'\\#]/.test(text) ||
    text.startsWith('--') ||
    text.startsWith('[') ||
    text.startsWith('{') ||
    text === 'true' ||
    text === 'false' ||
    text === 'null' ||
    NUMBER.test(text)
  );
}

function formatValue(value: unknown, label: string): string {
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new ConsoleFormatError(`${label} is not a finite number`);
      return JSON.stringify(value);
    case 'string':
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) {
        throw new ConsoleFormatError(`${label} contains a control character`);
      }
      return needsQuotes(value) ? `"${value.replace(/["\\]/g, (ch) => `\\${ch}`)}"` : value;
    default:
      if (value === null) return 'null';
      throw new ConsoleFormatError(`${label} can't be written as a console word`);
  }
}

/**
 * The compact JSON word for an array or object, keys sorted at every level so the output is
 * deterministic. Refuses what `JSON.stringify` would change silently (non-finite numbers become
 * `null`, `undefined` array items become `null`, other types vanish).
 */
function formatJson(value: unknown, label: string): string {
  const write = (v: unknown, at: string, depth: number): string => {
    if (depth > 64) throw new ConsoleFormatError(`${label} is nested too deeply`);
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new ConsoleFormatError(`${at} is not a finite number`);
      return JSON.stringify(v);
    }
    if (Array.isArray(v)) {
      const items: string[] = [];
      for (let i = 0; i < v.length; i++) {
        if (v[i] === undefined) throw new ConsoleFormatError(`${at}[${i}] is missing`);
        items.push(write(v[i], `${at}[${i}]`, depth + 1));
      }
      return `[${items.join(',')}]`;
    }
    if (typeof v === 'object') {
      const entries = Object.keys(v)
        .sort()
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => `${JSON.stringify(k)}:${write((v as Record<string, unknown>)[k], `${at}.${k}`, depth + 1)}`);
      return `{${entries.join(',')}}`;
    }
    throw new ConsoleFormatError(`${at} can't be written as JSON`);
  };
  return write(value, label, 0);
}

function flatten(value: Record<string, unknown>, prefix: string, out: string[]): void {
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    const name = prefix ? `${prefix}.${key}` : key;
    if (!FLAG_SEGMENT.test(key)) throw new ConsoleFormatError(`Key ${JSON.stringify(key)} can't be a flag name`);
    if (typeof child === 'object' && child !== null) {
      if (Array.isArray(child) || Object.keys(child).length === 0) {
        out.push(`--${name} ${formatJson(child, `--${name}`)}`);
      } else {
        flatten(child as Record<string, unknown>, name, out);
      }
    } else if (child !== undefined) {
      out.push(`--${name} ${formatValue(child, `--${name}`)}`);
    }
  }
}

/**
 * Writes a command call as a console line, with every argument as a flag (sorted, so the output is
 * deterministic): scalars as words, objects as dotted flags (which also reach a nullable object or
 * a union's object member), and arrays and empty objects as one compact JSON word with sorted keys.
 * `parseConsoleCommand` reads it back to the same args. Used for "copy as console line", history and
 * turning replay logs into console files. Throws {@link ConsoleFormatError} for args the grammar
 * can't express.
 */
export function formatConsoleLine(id: string, args: Readonly<Record<string, unknown>> = {}): string {
  const parts: string[] = [];
  flatten(args as Record<string, unknown>, '', parts);
  return [id, ...parts].join(' ');
}
