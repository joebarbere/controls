import { createWorld, migrateWorld, World } from '@controls/save-format';
import { rawWorldV2Arb } from '@controls/save-format/testing';
import fc from 'fast-check';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson, CanonicalJsonError, hashWorldDocument, worldHash } from './hash';
import { createWorldBus } from './session';

const workshopJson = (): unknown =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../content/levels/workshop.json'), 'utf8'));

function workshop(): World {
  const loaded = migrateWorld(workshopJson());
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
}

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, `../../../save-format/fixtures/v1/world/${name}.json`), 'utf8'));

/**
 * An independent canonical form: JSON.stringify for scalars, members joined by hand in code-unit
 * order (an explicit comparator). It must not rebuild objects and re-stringify them: JavaScript
 * lists integer-like keys ("0", "12") before all others whatever the insertion order, so a rebuilt
 * object can't hold `{"": …, "0": …}` in code-unit order.
 */
function referenceCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(referenceCanonical).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  const byCodeUnits = ([a]: [string, unknown], [b]: [string, unknown]): number => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const d = a.charCodeAt(i) - b.charCodeAt(i);
      if (d !== 0) return d;
    }
    return a.length - b.length;
  };
  const members = Object.entries(value).sort(byCodeUnits);
  return `{${members.map(([k, v]) => `${JSON.stringify(k)}:${referenceCanonical(v)}`).join(',')}}`;
}

const referenceHash = (value: unknown) => createHash('sha256').update(referenceCanonical(value), 'utf8').digest('hex');

describe('canonicalJson', () => {
  it('sorts keys recursively, keeps array order and adds no whitespace', () => {
    expect(canonicalJson({ b: [3, { z: 1, a: 2 }], a: null, c: { y: true, x: 'é' } })).toBe(
      '{"a":null,"b":[3,{"a":2,"z":1}],"c":{"x":"é","y":true}}',
    );
  });

  it('sorts by UTF-16 code units, not code points or locale', () => {
    // U+FF5E (one unit 0xFF5E) sorts after U+1F600 (units 0xD83D 0xDE00), unlike code-point order.
    expect(canonicalJson({ '～': 1, '😀': 2, Z: 3, a: 4, é: 5 })).toBe('{"Z":3,"a":4,"é":5,"😀":2,"～":1}');
    // Integer-like keys too, which JavaScript itself always lists first.
    expect(canonicalJson({ '0': {}, '': null, '10': 1, '9': 2 })).toBe('{"":null,"0":{},"10":1,"9":2}');
  });

  it('formats numbers and strings exactly as JSON.stringify', () => {
    expect(canonicalJson([-0, 1e21, 1e-7, 6.02e23, 0.1, -1.5, 2 ** 53])).toBe(
      '[0,1e+21,1e-7,6.02e+23,0.1,-1.5,9007199254740992]',
    );
    expect(canonicalJson('quote " slash \\ newline \n tab \t nul \u0000 lone \uD800')).toBe(
      JSON.stringify('quote " slash \\ newline \n tab \t nul \u0000 lone \uD800'),
    );
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(Object.create(null) as object)).toBe('{}');
  });

  it.each([
    ['NaN', Number.NaN, 'Non-finite number NaN'],
    ['Infinity', [Number.POSITIVE_INFINITY], 'Non-finite number Infinity'],
    ['undefined', { a: undefined }, 'Not a JSON value (undefined)'],
    ['a function', () => 1, 'Not a JSON value (function)'],
    ['a bigint', 1n, 'Not a JSON value (bigint)'],
    ['a symbol', Symbol('x'), 'Not a JSON value (symbol)'],
    ['a Map', new Map(), 'Not a plain object'],
    ['a class instance', new (class Point {})(), 'Not a plain object'],
  ])('refuses %s instead of rewriting it', (_name, value, message) => {
    expect(() => canonicalJson(value)).toThrow(new CanonicalJsonError(message));
  });

  it('agrees with the reference canonicaliser on any valid world', () => {
    fc.assert(
      fc.property(rawWorldV2Arb, (raw) => {
        const world = World.parse(raw);
        expect(canonicalJson(world)).toBe(referenceCanonical(world));
      }),
    );
  });
});

describe('world.hash', () => {
  it('is SHA-256 of the canonical JSON, as lower-case hex, for any valid world', () => {
    fc.assert(
      fc.property(rawWorldV2Arb, (raw) => {
        const world = World.parse(raw);
        const hash = worldHash(world);
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(hash).toBe(referenceHash(world));
      }),
      { numRuns: 50 },
    );
  });

  it('does not depend on key order', () => {
    const world = createWorld({ seed: 5 });
    const reversed = Object.fromEntries(Object.entries(world).reverse()) as typeof world;
    expect(worldHash(reversed)).toBe(worldHash(world));
  });

  it('changes when any field changes', () => {
    const world = createWorld({ seed: 5 });
    expect(worldHash({ ...world, seed: 6 })).not.toBe(worldHash(world));
    expect(worldHash({ ...world, assisted: true })).not.toBe(worldHash(world));
  });

  it('hashes untrusted JSON only after validating and migrating it', () => {
    const result = hashWorldDocument(fixture('props-and-extensions'));
    expect(result.ok && result.world.entities.map((e) => e.id)).toEqual([1, 2, 4]);
    expect(hashWorldDocument({ schemaVersion: 99 })).toMatchObject({ ok: false, error: { kind: 'newer-than-build' } });
    expect(hashWorldDocument('nope')).toMatchObject({ ok: false, error: { kind: 'not-an-object' } });
  });
});

/*
 * Cross-runtime golden values. `apps/game-e2e/src/world-hash.spec.ts` asserts the SAME literals from
 * the bundled game running in Chromium (through the `?e2e=1` session hook), so together the two
 * tests prove the hash is identical in Node and Chromium. Change both or neither.
 */
const GOLDEN = {
  emptySeed0: '2c6dc51770228d8fc23d1c82c0eaafef8caff86c0f7672e32ab0b624a1db022c',
  propsAndExtensionsFixture: 'd66ea791bbf59a366bf4ff6f6aef2511fed79e17f91dc8fb8aea9f0e170241df',
  scenario: 'fc9fa3bd3bc63bc279ba43ce8f5af035f81535191c8e205fd40af23d460e22f9',
  /** `content/levels/workshop.json` (seed 0): New sandbox with seed 0 starts here (F1.9). */
  workshopSeed0: 'e79e76822ed39bdf3e033330dffbacd9115b9506ed40663e80c9fac8a0d3c174',
} as const;

/**
 * The scenario the e2e test runs through the session hook, from the world the game boots with: the
 * workshop level at seed 0 (`content/levels/workshop.json`, F1.9).
 */
const SCENARIO: ReadonlyArray<readonly [string, object]> = [
  ['entity.place', { ref: { id: 'prop.crate', version: 1 }, positionMm: { x: 100, y: 0, z: -200 } }],
  [
    'entity.place',
    {
      ref: { id: 'prop.spool', version: 1 },
      positionMm: { x: -450, y: 915, z: 30 },
      orientationMdeg: { yaw: 90000, pitch: 0, roll: 0 },
    },
  ],
  ['entity.move', { id: 1, positionMm: { x: 150, y: 0, z: -200 } }],
  ['entity.rotate', { id: 2, deltaMdeg: { yaw: -135000, pitch: 0, roll: 12345 } }],
  ['view.resetLayout', {}],
  ['entity.delete', { id: 1 }],
  ['edit.undo', {}],
  ['entity.place', { ref: { id: 'prop.box', version: 1 }, positionMm: { x: 0, y: 0, z: 0 } }],
];

describe('cross-runtime golden hashes (also asserted in Chromium)', () => {
  it('pins the empty seed-0 world and the props-and-extensions fixture', () => {
    expect(worldHash(createWorld({ seed: 0 }))).toBe(GOLDEN.emptySeed0);
    expect(hashWorldDocument(fixture('empty'))).toMatchObject({ ok: true, hash: GOLDEN.emptySeed0 });
    expect(hashWorldDocument(fixture('props-and-extensions'))).toMatchObject({
      ok: true,
      hash: GOLDEN.propsAndExtensionsFixture,
    });
  });

  it('pins the workshop level (also what `pnpm sim hash content/levels/workshop.json` prints)', () => {
    expect(hashWorldDocument(workshopJson())).toMatchObject({ ok: true, hash: GOLDEN.workshopSeed0 });
  });

  it('pins the scenario hash', () => {
    const bus = createWorldBus(workshop());
    for (const [id, args] of SCENARIO) expect(bus.exec(id, args)).toMatchObject({ ok: true });
    expect(worldHash(bus.state)).toBe(GOLDEN.scenario);
    expect(worldHash(bus.state)).toBe(referenceHash(bus.state));
  });
});
