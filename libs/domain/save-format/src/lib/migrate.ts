import type { z } from 'zod';
import { findProtoKey, jsonDepth, MAX_DOCUMENT_DEPTH } from './primitives';

/** One validation problem, with a JSON path. Never contains the offending value. */
export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

interface ErrorBase {
  /** Human-readable name of the document, e.g. `world document`. */
  readonly document: string;
  /** A short, user-presentable sentence. Never echoes the input. */
  readonly message: string;
}

/** Why a document could not be loaded. Discriminated on `kind`. */
export type LoadError =
  | (ErrorBase & { readonly kind: 'not-an-object' })
  | (ErrorBase & { readonly kind: 'too-deep'; readonly limit: number })
  | (ErrorBase & { readonly kind: 'missing-version'; readonly versionKey: string })
  | (ErrorBase & { readonly kind: 'unsupported-version'; readonly found: number; readonly oldest: number })
  | (ErrorBase & { readonly kind: 'newer-than-build'; readonly found: number; readonly supported: number })
  | (ErrorBase & { readonly kind: 'invalid'; readonly version: number; readonly issues: readonly ValidationIssue[] })
  | (ErrorBase & {
      readonly kind: 'migration-failed';
      readonly from: number;
      readonly to: number;
      readonly issues: readonly ValidationIssue[];
    });

export type LoadErrorKind = LoadError['kind'];

export type LoadResult<T> =
  | { readonly ok: true; readonly value: T; readonly fromVersion: number }
  | { readonly ok: false; readonly error: LoadError };

/** Reports at most this many issues per error. */
export const MAX_REPORTED_ISSUES = 20;
/** Issue messages and paths are cut to this length, so a hostile key can't bloat an error. */
export const MAX_ISSUE_TEXT = 200;

/**
 * A total migration chain for one document type: version 1 up to `currentVersion`, a frozen schema
 * for each version and a pure `n → n+1` step between each pair. Built with {@link migrationChain}.
 */
export interface Migrator<T> {
  readonly document: string;
  readonly versionKey: string;
  readonly currentVersion: number;
  /** The frozen schema for `version`, or `undefined` if this build doesn't know it. */
  schemaFor(version: number): z.ZodType | undefined;
  /**
   * Validates untrusted input (for example `JSON.parse` output) at its own version, migrates it step
   * by step to `currentVersion`, validating after each step. Never throws; never mutates `input`.
   */
  migrate(input: unknown): LoadResult<T>;
}

/** Builder that makes a migration chain total by construction: every version after 1 comes with its step. */
export interface MigrationChainBuilder<T> {
  /**
   * Appends the next version. `up` must be pure: same input → same output, and it must not mutate
   * its argument (it receives a freshly parsed copy, but tests deep-freeze it to prove purity).
   */
  then<N>(schema: z.ZodType<N>, up: (previous: T) => N): MigrationChainBuilder<N>;
  build(): Migrator<T>;
}

type Step = (previous: unknown) => unknown;

/** Starts a chain at version 1. */
export function migrationChain<T>(document: string, versionKey: string, v1: z.ZodType<T>): MigrationChainBuilder<T> {
  return builder<T>(document, versionKey, [v1], []);
}

function builder<T>(
  document: string,
  versionKey: string,
  schemas: readonly z.ZodType[],
  steps: readonly Step[],
): MigrationChainBuilder<T> {
  return {
    then<N>(schema: z.ZodType<N>, up: (previous: T) => N) {
      return builder<N>(document, versionKey, [...schemas, schema], [...steps, up as Step]);
    },
    build() {
      return createMigrator<T>(document, versionKey, schemas, steps);
    },
  };
}

function createMigrator<T>(
  document: string,
  versionKey: string,
  schemas: readonly z.ZodType[],
  steps: readonly Step[],
): Migrator<T> {
  const currentVersion = schemas.length;
  const fail = (error: LoadError): LoadResult<T> => ({ ok: false, error });

  return {
    document,
    versionKey,
    currentVersion,
    schemaFor(version) {
      return Number.isInteger(version) && version >= 1 ? schemas[version - 1] : undefined;
    },
    migrate(input) {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return fail({ kind: 'not-an-object', document, message: `The ${document} is not a JSON object.` });
      }
      if (jsonDepth(input, MAX_DOCUMENT_DEPTH) > MAX_DOCUMENT_DEPTH) {
        return fail({
          kind: 'too-deep',
          document,
          limit: MAX_DOCUMENT_DEPTH,
          message: `The ${document} is nested deeper than ${MAX_DOCUMENT_DEPTH} levels.`,
        });
      }
      const found = (input as Record<string, unknown>)[versionKey];
      if (typeof found !== 'number' || !Number.isSafeInteger(found)) {
        return fail({
          kind: 'missing-version',
          document,
          versionKey,
          message: `The ${document} has no valid integer "${versionKey}".`,
        });
      }
      if (found > currentVersion) {
        return fail({
          kind: 'newer-than-build',
          document,
          found,
          supported: currentVersion,
          message: `This ${document} was written by a newer version of Controls (${versionKey} ${found}; this build reads up to ${currentVersion}). Update the game to open it.`,
        });
      }
      if (found < 1) {
        return fail({
          kind: 'unsupported-version',
          document,
          found,
          oldest: 1,
          message: `The ${document} has an unknown ${versionKey} ${found}.`,
        });
      }

      const protoPath = findProtoKey(input);
      if (protoPath !== null) {
        return fail({
          kind: 'invalid',
          document,
          version: found,
          issues: [{ path: clip(protoPath), message: 'The key "__proto__" is not allowed' }],
          message: `The ${document} is not a valid ${versionKey} ${found} document.`,
        });
      }

      const first = safeParse(schemas[found - 1], input);
      if (!first.ok) {
        return fail({
          kind: 'invalid',
          document,
          version: found,
          issues: first.issues,
          message: `The ${document} is not a valid ${versionKey} ${found} document.`,
        });
      }

      let value = first.value;
      for (let version = found; version < currentVersion; version++) {
        const failed = (issues: readonly ValidationIssue[]) =>
          fail({
            kind: 'migration-failed',
            document,
            from: version,
            to: version + 1,
            issues,
            message: `Upgrading the ${document} from ${versionKey} ${version} to ${version + 1} failed.`,
          });
        let migrated: unknown;
        try {
          migrated = steps[version - 1](value);
        } catch (error) {
          return failed([{ path: '(root)', message: clip(`Migration threw ${describeThrown(error)}`) }]);
        }
        const next = safeParse(schemas[version], migrated);
        if (!next.ok) return failed(next.issues);
        value = next.value;
      }
      return { ok: true, value: value as T, fromVersion: found };
    },
  };
}

type ParseOutcome = { ok: true; value: unknown } | { ok: false; issues: readonly ValidationIssue[] };

function safeParse(schema: z.ZodType, input: unknown): ParseOutcome {
  try {
    const result = schema.safeParse(input);
    if (result.success) return { ok: true, value: result.data };
    return { ok: false, issues: summariseIssues(result.error.issues) };
  } catch (error) {
    return { ok: false, issues: [{ path: '(root)', message: clip(`Validation threw ${describeThrown(error)}`) }] };
  }
}

/** Converts Zod issues to bounded, value-free {@link ValidationIssue}s. */
export function summariseIssues(issues: readonly z.core.$ZodIssue[]): ValidationIssue[] {
  return issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
    path: clip(formatPath(issue.path)),
    message: clip(issue.message),
  }));
}

/** `['entities', 3, 'id']` → `entities[3].id`; the empty path is `(root)`. */
export function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  return path
    .map((key, index) => {
      if (typeof key === 'number') return `[${key}]`;
      const name = String(key);
      return index === 0 ? name : `.${name}`;
    })
    .join('');
}

function clip(text: string): string {
  return text.length <= MAX_ISSUE_TEXT ? text : `${text.slice(0, MAX_ISSUE_TEXT - 1)}…`;
}

function describeThrown(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'a non-Error value';
}
