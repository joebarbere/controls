import fc from 'fast-check';
import { assertNoNegativeZero, rawWorldV2Arb } from '../../testing/arbitraries';
import { createWorld, migrateWorld } from '../documents';
import { WorldV2 } from './world';

const Z = { yaw: 0, pitch: 0, roll: 0 };
const entity = (id: number, state: Record<string, unknown> = {}, sim: Record<string, unknown> = {}) => ({
  id,
  ref: { id: 'switch.tessaline-spst-toggle', version: 1 },
  transform: { positionMm: { x: 0, y: 0, z: 0 }, orientationMdeg: Z },
  state,
  sim,
  extensions: {},
});
const lead = (id: number, a: [number, string], b: [number, string]) => ({
  id,
  ref: { id: 'lead.quillfern-test-1m', version: 1 },
  a: { entity: a[0], terminal: a[1] },
  b: { entity: b[0], terminal: b[1] },
  extensions: {},
});
const solution = (overrides: Record<string, unknown> = {}) => ({
  lastSolveTick: 10,
  topologyHash: 'a'.repeat(64),
  nodes: [12, 0, 0, 0],
  branches: [0.5, 0],
  islands: [{ flags: 0, iterations: 1 }],
  ...overrides,
});

const world = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  seed: 42,
  tick: 15,
  nextEntityId: 3,
  nextConnectionId: 2,
  regionId: 'nec',
  difficulty: 'apprentice',
  assisted: false,
  fixtures: [],
  entities: [entity(1, { closed: true }), entity(2)],
  connections: [lead(1, [1, 'b'], [2, 'a'])],
  sim: solution(),
  extensions: {},
  ...overrides,
});

const issuesOf = (input: unknown) => {
  const result = WorldV2.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe('WorldV2', () => {
  it('accepts a world with device state, a connection and a solution record', () => {
    expect(WorldV2.parse(world())).toStrictEqual(world());
    expect(issuesOf(world({ sim: null }))).toStrictEqual([]);
  });

  it('createWorld builds an empty, never-solved world', () => {
    expect(createWorld({ seed: 7 })).toStrictEqual(
      world({ seed: 7, tick: 0, nextEntityId: 1, nextConnectionId: 1, entities: [], connections: [], sim: null }),
    );
    expect(createWorld({ seed: 0, difficulty: 'realistic', regionId: 'nec' }).difficulty).toBe('realistic');
    expect(() => createWorld({ seed: 2 ** 32 })).toThrow();
    expect(() => createWorld({ seed: -1 })).toThrow();
  });

  it('keeps v1’s rules for entities and fixtures', () => {
    expect(issuesOf(world({ entities: [entity(2), entity(1)] }))).toContain(
      'Entity ids must be unique and sorted in ascending order',
    );
    expect(issuesOf(world({ nextEntityId: 2 }))).toContain('Entity id must be below nextEntityId');
    const fixture = (id: string) => ({
      id,
      ref: { id: 'prop.bench', version: 1 },
      transform: entity(1).transform,
      extensions: {},
    });
    expect(issuesOf(world({ fixtures: [fixture('b'), fixture('a')] }))).toContain(
      'Fixture ids must be unique and sorted in ascending order',
    );
  });

  it('state bags hold named finite numbers, booleans, short strings or null, under lower camelCase keys', () => {
    expect(
      issuesOf(world({ entities: [entity(1, { closed: true, mode: 'cv', soc: 0.5, last: null }), entity(2)] })),
    ).toStrictEqual([]);
    for (const bad of [{ Closed: true }, { 'closed-1': true }, { closed: [true] }, { mode: 'x'.repeat(33) }]) {
      expect(issuesOf(world({ entities: [entity(1, bad), entity(2)] })), JSON.stringify(bad)).not.toHaveLength(0);
    }
    expect(issuesOf(world({ entities: [entity(1, {}, { soc: Number.NaN }), entity(2)] }))).not.toHaveLength(0);
    const missingBag: Record<string, unknown> = entity(1);
    delete missingBag['sim'];
    expect(issuesOf(world({ entities: [missingBag, entity(2)] }))).not.toHaveLength(0);
  });

  it('requires connection ids sorted, unique and below nextConnectionId', () => {
    const two = [lead(1, [1, 'a'], [2, 'a']), lead(2, [1, 'b'], [2, 'b'])];
    expect(issuesOf(world({ connections: two, nextConnectionId: 3 }))).toStrictEqual([]);
    expect(issuesOf(world({ connections: [...two].reverse(), nextConnectionId: 3 }))).toContain(
      'Connection ids must be unique and sorted in ascending order',
    );
    expect(issuesOf(world({ connections: two, nextConnectionId: 2 }))).toContain(
      'Connection id must be below nextConnectionId',
    );
    expect(issuesOf(world({ nextConnectionId: 0 }))).not.toHaveLength(0);
  });

  it('a connection joins two different terminals of entities that exist (nothing dangles)', () => {
    expect(issuesOf(world({ connections: [lead(1, [1, 'a'], [9, 'a'])] }))).toContain(
      'A connection must join entities that exist',
    );
    expect(issuesOf(world({ connections: [lead(1, [1, 'a'], [1, 'a'])] }))).toContain(
      'A connection must join two different terminals',
    );
    // Two terminals of one entity is fine (a jumper across a switch).
    expect(issuesOf(world({ connections: [lead(1, [1, 'a'], [1, 'b'])] }))).toStrictEqual([]);
    expect(issuesOf(world({ connections: [lead(1, [1, 'a:1'], [2, 'a'])] }))).not.toHaveLength(0);
  });

  it('the solution record is never after the world’s tick and holds re, im pairs', () => {
    expect(issuesOf(world({ sim: solution({ lastSolveTick: 16 }) }))).toContain('lastSolveTick must not be after tick');
    expect(issuesOf(world({ sim: solution({ nodes: [1, 0, 2] }) }))).toContain('nodes holds re, im pairs');
    expect(issuesOf(world({ sim: solution({ branches: [1] }) }))).toContain('branches holds re, im pairs');
    expect(issuesOf(world({ sim: solution({ topologyHash: 'A'.repeat(64) }) }))).not.toHaveLength(0);
    expect(issuesOf(world({ sim: solution({ islands: [{ flags: 256, iterations: 0 }] }) }))).not.toHaveLength(0);
    expect(issuesOf(world({ sim: solution({ nodes: [Number.POSITIVE_INFINITY, 0] }) }))).not.toHaveLength(0);
  });

  it('has no optional fields and refuses unknown keys', () => {
    for (const key of Object.keys(world())) {
      const partial: Record<string, unknown> = world();
      delete partial[key];
      expect(issuesOf(partial), key).not.toHaveLength(0);
    }
    expect(issuesOf(world({ wires: [] }))).not.toHaveLength(0);
    expect(issuesOf(world({ connections: [{ ...lead(1, [1, 'a'], [2, 'a']), gauge: 14 }] }))).not.toHaveLength(0);
    expect(issuesOf(world({ sim: { ...solution(), solveMs: 1.5 } }))).not.toHaveLength(0);
  });

  it('round-trips any valid world losslessly through JSON (property)', () => {
    fc.assert(
      fc.property(rawWorldV2Arb, (raw) => {
        const w = WorldV2.parse(raw);
        assertNoNegativeZero(w);
        const text = JSON.stringify(w);
        const again = WorldV2.parse(JSON.parse(text));
        expect(again).toStrictEqual(w);
        expect(JSON.stringify(again)).toBe(text);
        expect(WorldV2.parse(w)).toStrictEqual(w);
        expect(migrateWorld(JSON.parse(text))).toStrictEqual({ ok: true, value: w, fromVersion: 2 });
      }),
    );
  });

  it('sim numbers survive JSON bit for bit: identical under Object.is (ADR 0011 §9.6, property)', () => {
    const numbersOf = (w: WorldV2) => [
      ...w.entities.flatMap((e) => [...Object.values(e.state), ...Object.values(e.sim)]),
      ...(w.sim === null ? [] : [...w.sim.nodes, ...w.sim.branches]),
    ];
    fc.assert(
      fc.property(rawWorldV2Arb, (raw) => {
        const w = WorldV2.parse(raw);
        const again = WorldV2.parse(JSON.parse(JSON.stringify(w)));
        const before = numbersOf(w);
        const after = numbersOf(again);
        expect(after).toHaveLength(before.length);
        before.forEach((value, index) => expect(Object.is(after[index], value), String(value)).toBe(true));
      }),
    );
    // The edges, explicitly: -0 is normalised to +0 at parse, subnormals and 17-digit floats survive.
    const edge = WorldV2.parse(world({ sim: solution({ nodes: [-0, 5e-324, 0.1 + 0.2, -1.7976931348623157e308] }) }));
    const nodes = WorldV2.parse(JSON.parse(JSON.stringify(edge))).sim?.nodes ?? [];
    expect(Object.is(nodes[0], 0)).toBe(true);
    expect(nodes.slice(1)).toStrictEqual([5e-324, 0.30000000000000004, -1.7976931348623157e308]);
  });
});
