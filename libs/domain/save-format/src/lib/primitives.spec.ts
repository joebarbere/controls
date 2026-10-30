import fc from 'fast-check';
import { jsonValueArb } from '../testing/arbitraries';
import {
  boundedJsonValue,
  CatalogId,
  CatalogRef,
  CommandId,
  DeviceStateBag,
  DeviceStateKey,
  DeviceStateValue,
  Extensions,
  findProtoKey,
  FiniteNumber,
  Int,
  isBuiltinPropRef,
  isWellFormed,
  jsonDepth,
  JsonKey,
  JsonValue,
  MAX_DEVICE_STATE_KEYS,
  MAX_JSON_VALUE_DEPTH,
  normaliseZero,
  SafeString,
  SemVer,
  TerminalId,
} from './primitives';

function nest(depth: number): unknown {
  let value: unknown = 0;
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

describe('number primitives', () => {
  it('normalises -0 to 0 and leaves other numbers alone', () => {
    expect(Object.is(normaliseZero(-0), 0)).toBe(true);
    expect(normaliseZero(-1.5)).toBe(-1.5);
    expect(Object.is(Int.parse(-0), 0)).toBe(true);
    expect(Object.is(FiniteNumber.parse(-0), 0)).toBe(true);
  });

  it('rejects NaN and ±Infinity', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(FiniteNumber.safeParse(bad).success).toBe(false);
      expect(Int.safeParse(bad).success).toBe(false);
      expect(JsonValue.safeParse(bad).success).toBe(false);
    }
  });

  it('Int requires a safe integer', () => {
    expect(Int.safeParse(1.5).success).toBe(false);
    expect(Int.safeParse(2 ** 53).success).toBe(false);
    expect(Int.safeParse(2 ** 53 - 1).success).toBe(true);
  });
});

describe('strings', () => {
  it('detects unpaired surrogates, which UTF-8 encoding would replace', () => {
    expect(isWellFormed('plain')).toBe(true);
    expect(isWellFormed('emoji \u{1F50C} and é')).toBe(true);
    expect(isWellFormed('lone high \uD83D')).toBe(false);
    expect(isWellFormed('lone low \uDE00')).toBe(false);
    expect(SafeString.safeParse('\uD800').success).toBe(false);
    expect(JsonValue.safeParse('\uDFFF').success).toBe(false);
  });

  it('documents the Zod gap: z.record silently drops an own "__proto__" key from JSON.parse', () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "kept": 1}');
    // This is why the loaders run findProtoKey first: the schema alone would lose the key.
    expect(Extensions.parse(parsed)).toStrictEqual({ kept: 1 });
    expect(JsonKey.safeParse('__proto__').success).toBe(true);
  });

  it('findProtoKey locates an own "__proto__" key at any depth', () => {
    expect(findProtoKey({ a: [1, { b: 'c' }], __notproto__: 1 })).toBeNull();
    expect(findProtoKey(JSON.parse('{"__proto__": 1}'))).toBe('__proto__');
    expect(findProtoKey(JSON.parse('{"a": [0, {"b": {"__proto__": {}}}]}'))).toBe('a[1].b.__proto__');
    expect(findProtoKey(JSON.parse('[{"__proto__": null}]'))).toBe('[0].__proto__');
    expect(findProtoKey('__proto__')).toBeNull();
    // An inherited __proto__ accessor (every plain object has one) is not an own key.
    expect(findProtoKey({})).toBeNull();
  });
});

describe('JsonValue', () => {
  it('accepts plain JSON', () => {
    const value = { a: [1, 'two', true, null, { b: -2.5e-300 }], c: {} };
    expect(JsonValue.parse(value)).toStrictEqual(value);
  });

  it('rejects values that JSON cannot represent losslessly', () => {
    class Point {
      x = 1;
    }
    // eslint-disable-next-line no-restricted-syntax -- a fixed epoch, not the wall clock: proves Date instances are refused.
    const epoch = new Date(0);
    const bad = [
      epoch,
      { at: new Point() },
      undefined,
      () => 1,
      Symbol('s'),
      10n,
      new Map([[1, 2]]),
      new Set([1]),
      [undefined],
      { a: undefined },
    ];
    for (const value of bad) expect(JsonValue.safeParse(value).success, String(typeof value)).toBe(false);
  });

  it('normalises -0 nested anywhere', () => {
    const parsed = JsonValue.parse({ a: [-0, { b: -0 }] }) as { a: [number, { b: number }] };
    expect(Object.is(parsed.a[0], 0)).toBe(true);
    expect(Object.is(parsed.a[1].b, 0)).toBe(true);
  });

  it('round-trips through JSON (property)', () => {
    fc.assert(
      fc.property(jsonValueArb, (raw) => {
        const value = JsonValue.parse(raw);
        expect(JsonValue.parse(JSON.parse(JSON.stringify(value)))).toStrictEqual(value);
      }),
    );
  });
});

describe('nesting limits', () => {
  it('measures depth iteratively', () => {
    expect(jsonDepth(1)).toBe(0);
    expect(jsonDepth(null)).toBe(0);
    expect(jsonDepth([])).toBe(1);
    expect(jsonDepth({ a: [1, { b: [] }] })).toBe(4);
    expect(jsonDepth(nest(100_000))).toBe(100_000);
  });

  it('stops early once the limit is exceeded', () => {
    expect(jsonDepth(nest(1000), 10)).toBe(11);
    expect(jsonDepth(nest(10), 10)).toBe(10);
  });

  it('bounds opaque bags at MAX_JSON_VALUE_DEPTH', () => {
    const bag = boundedJsonValue('test bag');
    expect(bag.safeParse(nest(MAX_JSON_VALUE_DEPTH)).success).toBe(true);
    const tooDeep = bag.safeParse(nest(MAX_JSON_VALUE_DEPTH + 1));
    expect(tooDeep.success).toBe(false);
    expect(tooDeep.error?.issues[0]?.message).toContain('test bag');
    expect(Extensions.safeParse({ deep: nest(MAX_JSON_VALUE_DEPTH - 1) }).success).toBe(true);
    expect(Extensions.safeParse({ deep: nest(MAX_JSON_VALUE_DEPTH) }).success).toBe(false);
  });
});

describe('identifiers', () => {
  it('catalogue ids are dotted kebab-case with at least two segments', () => {
    for (const ok of ['prop.crate', 'prop.wall-section', 'contactor.nema-size1', 'a.b.c']) {
      expect(CatalogId.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of [
      'crate',
      'Prop.crate',
      'prop..crate',
      'prop.crate-',
      'prop.-crate',
      '1prop.crate',
      'prop.cr ate',
    ]) {
      expect(CatalogId.safeParse(bad).success, bad).toBe(false);
    }
    expect(CatalogId.safeParse(`prop.${'a'.repeat(124)}`).success).toBe(false);
  });

  it('catalogue refs carry an integer version >= 1', () => {
    expect(CatalogRef.safeParse({ id: 'prop.box', version: 1 }).success).toBe(true);
    expect(CatalogRef.safeParse({ id: 'prop.box', version: 0 }).success).toBe(false);
    expect(CatalogRef.safeParse({ id: 'prop.box', version: 1.5 }).success).toBe(false);
    expect(CatalogRef.safeParse({ id: 'prop.box' }).success).toBe(false);
    expect(CatalogRef.safeParse({ id: 'prop.box', version: 1, inline: {} }).success).toBe(false);
  });

  it('recognises built-in prop refs (prop.* at version 1)', () => {
    expect(isBuiltinPropRef({ id: 'prop.crate', version: 1 })).toBe(true);
    expect(isBuiltinPropRef({ id: 'prop.crate', version: 2 })).toBe(false);
    expect(isBuiltinPropRef({ id: 'contactor.nema-size1', version: 1 })).toBe(false);
  });

  it('command ids are dotted camelCase segments', () => {
    for (const ok of ['entity.place', 'view.resetLayout', 'edit.undo', 'toolbelt.select', 'a.b.c']) {
      expect(CommandId.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['help', 'Entity.place', 'entity.Place', 'entity-place', 'entity.', '.place', 'entity.place!']) {
      expect(CommandId.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('app versions are SemVer', () => {
    for (const ok of ['0.1.0', '1.0.0-rc.1', '1.2.3+build.5']) expect(SemVer.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['1.0', 'v1.0.0', '1.0.0 ']) expect(SemVer.safeParse(bad).success, bad).toBe(false);
  });
});

describe('device state and terminals (world v2, ADR 0013)', () => {
  it('terminal ids are short ASCII words without ":"', () => {
    for (const ok of ['pos', 'neg', 'a', '13', 'L1', 'NO-1', 'x_2', 'A'.repeat(32)]) {
      expect(TerminalId.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['', '-a', '_a', 'a:b', 'a b', 'é', 'A'.repeat(33), '+']) {
      expect(TerminalId.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('state keys are lower camelCase, at most 64 characters', () => {
    for (const ok of ['closed', 'stateOfCharge', 'v2', 'a'.repeat(64)]) {
      expect(DeviceStateKey.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['', 'Closed', 'state_of_charge', 'state-of-charge', '2v', 'a'.repeat(65)]) {
      expect(DeviceStateKey.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('state values are finite numbers, booleans, short strings or null', () => {
    for (const ok of [0, -1.5, 5e-324, true, false, 'tripped', 'x'.repeat(32), null]) {
      expect(DeviceStateValue.safeParse(ok).success, String(ok)).toBe(true);
    }
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 'x'.repeat(33), '\uD800', {}, [], undefined]) {
      expect(DeviceStateValue.safeParse(bad).success, String(bad)).toBe(false);
    }
    expect(Object.is(DeviceStateValue.parse(-0), 0)).toBe(true);
  });

  it('a bag holds at most MAX_DEVICE_STATE_KEYS keys and refuses bad keys', () => {
    const full = Object.fromEntries(Array.from({ length: MAX_DEVICE_STATE_KEYS }, (_, i) => [`k${i}`, i]));
    expect(DeviceStateBag.safeParse(full).success).toBe(true);
    expect(DeviceStateBag.safeParse({ ...full, extra: 1 }).success).toBe(false);
    expect(DeviceStateBag.safeParse({ Bad: 1 }).success).toBe(false);
    expect(DeviceStateBag.safeParse({ closed: { nested: true } }).success).toBe(false);
    expect(DeviceStateBag.parse({ closed: true, soc: -0, mode: null })).toStrictEqual({
      closed: true,
      soc: 0,
      mode: null,
    });
  });
});
