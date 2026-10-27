import { type LoadError, migrateWorld } from '@controls/save-format';
import { sha256Hex } from './sha256';
import type { World } from './types';

/** Thrown by {@link canonicalJson} for a value outside the JSON domain. */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

/**
 * Canonical JSON (ADR 0007): object keys sorted by UTF-16 code units (the default `sort` order),
 * recursively; arrays in order; no whitespace; strings escaped and numbers formatted exactly as
 * `JSON.stringify` does (ECMAScript `Number::toString`, so `-0` is written `0`). For finite numbers
 * and well-formed strings this matches RFC 8785.
 *
 * Throws {@link CanonicalJsonError} rather than silently dropping or rewriting anything
 * `JSON.stringify` would: `undefined`, functions, symbols, bigints, non-finite numbers and objects
 * that aren't plain (`Date`, `Map`, class instances).
 */
export function canonicalJson(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`Non-finite number ${String(value)}`);
      return JSON.stringify(value);
    case 'object': {
      if (value === null) return 'null';
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new CanonicalJsonError('Not a plain object');
      const record = value as Record<string, unknown>;
      const members = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
      return `{${members.join(',')}}`;
    }
    default:
      throw new CanonicalJsonError(`Not a JSON value (${typeof value})`);
  }
}

/**
 * `world.hash`: SHA-256 of the UTF-8 canonical JSON of the world document, as 64 lower-case hex
 * digits (ADR 0007). View state, settings and the replay log never affect it. The same world gives
 * the same hash in Node and Chromium (tested in both).
 */
export function worldHash(world: World): string {
  return sha256Hex(canonicalJson(world));
}

/**
 * Hashes untrusted world JSON (already `JSON.parse`d): validates and migrates it to the current
 * schema first, so the hash is always over a parsed world. Never throws.
 */
export function hashWorldDocument(
  input: unknown,
):
  | { readonly ok: true; readonly hash: string; readonly world: World }
  | { readonly ok: false; readonly error: LoadError } {
  const loaded = migrateWorld(input);
  return loaded.ok
    ? { ok: true, hash: worldHash(loaded.value), world: loaded.value }
    : { ok: false, error: loaded.error };
}
