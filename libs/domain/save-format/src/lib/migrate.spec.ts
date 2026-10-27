import fc from 'fast-check';
import { z } from 'zod';
import { deepFreeze, rawWorldV1Arb } from '../testing/arbitraries';
import { createWorld, CURRENT_SCHEMA_VERSION, worldMigrator } from './documents';
import {
  formatPath,
  type LoadError,
  type LoadResult,
  MAX_ISSUE_TEXT,
  MAX_REPORTED_ISSUES,
  migrationChain,
  summariseIssues,
} from './migrate';
import { Int, MAX_DOCUMENT_DEPTH } from './primitives';
import { EntityV1, WorldV1 } from './v1/world';

/*
 * Synthetic, test-only versions stacked on the real WorldV1 prove that chaining works before a real
 * v2 exists. They are never exported.
 *   v2: adds `gravityMmPerS2` (a new field with a value derived for old saves).
 *   v3: renames `assisted` to `cheatsUsed` and adds an entity `label`.
 */
const WorldV2Test = z.strictObject({
  ...WorldV1.shape,
  schemaVersion: z.literal(2),
  gravityMmPerS2: Int,
});
type WorldV2Test = z.infer<typeof WorldV2Test>;

const WorldV3Test = z.strictObject({
  ...WorldV2Test.omit({ assisted: true }).shape,
  schemaVersion: z.literal(3),
  cheatsUsed: z.boolean(),
  entities: z.array(z.strictObject({ ...EntityV1.shape, label: z.string() })),
});
type WorldV3Test = z.infer<typeof WorldV3Test>;

const v1ToV2 = (w: WorldV1): WorldV2Test => ({ ...w, schemaVersion: 2, gravityMmPerS2: 9807 });
const v2ToV3 = ({ assisted, ...rest }: WorldV2Test): WorldV3Test => ({
  ...rest,
  schemaVersion: 3,
  cheatsUsed: assisted,
  entities: rest.entities.map((e) => ({ ...e, label: `${e.ref.id}#${e.id}` })),
});

const chain = migrationChain('test world', 'schemaVersion', WorldV1)
  .then(WorldV2Test, v1ToV2)
  .then(WorldV3Test, v2ToV3)
  .build();

const placed = () =>
  WorldV1.parse({
    ...createWorld({ seed: 5 }),
    assisted: true,
    nextEntityId: 2,
    entities: [
      {
        id: 1,
        ref: { id: 'prop.crate', version: 1 },
        transform: { positionMm: { x: 1, y: 2, z: 3 }, orientationMdeg: { yaw: 90_000, pitch: 0, roll: 0 } },
        extensions: {},
      },
    ],
  });

function expectError(result: LoadResult<unknown>): LoadError {
  if (result.ok) throw new Error('expected a load error');
  return result.error;
}

describe('migration chain (synthetic test-only versions)', () => {
  it('migrates v1 → v2 → v3 step by step', () => {
    const result = chain.migrate(placed());
    expect(result.ok && result.fromVersion).toBe(1);
    expect(result.ok && result.value).toMatchObject({
      schemaVersion: 3,
      gravityMmPerS2: 9807,
      cheatsUsed: true,
      entities: [{ id: 1, label: 'prop.crate#1' }],
    });
    expect(result.ok && 'assisted' in result.value).toBe(false);
  });

  it('starts from any intermediate version and passes the current version through', () => {
    const v2 = v1ToV2(placed());
    const fromV2 = chain.migrate(v2);
    expect(fromV2.ok && fromV2.fromVersion).toBe(2);
    expect(fromV2.ok && fromV2.value).toStrictEqual(v2ToV3(v2));
    const v3 = v2ToV3(v2);
    expect(chain.migrate(v3)).toStrictEqual({ ok: true, value: v3, fromVersion: 3 });
  });

  it('is total: every known version has a schema and reaches the current version', () => {
    expect(chain.currentVersion).toBe(3);
    for (const version of [1, 2, 3]) expect(chain.schemaFor(version)).toBeDefined();
    for (const version of [0, 4, 1.5, Number.NaN]) expect(chain.schemaFor(version)).toBeUndefined();
  });

  it('migrations are pure: same input, same output, input not mutated (property)', () => {
    fc.assert(
      fc.property(rawWorldV1Arb, (raw) => {
        const input = deepFreeze(WorldV1.parse(raw));
        const snapshot = JSON.stringify(input);
        const first = chain.migrate(input);
        const second = chain.migrate(input);
        expect(first.ok).toBe(true);
        expect(second).toStrictEqual(first);
        expect(JSON.stringify(input)).toBe(snapshot);
      }),
      { numRuns: 50 },
    );
  });

  it('refuses a newer-than-build document with a typed error', () => {
    const error = expectError(chain.migrate({ ...placed(), schemaVersion: 4 }));
    expect(error).toMatchObject({ kind: 'newer-than-build', found: 4, supported: 3, document: 'test world' });
    expect(error.message).toContain('newer version of Controls');
  });

  it('reports a migration that throws or produces an invalid document', () => {
    const throwing = migrationChain('t', 'v', z.strictObject({ v: z.literal(1) }))
      .then(z.strictObject({ v: z.literal(2) }), () => {
        throw new TypeError('boom');
      })
      .build();
    expect(expectError(throwing.migrate({ v: 1 }))).toMatchObject({
      kind: 'migration-failed',
      from: 1,
      to: 2,
      issues: [{ path: '(root)', message: 'Migration threw TypeError: boom' }],
    });

    const notAnError = migrationChain('t', 'v', z.strictObject({ v: z.literal(1) }))
      .then(z.strictObject({ v: z.literal(2) }), () => {
        throw 'a string';
      })
      .build();
    expect(expectError(notAnError.migrate({ v: 1 }))).toMatchObject({
      issues: [{ message: 'Migration threw a non-Error value' }],
    });

    const wrong = migrationChain('t', 'v', z.strictObject({ v: z.literal(1) }))
      .then(z.strictObject({ v: z.literal(2) }), () => ({ v: 3 }) as unknown as { v: 2 })
      .build();
    expect(expectError(wrong.migrate({ v: 1 }))).toMatchObject({ kind: 'migration-failed', from: 1, to: 2 });
  });
});

describe('the real world chain', () => {
  it('is at CURRENT_SCHEMA_VERSION', () => {
    expect(worldMigrator.currentVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(worldMigrator.versionKey).toBe('schemaVersion');
  });

  it.each([
    ['null', null, 'not-an-object'],
    ['an array', [], 'not-an-object'],
    ['a string', '{}', 'not-an-object'],
    ['no version', {}, 'missing-version'],
    ['a string version', { schemaVersion: '1' }, 'missing-version'],
    ['a fractional version', { schemaVersion: 1.5 }, 'missing-version'],
    ['version 0', { schemaVersion: 0 }, 'unsupported-version'],
    ['a negative version', { schemaVersion: -3 }, 'unsupported-version'],
    ['a newer version', { schemaVersion: CURRENT_SCHEMA_VERSION + 1 }, 'newer-than-build'],
    ['an invalid v1 body', { schemaVersion: 1 }, 'invalid'],
  ])('rejects %s', (_label, input, kind) => {
    expect(expectError(worldMigrator.migrate(input)).kind).toBe(kind);
  });

  it('refuses hostile nesting before Zod recurses into it (no stack overflow)', () => {
    let deep: unknown = 0;
    for (let i = 0; i < 200_000; i++) deep = { d: deep };
    const error = expectError(worldMigrator.migrate({ ...createWorld({ seed: 1 }), extensions: { deep } }));
    expect(error).toMatchObject({ kind: 'too-deep', limit: MAX_DOCUMENT_DEPTH });
  });

  it('refuses an own "__proto__" key anywhere instead of letting z.record drop it', () => {
    const text = JSON.stringify(createWorld({ seed: 1 })).replace(
      '"extensions":{}',
      '"extensions":{"mod.a":{"__proto__":{"polluted":true}}}',
    );
    const error = expectError(worldMigrator.migrate(JSON.parse(text)));
    expect(error).toMatchObject({
      kind: 'invalid',
      version: 1,
      issues: [{ path: 'extensions.mod.a.__proto__', message: 'The key "__proto__" is not allowed' }],
    });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('error messages never echo the payload', () => {
    const huge = 'x'.repeat(100_000);
    const error = expectError(worldMigrator.migrate({ ...createWorld({ seed: 1 }), [huge]: huge }));
    expect(error.kind).toBe('invalid');
    expect(JSON.stringify(error).length).toBeLessThan(2000);
  });
});

describe('issue reporting', () => {
  it('caps the number of issues and their length', () => {
    const schema = z.array(z.string());
    const result = schema.safeParse(Array.from({ length: 50 }, (_, i) => i));
    const issues = summariseIssues(result.error?.issues ?? []);
    expect(issues).toHaveLength(MAX_REPORTED_ISSUES);
    expect(issues[0]).toStrictEqual({ path: '[0]', message: 'Invalid input: expected string, received number' });

    const long = z
      .string()
      .refine(() => false, { message: 'y'.repeat(1000) })
      .safeParse('');
    const [clipped] = summariseIssues(long.error?.issues ?? []);
    expect(clipped.message).toHaveLength(MAX_ISSUE_TEXT);
    expect(clipped.message.endsWith('…')).toBe(true);
  });

  it('formats paths', () => {
    expect(formatPath([])).toBe('(root)');
    expect(formatPath(['entities', 3, 'transform', 'positionMm', 'x'])).toBe('entities[3].transform.positionMm.x');
    expect(formatPath([0, 'a'])).toBe('[0].a');
    expect(formatPath([Symbol('s')])).toBe('Symbol(s)');
  });

  it('reports a schema that throws during validation as invalid', () => {
    const exploding = migrationChain(
      't',
      'v',
      z.strictObject({ v: z.literal(1) }).refine(() => {
        throw new RangeError('deep');
      }),
    ).build();
    expect(expectError(exploding.migrate({ v: 1 }))).toMatchObject({
      kind: 'invalid',
      issues: [{ path: '(root)', message: 'Validation threw RangeError: deep' }],
    });
  });
});
