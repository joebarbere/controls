import fc from 'fast-check';
import { isWellFormed, type JsonValue } from '../lib/primitives';
import { MAX_COORDINATE_MM, MILLIDEGREES_PER_TURN } from '../lib/v1/world';

// `@controls/save-format/testing` points at this file; the raw ZIP builder rides along.
export * from './zip-builder';

/*
 * fast-check arbitraries producing *raw* documents that the v1 and v2 schemas accept. Raw on purpose: they
 * include `-0`, which the schemas normalise, so properties exercise the normalisation too.
 * Test-only (excluded from tsconfig.lib.json).
 */

/** Any well-formed string (full Unicode, including astral code points and combining marks). */
export const safeStringArb = fc
  .oneof(fc.string({ unit: 'grapheme', maxLength: 8 }), fc.string({ unit: 'binary', maxLength: 8 }))
  .filter(isWellFormed);

export const jsonKeyArb = safeStringArb.filter((key) => key !== '__proto__');

/** Finite numbers, including `-0`, tiny subnormals and huge magnitudes. */
export const finiteNumberArb = fc.oneof(
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.integer(),
  fc.constant(-0),
);

export const jsonValueArb: fc.Arbitrary<JsonValue> = fc.letrec<{ value: JsonValue }>((tie) => ({
  value: fc.oneof(
    { maxDepth: 4, depthSize: 'small' },
    safeStringArb,
    finiteNumberArb,
    fc.boolean(),
    fc.constant(null),
    fc.array(tie('value'), { maxLength: 3 }),
    fc.dictionary(jsonKeyArb, tie('value'), { maxKeys: 3, noNullPrototype: true }),
  ),
})).value;

export const jsonObjectArb = fc.dictionary(jsonKeyArb, jsonValueArb, { maxKeys: 4, noNullPrototype: true });

const segment = fc.stringMatching(/^[a-z][a-z0-9]{0,6}(?:-[a-z0-9]{1,4})?$/);
export const catalogRefArb = fc.record({
  id: fc.array(segment, { minLength: 2, maxLength: 3 }).map((parts) => parts.join('.')),
  version: fc.integer({ min: 1, max: 1000 }),
});

export const commandIdArb = fc
  .array(fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,8}$/), { minLength: 2, maxLength: 3 })
  .map((parts) => parts.join('.'));

const coordinateArb = fc.oneof(fc.integer({ min: -MAX_COORDINATE_MM, max: MAX_COORDINATE_MM }), fc.constant(-0));
const angleArb = fc.oneof(fc.integer({ min: 0, max: MILLIDEGREES_PER_TURN - 1 }), fc.constant(-0));

const transformArb = fc.record({
  positionMm: fc.record({ x: coordinateArb, y: coordinateArb, z: coordinateArb }),
  orientationMdeg: fc.record({ yaw: angleArb, pitch: angleArb, roll: angleArb }),
});

const entityArb = (id: number) =>
  fc.record({
    id: fc.constant(id),
    ref: catalogRefArb,
    transform: transformArb,
    extensions: jsonObjectArb,
  });

/** A fixture id: lower-case hyphenated words, never the reserved `entity-` prefix. */
export const fixtureIdArb = fc
  .stringMatching(/^[a-z][a-z0-9]{0,8}(?:-[a-z0-9]{1,4}){0,2}$/)
  .filter((id) => !id.startsWith('entity-'));

const fixtureArb = (id: string) =>
  fc.record({ id: fc.constant(id), ref: catalogRefArb, transform: transformArb, extensions: jsonObjectArb });

/** Code-unit order, the order `WorldV1` requires for fixture ids. */
const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A raw world document that `WorldV1` accepts. */
export const rawWorldV1Arb = fc
  .record({
    ids: fc.uniqueArray(fc.integer({ min: 1, max: 1_000_000 }), { maxLength: 6 }),
    gap: fc.nat({ max: 5 }),
    fixtureIds: fc.uniqueArray(fixtureIdArb, { maxLength: 4 }),
  })
  .chain(({ ids, gap, fixtureIds }) => {
    const sortedFixtures = [...fixtureIds].sort(byCodeUnits);
    const sorted = [...ids].sort((a, b) => a - b);
    const nextEntityId = (sorted.at(-1) ?? 0) + 1 + gap;
    return fc.record({
      schemaVersion: fc.constant(1 as const),
      seed: fc.oneof(fc.integer({ min: 0, max: 0xffff_ffff }), fc.constant(-0)),
      tick: fc.oneof(fc.nat(), fc.constant(-0)),
      nextEntityId: fc.constant(nextEntityId),
      regionId: fc.constant('nec' as const),
      difficulty: fc.constantFrom('trainee', 'apprentice', 'journeyman', 'realistic'),
      assisted: fc.boolean(),
      fixtures: sortedFixtures.length === 0 ? fc.constant([]) : fc.tuple(...sortedFixtures.map(fixtureArb)),
      entities: sorted.length === 0 ? fc.constant([]) : fc.tuple(...sorted.map(entityArb)),
      extensions: jsonObjectArb,
    });
  });

/** A device state bag key (lower camelCase). */
export const stateKeyArb = fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,10}$/);

/** A device state value: finite numbers (including `-0`, subnormals, 17-digit floats), booleans, short strings, null. */
export const stateValueArb = fc.oneof(
  finiteNumberArb,
  fc.boolean(),
  safeStringArb.filter((s) => s.length <= 32),
  fc.constant(null),
);

export const stateBagArb = fc.dictionary(stateKeyArb, stateValueArb, { maxKeys: 4, noNullPrototype: true });

/** A terminal id (ASCII, never `:`). */
export const terminalIdArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,6}$/);

/*
 * Every arbitrary built from a constant is a module-level constant: building one (above all
 * `fc.stringMatching`, which compiles its regex, about 3 ms) inside a `.chain` body costs that for
 * every sample. Chain bodies build only what depends on the sample (lengths, `lastSolveTick`).
 */
const topologyHashArb = fc.stringMatching(/^[0-9a-f]{64}$/);
const reImPairsArb = fc
  .array(fc.tuple(finiteNumberArb, finiteNumberArb), { maxLength: 4 })
  .map((pairs) => pairs.flat());
const islandArb = fc.record({
  flags: fc.integer({ min: 0, max: 255 }),
  iterations: fc.integer({ min: 0, max: 65_535 }),
});

/** A raw `WorldV2.sim` solution record without its `lastSolveTick` (which depends on the world's tick), or null. */
const simSolutionBodyArb = fc.option(
  fc.record({
    topologyHash: topologyHashArb,
    nodes: reImPairsArb,
    branches: reImPairsArb,
    islands: fc.array(islandArb, { maxLength: 3 }),
  }),
  { nil: null },
);

/** A raw `WorldV2.sim` solution record (or null); `lastSolveTick` is at most `tick`. */
const simSolutionArb = (tick: number) =>
  fc
    .tuple(simSolutionBodyArb, fc.integer({ min: 0, max: tick }))
    .map(([body, lastSolveTick]) => (body === null ? null : { lastSolveTick, ...body }));

const v2TickArb = fc.integer({ min: 0, max: 2 ** 40 });
const bagPairArb = fc.tuple(stateBagArb, stateBagArb);
const connectionEndsArb = fc.tuple(fc.nat(), terminalIdArb, fc.nat(), terminalIdArb, catalogRefArb, jsonObjectArb);
type ConnectionEnds = typeof connectionEndsArb extends fc.Arbitrary<infer T> ? T : never;
const noEndsArb = fc.constant<ConnectionEnds[]>([]);
const someEndsArb = fc.array(connectionEndsArb, { maxLength: 4 });
const connectionGapArb = fc.nat({ max: 3 });

/**
 * A raw world document that `WorldV2` accepts: v1's world plus device state bags on every entity,
 * connections between distinct terminals of existing entities, the connection counter and a
 * solution record (or null). Ticks reach past 2^31.
 */
export const rawWorldV2Arb = rawWorldV1Arb
  .chain((v1) =>
    fc.record({
      v1: fc.constant(v1),
      tick: fc.oneof(fc.constant(v1.tick), v2TickArb),
      bags: fc.array(bagPairArb, { minLength: v1.entities.length, maxLength: v1.entities.length }),
      ends: v1.entities.length === 0 ? noEndsArb : someEndsArb,
      connectionGap: connectionGapArb,
    }),
  )
  .chain(({ v1, tick, bags, ends, connectionGap }) => {
    // `fc.constant([])` and the tuple arbitrary give a union of array types: widen it to one.
    const v1Entities = v1.entities as readonly (typeof v1.entities)[number][];
    const ids = v1Entities.map((e) => e.id);
    const connections = ends
      .map(([a, ta, b, tb, ref, extensions]) => ({
        ref,
        a: { entity: ids[a % ids.length], terminal: ta },
        b: { entity: ids[b % ids.length], terminal: tb },
        extensions,
      }))
      .filter((c) => c.a.entity !== c.b.entity || c.a.terminal !== c.b.terminal)
      .map((c, index) => ({ id: index + 1, ...c }));
    return fc.record({
      world: fc.constant({
        ...v1,
        schemaVersion: 2 as const,
        tick,
        nextConnectionId: connections.length + 1 + connectionGap,
        entities: v1Entities.map((entity, index) => ({ ...entity, state: bags[index][0], sim: bags[index][1] })),
        connections,
      }),
      sim: simSolutionArb(tick),
    });
  })
  .map(({ world, sim }) => ({ ...world, sim }));

/** A raw replay log that `ReplayLogV2` accepts: any `firstSeq`, and an `endTick` at or after the last entry. */
export const rawReplayLogV2Arb = fc
  .record({
    initialWorld: rawWorldV2Arb,
    firstSeq: fc.oneof(fc.constant(0), fc.nat({ max: 1_000_000 })),
    steps: fc.array(fc.record({ dt: fc.nat({ max: 3 }), id: commandIdArb, args: jsonObjectArb }), { maxLength: 6 }),
    tail: fc.nat({ max: 10_000 }),
  })
  .map(({ initialWorld, firstSeq, steps, tail }) => {
    let tick = initialWorld.tick;
    const entries = steps.map((step, index) => {
      tick += step.dt;
      return { seq: firstSeq + index, tick, id: step.id, args: step.args };
    });
    return { schemaVersion: 2 as const, initialWorld, firstSeq, entries, endTick: tick + tail };
  });

/** A raw replay log that `ReplayLogV1` accepts. */
export const rawReplayLogV1Arb = fc
  .record({
    initialWorld: rawWorldV1Arb,
    steps: fc.array(fc.record({ dt: fc.nat({ max: 3 }), id: commandIdArb, args: jsonObjectArb }), { maxLength: 6 }),
  })
  .map(({ initialWorld, steps }) => {
    let tick = initialWorld.tick;
    return {
      schemaVersion: 1 as const,
      initialWorld,
      entries: steps.map((step, seq) => {
        tick += step.dt;
        return { seq, tick, id: step.id, args: step.args };
      }),
    };
  });

const unitArb = fc.oneof(fc.double({ min: 0, max: 1, noNaN: true }), fc.constant(-0));

/** A raw settings document that `SettingsV1` accepts. */
export const rawSettingsV1Arb = fc.record({
  settingsVersion: fc.constant(1 as const),
  graphics: fc.record({
    backend: fc.constantFrom('auto', 'webgl2'),
    pixelRatioCap: fc.double({ min: 0.5, max: 4, noNaN: true }),
  }),
  audio: fc.record({ master: unitArb, effects: unitArb, ambience: unitArb, interface: unitArb }),
  controls: fc.record({
    lookSensitivity: fc.double({ min: 0.1, max: 10, noNaN: true }),
    invertY: fc.boolean(),
    keybindings: fc.dictionary(commandIdArb, fc.option(safeStringArb.filter((s) => s.length >= 1 && s.length <= 64)), {
      maxKeys: 4,
      noNullPrototype: true,
    }),
  }),
  palette: fc.record({ recents: fc.uniqueArray(commandIdArb, { maxLength: 20 }) }),
  console: fc.record({ history: fc.array(safeStringArb, { maxLength: 10 }) }),
  display: fc.record({
    units: fc.constantFrom('imperial', 'metric'),
    theme: fc.constantFrom('system', 'light', 'dark'),
    reducedMotion: fc.constantFrom('system', 'reduce', 'full'),
  }),
  gameplay: fc.record({
    defaultDifficulty: fc.constantFrom('trainee', 'apprentice', 'journeyman', 'realistic'),
    region: fc.constant('nec' as const),
  }),
  workspace: fc.record({ layout: jsonValueArb }),
  autosave: fc.record({
    enabled: fc.boolean(),
    slotCount: fc.integer({ min: 1, max: 10 }),
    intervalSeconds: fc.integer({ min: 60, max: 3600 }),
  }),
  toolBelt: fc.record({ slots: fc.array(fc.option(catalogRefArb), { minLength: 9, maxLength: 9 }) }),
  extensions: jsonObjectArb,
});

/** A raw settings document that `SettingsV2` accepts: v1's, plus a last-played pointer or none. */
export const rawSettingsV2Arb = fc
  .tuple(
    rawSettingsV1Arb,
    fc.option(
      fc.oneof(
        fc.record({
          kind: fc.constant('manual' as const),
          name: safeStringArb.filter((s) => s.length >= 1 && s.length <= 255),
        }),
        fc.record({ kind: fc.constant('autosave' as const), slot: fc.integer({ min: 1, max: 10 }) }),
      ),
    ),
  )
  .map(([v1, lastPlayed]) => ({ ...v1, settingsVersion: 2 as const, saves: { lastPlayed } }));

/** A raw manifest that `ManifestV1` accepts. */
export const rawManifestV1Arb = fc.record({
  format: fc.constant('controls.ctrl' as const),
  schemaVersion: fc.constant(1 as const),
  appVersion: fc
    .tuple(fc.nat({ max: 99 }), fc.nat({ max: 99 }), fc.nat({ max: 99 }), fc.constantFrom('', '-rc.1', '+build.7'))
    .map(([a, b, c, suffix]) => `${a}.${b}.${c}${suffix}`),
  catalogVersion: fc.oneof(fc.nat({ max: 1000 }), fc.constant(-0)),
  extensions: jsonObjectArb,
});

/** A raw manifest that `ManifestV2` accepts. */
export const rawManifestV2Arb = fc
  .tuple(rawManifestV1Arb, fc.oneof(fc.nat({ max: 1000 }), fc.constant(-0)))
  .map(([v1, simEngineVersion]) => ({ ...v1, schemaVersion: 2 as const, simEngineVersion }));

/** Bytes that start with the PNG signature (the container checks the signature, not the image). */
export const pngBytesArb = fc
  .uint8Array({ maxLength: 64 })
  .map((tail) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...tail]));

/** Throws if `value` contains `-0` anywhere (JSON would silently turn it into `0`). */
export function assertNoNegativeZero(value: unknown, path = '(root)'): void {
  if (Object.is(value, -0)) throw new Error(`-0 at ${path}`);
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) assertNoNegativeZero(child, `${path}.${key}`);
}

/** Recursively freezes `value` so a mutating migration throws in strict mode. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
