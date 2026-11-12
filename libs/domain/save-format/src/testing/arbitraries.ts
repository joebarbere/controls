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

/** A raw manifest that `ManifestV3` accepts (v2's, at schemaVersion 3). */
export const rawManifestV3Arb = rawManifestV2Arb.map((v2) => ({ ...v2, schemaVersion: 3 as const }));

/*
 * World v3 (ADR 0015). Raw material is drawn first and then fixed up by plain functions into a valid
 * document (sorted ids, unique termination ids, rest waypoints, distinct consecutive points, tails
 * shorter than the cable), so every rule of `WorldV3` holds by construction while the values stay
 * arbitrary: -0, subnormals, 17-digit floats, every waypoint kind, nullable everything.
 */

/** Printable-ASCII label text, no leading or trailing space. */
export const labelTextArb = fc.stringMatching(/^[!-~](?:[ -~]{0,8}[!-~])?$/);
const colourIdArb = fc.constantFrom('bare', 'black', 'white', 'red', 'green', 'yellow', 'blue', 'grey');
/** A conductor colour; a stripe never equals its base. */
export const conductorColourArb = fc
  .tuple(colourIdArb, fc.option(colourIdArb, { nil: null }))
  .map(([base, stripe]) => ({ base, stripe: stripe === base ? null : stripe }));
const methodIdArb = fc.constantFrom('screw', 'springCage', 'backStab', 'twistOn');
const nonNegativeArb = fc.oneof(fc.double({ min: 0, max: 1e6, noNaN: true }), fc.constant(-0), fc.constant(5e-324));
const terminationBodyArb = fc.record({
  method: methodIdArb,
  auto: fc.boolean(),
  stripLengthMm: fc.oneof(fc.integer({ min: 0, max: 1000 }), fc.constant(-0)),
  nickedStrandFraction: unitArb,
  torqueNm: fc.option(nonNegativeArb, { nil: null }),
  accessory: fc.option(fc.record({ ref: catalogRefArb, crimpQuality: unitArb }), { nil: null }),
});
type TerminationBody = typeof terminationBodyArb extends fc.Arbitrary<infer T> ? T : never;
const endRawArb = fc.option(fc.record({ pick: fc.nat(), terminal: terminalIdArb, termination: terminationBodyArb }), {
  nil: null,
});
type EndRaw = typeof endRawArb extends fc.Arbitrary<infer T> ? T : never;
const positionArb = fc.record({ x: coordinateArb, y: coordinateArb, z: coordinateArb });
const waypointRawArb = fc.record({
  kind: fc.constantFrom('free', 'duct', 'conduit', 'staple', 'bore'),
  positionMm: positionArb,
  pick: fc.nat(),
  onFixture: fc.boolean(),
  tool: catalogRefArb,
});
type WaypointRaw = typeof waypointRawArb extends fc.Arbitrary<infer T> ? T : never;
const routeRawArb = fc.array(waypointRawArb, { maxLength: 5 });
const conductorRawArb = fc.record({
  ref: catalogRefArb,
  a: endRawArb,
  b: endRawArb,
  route: routeRawArb,
  lengthMm: fc.integer({ min: 1, max: 1_000_000 }),
  colour: conductorColourArb,
  label: fc.option(labelTextArb, { nil: null }),
  bags: bagPairArb,
  extensions: jsonObjectArb,
});
type ConductorRaw = typeof conductorRawArb extends fc.Arbitrary<infer T> ? T : never;
const cableEndRawArb = fc.option(fc.record({ pick: fc.nat(), entry: terminalIdArb }), { nil: null });
const cableRawArb = fc.record({
  ref: catalogRefArb,
  a: cableEndRawArb,
  b: cableEndRawArb,
  route: routeRawArb,
  extraMm: fc.integer({ min: 1, max: 100_000 }),
  tailsMm: fc.record({ a: fc.integer({ min: 0, max: 2000 }), b: fc.integer({ min: 0, max: 2000 }) }),
  strip: fc.record({ a: fc.nat(), b: fc.nat() }),
  label: fc.option(labelTextArb, { nil: null }),
  extensions: jsonObjectArb,
  conductors: fc.array(conductorRawArb, { minLength: 1, maxLength: 3 }),
});
type CableRaw = typeof cableRawArb extends fc.Arbitrary<infer T> ? T : never;
const mountRawArb = fc.option(fc.record({ pick: fc.nat(), mount: terminalIdArb }), { nil: null });

type Position = { x: number; y: number; z: number };
const samePosition = (p: Position, q: Position) => p.x === q.x && p.y === q.y && p.z === q.z;
/** A position next to `p`, never equal to it (inside the ±10 km bound). */
const nudge = (p: Position): Position => ({ ...p, x: p.x >= MAX_COORDINATE_MM ? p.x - 1 : p.x + 1 });

/** A valid route from raw waypoints: hosts that exist, rest waypoints for free ends, distinct neighbours, ≥ 2 points. */
function buildRoute(
  raws: readonly WaypointRaw[],
  ends: { a: boolean; b: boolean },
  entityIds: readonly number[],
  fixtureIds: readonly string[],
) {
  const route = raws.map((raw) => {
    const useFixture = (raw.onFixture || entityIds.length === 0) && fixtureIds.length > 0;
    const kind = raw.kind !== 'free' && entityIds.length === 0 && fixtureIds.length === 0 ? 'free' : raw.kind;
    return {
      kind,
      positionMm: raw.positionMm,
      entity: kind === 'free' || useFixture ? null : entityIds[raw.pick % entityIds.length],
      fixture: kind !== 'free' && useFixture ? fixtureIds[raw.pick % fixtureIds.length] : null,
      tool: kind === 'bore' ? raw.tool : null,
    };
  });
  const free = (positionMm: Position) => ({
    kind: 'free' as const,
    positionMm,
    entity: null,
    fixture: null,
    tool: null,
  });
  if (!ends.a && route[0]?.kind !== 'free') route.unshift(free(route[0]?.positionMm ?? { x: 0, y: 0, z: 0 }));
  if (!ends.b && route.at(-1)?.kind !== 'free') route.push(free(route.at(-1)?.positionMm ?? { x: 0, y: 0, z: 0 }));
  while (route.length + (ends.a ? 1 : 0) + (ends.b ? 1 : 0) < 2) route.push(free({ x: 0, y: 0, z: 0 }));
  for (let i = 1; i < route.length; i++) {
    if (samePosition(route[i - 1].positionMm, route[i].positionMm)) {
      route[i] = { ...route[i], positionMm: nudge(route[i - 1].positionMm) };
    }
  }
  return route;
}

/**
 * A raw world document that `WorldV3` accepts: v2's world (its connections as test leads) plus mounted
 * and labelled entities, conductors with their own routes and terminations, and cables with their
 * conductors, landed, half-landed or free.
 */
export const rawWorldV3Arb = rawWorldV2Arb
  .chain((v2) =>
    fc.record({
      v2: fc.constant(v2),
      mounts: fc.array(mountRawArb, { minLength: v2.entities.length, maxLength: v2.entities.length }),
      labels: fc.array(fc.option(labelTextArb, { nil: null }), {
        minLength: v2.entities.length,
        maxLength: v2.entities.length,
      }),
      leadBags: fc.array(bagPairArb, { minLength: v2.connections.length, maxLength: v2.connections.length }),
      conductors: fc.array(conductorRawArb, { maxLength: 3 }),
      cables: fc.array(cableRawArb, { maxLength: 2 }),
      gaps: fc.tuple(fc.nat({ max: 3 }), fc.nat({ max: 3 }), fc.nat({ max: 3 })),
    }),
  )
  .map(({ v2, mounts, labels, leadBags, conductors, cables, gaps }) => {
    const v2Entities = v2.entities as readonly (typeof v2.entities)[number][];
    const entityIds = v2Entities.map((e) => e.id);
    const fixtureIds = (v2.fixtures as readonly { id: string }[]).map((f) => f.id);
    let nextTermination = 1;
    const termination = (body: TerminationBody) => ({ id: nextTermination++, ...body });
    const end = (raw: EndRaw) =>
      raw === null || entityIds.length === 0
        ? null
        : {
            entity: entityIds[raw.pick % entityIds.length],
            terminal: raw.terminal,
            termination: termination(raw.termination),
          };
    const conductor = (raw: ConductorRaw, cable: { id: number; conductor: number; lengthMm: number } | null) => {
      const a = end(raw.a);
      let b = end(raw.b);
      if (a !== null && b !== null && a.entity === b.entity && a.terminal === b.terminal) {
        b = { ...b, terminal: `${b.terminal}x` };
      }
      return {
        ref: raw.ref,
        a,
        b,
        cable: cable === null ? null : { id: cable.id, conductor: cable.conductor },
        route: cable === null ? buildRoute(raw.route, { a: a !== null, b: b !== null }, entityIds, fixtureIds) : null,
        lengthMm: cable === null ? raw.lengthMm : cable.lengthMm,
        colour: raw.colour,
        label: raw.label,
        state: raw.bags[0],
        sim: raw.bags[1],
        extensions: raw.extensions,
      };
    };
    const leads = (v2.connections as readonly (typeof v2.connections)[number][]).map((c, index) => ({
      ref: c.ref,
      a: { ...c.a, termination: null },
      b: { ...c.b, termination: null },
      cable: null,
      route: null,
      lengthMm: null,
      colour: null,
      label: null,
      state: leadBags[index][0],
      sim: leadBags[index][1],
      extensions: c.extensions,
    }));
    const single = conductors.map((raw) => conductor(raw, null));
    const cableEnd = (raw: CableRaw['a']) =>
      raw === null || entityIds.length === 0
        ? null
        : { entity: entityIds[raw.pick % entityIds.length], entry: raw.entry };
    const builtCables = cables.map((raw: CableRaw, index) => {
      const id = index + 1;
      const a = cableEnd(raw.a);
      let b = cableEnd(raw.b);
      if (a !== null && b !== null && a.entity === b.entity && a.entry === b.entry) b = { ...b, entry: `${b.entry}x` };
      const lengthMm = raw.tailsMm.a + raw.tailsMm.b + raw.extraMm;
      return {
        cable: {
          id,
          ref: raw.ref,
          a,
          b,
          route: buildRoute(raw.route, { a: a !== null, b: b !== null }, entityIds, fixtureIds),
          lengthMm,
          tailsMm: raw.tailsMm,
          jacketStripMm: { a: raw.strip.a % (raw.tailsMm.a + 1), b: raw.strip.b % (raw.tailsMm.b + 1) },
          label: raw.label,
          extensions: raw.extensions,
        },
        conductors: raw.conductors.map((c, i) => conductor(c, { id, conductor: i, lengthMm })),
      };
    });
    const connections = [...leads, ...single, ...builtCables.flatMap((c) => c.conductors)].map((c, index) => ({
      id: index + 1,
      ...c,
    }));
    return {
      ...v2,
      schemaVersion: 3 as const,
      nextConnectionId: connections.length + 1 + gaps[0],
      nextCableId: builtCables.length + 1 + gaps[1],
      nextTerminationId: nextTermination + gaps[2],
      entities: v2Entities.map((entity, index) => {
        const mount = mounts[index];
        return {
          ...entity,
          // Only on an entity earlier in the list, so mounting never forms a cycle.
          mountedOn:
            mount === null || index === 0 ? null : { entity: entityIds[mount.pick % index], mount: mount.mount },
          label: labels[index],
        };
      }),
      connections,
      cables: builtCables.map((c) => c.cable),
    };
  });

/** A raw replay log that `ReplayLogV3` accepts. */
export const rawReplayLogV3Arb = fc
  .record({
    initialWorld: rawWorldV3Arb,
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
    return { schemaVersion: 3 as const, initialWorld, firstSeq, entries, endTick: tick + tail };
  });

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
