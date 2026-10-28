import type { z } from 'zod';
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
 *   schema's object shape is an error here (with a column), not just a Zod issue later.
 * - Positional words fill the shape's keys in declaration order, so `entity.delete 3` means
 *   `{ id: 3 }`. A key can't be given both ways, or twice.
 * - Words are typed by the leaf schema: a number field needs a number literal, a boolean field takes
 *   a bare flag, `true` or `false`, and string-like fields take the text as written (`12` → "12").
 *   Leaves the mapping can't classify (unions, `unknown`) get the word's lexical type.
 */

/** A JSON-ish value a console word can become. */
export type ConsoleArgValue = string | number | boolean | null;

export type ConsoleArgsResult =
  { readonly ok: true; readonly args: Record<string, unknown> } | { readonly ok: false; readonly error: ConsoleError };

export type ConsoleCommandResult =
  | { readonly ok: true; readonly command: { readonly id: string; readonly args: Record<string, unknown> } | null }
  | { readonly ok: false; readonly error: ConsoleError };

interface SchemaDef {
  readonly type: string;
  readonly innerType?: z.ZodType;
  readonly in?: z.ZodType;
  readonly shape?: Readonly<Record<string, z.ZodType>>;
  readonly values?: readonly unknown[];
}

const WRAPPERS = new Set(['optional', 'default', 'prefault', 'nullable', 'readonly', 'catch', 'nonoptional']);
/** Wrappers that let a key be left out (for help and completion only; `exec` decides). */
const OPTIONAL_WRAPPERS = new Set(['optional', 'default', 'prefault']);
/** Same as the JSON-number grammar (no leading zeros, no `+`, no hex). */
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** One segment of a dotted flag name (the parser's grammar). */
const FLAG_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function defOf(schema: z.ZodType): SchemaDef {
  return schema._zod.def as unknown as SchemaDef;
}

/**
 * Strips optional/default/nullable/pipe wrappers down to the schema that decides a word's type, and
 * notes whether a wrapper accepts `null` (so `--x null` works for a nullable number).
 */
function unwrap(schema: z.ZodType): { def: SchemaDef; nullable: boolean; optional: boolean; inner: z.ZodType } {
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
  return { def, nullable, optional, inner };
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

function typed(schema: z.ZodType, label: string, value: ConsoleWord | null, column: number): ConsoleArgValue {
  const { def, nullable } = unwrap(schema);
  if (def.type === 'object') {
    throw new MappingError(`${label} is an object: give its fields as flags (${label}.<field>)`, column);
  }
  if (value === null) {
    if (def.type === 'boolean') return true;
    throw new MappingError(`${label} needs a value`, column);
  }
  if (nullable && !value.quoted && value.text === 'null') return null;
  switch (def.type) {
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

function shapeOf(schema: z.ZodType): Readonly<Record<string, z.ZodType>> | null {
  const { def } = unwrap(schema);
  return def.type === 'object' && def.shape ? def.shape : null;
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Sets `path` in `target`, creating nested objects; `flagLabel` names it in errors. */
function assign(
  target: Record<string, unknown>,
  root: z.ZodType,
  path: readonly string[],
  value: ConsoleWord | null,
  column: number,
  flagLabel: string,
): void {
  let schema = root;
  let object = target;
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
      object[key] = typed(schema, flagLabel, value, column);
      return;
    }
    if (!hasOwn(object, key)) object[key] = {};
    const child = object[key];
    if (typeof child !== 'object' || child === null) {
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
export function consoleArgs(schema: z.ZodType, line: ConsoleCommandLine): ConsoleArgsResult {
  try {
    const args: Record<string, unknown> = {};
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
      assign(args, schema, [key], word, word.column, key);
    });
    for (const flag of line.flags) assignFlag(args, schema, flag);
    return { ok: true, args };
  } catch (error) {
    // Only MappingError is thrown above.
    const { message, column } = error as MappingError;
    return { ok: false, error: { message, column } };
  }
}

function assignFlag(args: Record<string, unknown>, schema: z.ZodType, flag: ConsoleFlag): void {
  assign(args, schema, flag.name.split('.'), flag.value, flag.column, `--${flag.name}`);
}

/**
 * Parses a console line and resolves it against `registry`: the command id and its raw args, or
 * `null` for a blank or comment line. An unknown id is an error at the id's column.
 */
export function parseConsoleCommand<S>(registry: CommandRegistry<S>, source: string): ConsoleCommandResult {
  const parsed = parseConsoleLine(source);
  if (!parsed.ok) return parsed;
  if (parsed.line === null) return { ok: true, command: null };
  const def = registry.get(parsed.line.id);
  if (!def) {
    return { ok: false, error: { message: `Unknown command "${parsed.line.id}"`, column: parsed.line.column } };
  }
  const mapped = consoleArgs(def.args, parsed.line);
  return mapped.ok ? { ok: true, command: { id: def.id, args: mapped.args } } : mapped;
}

/** How a console word for a field is typed (see `consoleArgs`). `object` fields are given by their fields. */
export type ConsoleFieldKind = 'number' | 'boolean' | 'string' | 'enum' | 'other';

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
  /** 0-based position for a top-level scalar key that can be given positionally, else `null`. */
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

/**
 * Every flag path `consoleArgs` accepts for `schema` (a command's `args`), depth first in key
 * declaration order, so completion and `help` can never offer a flag the mapping would reject.
 * Object-valued keys are expanded into their fields (an object is given as dotted flags).
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
      if (def.type === 'object') {
        walk(shape[key], path, optionalParent || optional, depth + 1);
        return;
      }
      const meta = inner as unknown as NumberBounds;
      const outer = shape[key] as unknown as NumberBounds;
      // `z.int()` reports the safe-integer range as its bounds; that isn't a declared bound.
      const bound = (v: number | null | undefined) =>
        typeof v === 'number' && Number.isFinite(v) && Math.abs(v) !== Number.MAX_SAFE_INTEGER ? v : null;
      fields.push({
        path,
        ...fieldKind(def),
        optional: optionalParent || optional,
        nullable,
        position: prefix ? null : index,
        min: def.type === 'number' ? bound(meta.minValue) : null,
        max: def.type === 'number' ? bound(meta.maxValue) : null,
        description: outer.description ?? meta.description ?? null,
      });
    });
  };
  walk(schema, '', false, 0);
  return fields;
}

/** Thrown by {@link formatConsoleLine} for args the grammar can't express (arrays, empty objects, non-finite numbers). */
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

function flatten(value: Record<string, unknown>, prefix: string, out: string[]): void {
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    const name = prefix ? `${prefix}.${key}` : key;
    if (!FLAG_SEGMENT.test(key)) throw new ConsoleFormatError(`Key ${JSON.stringify(key)} can't be a flag name`);
    if (typeof child === 'object' && child !== null) {
      if (Array.isArray(child)) throw new ConsoleFormatError(`--${name} is an array (not in the console grammar)`);
      if (Object.keys(child).length === 0) throw new ConsoleFormatError(`--${name} is an empty object`);
      flatten(child as Record<string, unknown>, name, out);
    } else if (child !== undefined) {
      out.push(`--${name} ${formatValue(child, `--${name}`)}`);
    }
  }
}

/**
 * Writes a command call as a console line, with every argument as a flag (sorted, so the output is
 * deterministic). `parseConsoleCommand` reads it back to the same args. Used for "copy as console
 * line", history and turning replay logs into console files. Throws {@link ConsoleFormatError} for
 * args the grammar can't express.
 */
export function formatConsoleLine(id: string, args: Readonly<Record<string, unknown>> = {}): string {
  const parts: string[] = [];
  flatten(args as Record<string, unknown>, '', parts);
  return [id, ...parts].join(' ');
}
