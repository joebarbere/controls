import { z } from 'zod';

/**
 * Shared building blocks for every persisted document. Everything here exists to keep documents
 * lossless under `JSON.parse(JSON.stringify(x))` (ADR 0004) and through the UTF-8 `.ctrl` container.
 * Once a schema version that uses a primitive is published, changing the primitive changes that
 * version: add a new primitive instead.
 */

/** `-0` survives in memory but `JSON.stringify(-0)` is `"0"`, so every persisted number is normalised. */
export function normaliseZero(n: number): number {
  return n + 0;
}

/** Matches an unpaired UTF-16 surrogate (in `u` mode a valid pair is one code point outside this range). */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** True if `s` is well-formed UTF-16, so encoding it as UTF-8 is lossless. */
export function isWellFormed(s: string): boolean {
  return !LONE_SURROGATE.test(s);
}

/**
 * A string that survives UTF-8 encoding. `JSON.stringify` keeps lone surrogates, but `TextEncoder`
 * (used to write the ZIP entries) replaces them with U+FFFD, which would silently change the save.
 */
export const SafeString = z.string().refine(isWellFormed, { message: 'String contains an unpaired UTF-16 surrogate' });

/**
 * An object key inside an opaque JSON bag. Note: `JSON.parse` creates `"__proto__"` as an own key, and
 * Zod 4's `z.record` silently skips it (strict objects report it), so a key schema can never refuse it.
 * The loaders refuse it up front with {@link findProtoKey}; never `.parse` untrusted JSON directly.
 */
export const JsonKey = SafeString;

/**
 * Path of the first own `"__proto__"` key anywhere in `value`, or `null`. Iterative, so it is safe on
 * hostile input. Such a key can only come from `JSON.parse` and would vanish silently in `z.record`.
 */
export function findProtoKey(value: unknown): string | null {
  const stack: { value: unknown; path: string }[] = [{ value, path: '' }];
  while (stack.length > 0) {
    const item = stack.pop() as { value: unknown; path: string };
    if (typeof item.value !== 'object' || item.value === null) continue;
    if (Array.isArray(item.value)) {
      item.value.forEach((child, index) => stack.push({ value: child, path: `${item.path}[${index}]` }));
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(item.value, '__proto__')) {
      return item.path === '' ? '__proto__' : `${item.path}.__proto__`;
    }
    for (const [key, child] of Object.entries(item.value)) {
      stack.push({ value: child, path: item.path === '' ? key : `${item.path}.${key}` });
    }
  }
  return null;
}

/** A finite JSON number with `-0` normalised. Zod 4's `z.number()` already rejects NaN and ±Infinity. */
export const FiniteNumber = z.number().overwrite(normaliseZero);

/** A safe integer with `-0` normalised. */
export const Int = z.int().overwrite(normaliseZero);

/** Deepest nesting allowed inside an opaque JSON bag (`extensions`, command `args`, workspace layout). */
export const MAX_JSON_VALUE_DEPTH = 32;

/**
 * Deepest nesting a loader accepts for a whole document, checked before Zod sees it: Zod parses
 * recursively, so a hostile, deeply nested file would otherwise throw `RangeError` (stack overflow).
 */
export const MAX_DOCUMENT_DEPTH = 64;

/**
 * Nesting depth of a JSON-like value (scalars are 0, `[]` and `{}` are 1), computed iteratively so it
 * is safe on hostile input. Stops early and returns `limit + 1` once `limit` is exceeded.
 */
export function jsonDepth(value: unknown, limit: number = Number.MAX_SAFE_INTEGER): number {
  let max = 0;
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const item = stack.pop() as { value: unknown; depth: number };
    if (typeof item.value !== 'object' || item.value === null) continue;
    const depth = item.depth + 1;
    if (depth > limit) return limit + 1;
    if (depth > max) max = depth;
    const children = Array.isArray(item.value) ? item.value : Object.values(item.value);
    for (const child of children) stack.push({ value: child, depth });
  }
  return max;
}

/** A plain JSON value. Recursive, so its JSON Schema is emitted once under `$defs/JsonValue`. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const JsonValue: z.ZodType<JsonValue> = z
  .lazy(() =>
    z.union([SafeString, FiniteNumber, z.boolean(), z.null(), z.array(JsonValue), z.record(JsonKey, JsonValue)]),
  )
  .meta({
    id: 'JsonValue',
    description: 'Any JSON value: finite numbers only, well-formed strings; loaders also refuse "__proto__" keys.',
  });

function maxDepth<T>(schema: z.ZodType<T>, what: string): z.ZodType<T> {
  return schema.refine((v) => jsonDepth(v, MAX_JSON_VALUE_DEPTH) <= MAX_JSON_VALUE_DEPTH, {
    message: `${what} is nested deeper than ${MAX_JSON_VALUE_DEPTH} levels`,
  });
}

/** A JSON object whose values are opaque JSON, nested at most {@link MAX_JSON_VALUE_DEPTH} deep. */
export function jsonObject(what: string) {
  return maxDepth(z.record(JsonKey, JsonValue), what);
}

/** An opaque JSON value nested at most {@link MAX_JSON_VALUE_DEPTH} deep. */
export function boundedJsonValue(what: string) {
  return maxDepth(JsonValue, what);
}

/**
 * The forward-compatibility bag (ADR 0004). Data the current schema doesn't model goes here and must
 * round-trip untouched. Use namespaced keys (`"mod.example.flag"`), never a key the schema might
 * later claim as a field.
 */
export const Extensions = jsonObject('extensions').meta({
  id: 'Extensions',
  description: 'Forward-compatibility bag: opaque JSON that every version must round-trip untouched.',
});
export type Extensions = z.infer<typeof Extensions>;

/** Dotted lower-case segments, each kebab-case: `prop.crate`, `contactor.nema-size1`. */
export const CATALOG_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/;

export const CatalogId = z.string().max(128).regex(CATALOG_ID_PATTERN);

/** A catalogue entry by reference (id + version), never inlined (ADR 0004). */
export const CatalogRef = z
  .strictObject({
    id: CatalogId,
    version: z.int().min(1),
  })
  .meta({ id: 'CatalogRef', description: 'A catalogue entry by reference: id plus integer version.' });
export type CatalogRef = z.infer<typeof CatalogRef>;

/**
 * A device terminal id within one catalogue entry (`pos`, `neg`, `a`, `13`, `L1`): an ASCII letter or
 * digit, then letters, digits, `_` or `-`, at most 32 characters. Never `:`, because scripts name a
 * terminal as `"<entityId>:<terminalId>"` (`game.probe`, P2). Added for world v2 (ADR 0013).
 */
export const TERMINAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export const TerminalId = z.string().max(32).regex(TERMINAL_ID_PATTERN).meta({
  id: 'TerminalId',
  description: 'A terminal id within one device: a letter or digit, then letters, digits, "_" or "-"; at most 32.',
});

/**
 * A key in a device state bag (`closed`, `stateOfCharge`): lower camelCase, at most 64 characters
 * (ADR 0011 §1, ADR 0013). Which keys a device has is decided by its model kind (`MODEL_KINDS` in
 * `@controls/catalog`), not by the world schema, so a new device kind never needs a `schemaVersion` bump.
 */
export const DEVICE_STATE_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

export const DeviceStateKey = z.string().max(64).regex(DEVICE_STATE_KEY_PATTERN);

/** Longest enum string a device state bag may hold (`'tripped'`, `'blown'`). */
export const MAX_DEVICE_STATE_STRING = 32;

/** Most keys one device state bag may hold. */
export const MAX_DEVICE_STATE_KEYS = 64;

/**
 * One value in a device state bag: a finite number (`-0` normalised), a boolean, a short enum string
 * or `null` for "absent" (never a missing key). The device model's own schema narrows it per key.
 */
export const DeviceStateValue = z
  .union([FiniteNumber, z.boolean(), SafeString.max(MAX_DEVICE_STATE_STRING), z.null()])
  .meta({
    id: 'DeviceStateValue',
    description: 'A finite number, a boolean, an enum string of at most 32 characters, or null for absent.',
  });
export type DeviceStateValue = z.infer<typeof DeviceStateValue>;

/**
 * A device state bag: named values, keys in {@link DEVICE_STATE_KEY_PATTERN}, at most
 * {@link MAX_DEVICE_STATE_KEYS}. The world schema checks only this generic shape; the load path
 * checks each bag against its device's model kind (ADR 0013).
 */
export const DeviceStateBag = z
  .record(DeviceStateKey, DeviceStateValue)
  .refine((bag) => Object.keys(bag).length <= MAX_DEVICE_STATE_KEYS, {
    message: `A device state bag holds at most ${MAX_DEVICE_STATE_KEYS} keys`,
  })
  .meta({
    id: 'DeviceStateBag',
    description: 'Named device state values; keys are lower camelCase (at most 64 characters, at most 64 keys).',
  });
export type DeviceStateBag = z.infer<typeof DeviceStateBag>;

/** Built-in props (`prop.*` at version 1) are drawn by renderer recipes until the catalogue lands (ADR 0007). */
export const BUILTIN_PROP_PREFIX = 'prop.';

export function isBuiltinPropRef(ref: CatalogRef): boolean {
  return ref.id.startsWith(BUILTIN_PROP_PREFIX) && ref.version === 1;
}

/** Dotted segments, each starting lower-case and then camelCase: `entity.place`, `view.resetLayout`. */
export const COMMAND_ID_PATTERN = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;

export const CommandId = z.string().max(128).regex(COMMAND_ID_PATTERN);

/** Difficulty presets (plan F5.3). Settings hold the default for new games; the world holds the actual value. */
export const Difficulty = z.enum(['trainee', 'apprentice', 'journeyman', 'realistic']);
export type Difficulty = z.infer<typeof Difficulty>;

/** Region profiles. NEC is the only one shipped through 1.0 (plan §4.10); adding one is a schema change. */
export const RegionId = z.enum(['nec']);
export type RegionId = z.infer<typeof RegionId>;

/** SemVer 2.0 version string, as written by `pnpm version:sync` into `APP_VERSION`. */
export const SemVer = z
  .string()
  .max(64)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
