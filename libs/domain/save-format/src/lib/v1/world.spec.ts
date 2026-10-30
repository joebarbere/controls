import fc from 'fast-check';
import { assertNoNegativeZero, rawWorldV1Arb } from '../../testing/arbitraries';
import { migrateWorld } from '../documents';
import { worldV1ToV2 } from '../v2/from-v1';
import { MAX_COORDINATE_MM, WorldV1 } from './world';

const crate = (id: number, x = 0) => ({
  id,
  ref: { id: 'prop.crate', version: 1 },
  transform: { positionMm: { x, y: 0, z: 0 }, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } },
  extensions: {},
});

const world = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  seed: 42,
  tick: 0,
  nextEntityId: 3,
  regionId: 'nec',
  difficulty: 'apprentice',
  assisted: false,
  fixtures: [],
  entities: [crate(1), crate(2, 500)],
  extensions: {},
  ...overrides,
});

const issuesOf = (input: unknown) => {
  const result = WorldV1.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe('WorldV1', () => {
  it('accepts a minimal world', () => {
    expect(WorldV1.parse(world())).toStrictEqual(world());
  });

  it('requires integer millimetres within ±10 km', () => {
    expect(issuesOf(world({ entities: [crate(1, 1.5)] }))).not.toHaveLength(0);
    expect(issuesOf(world({ entities: [crate(1, MAX_COORDINATE_MM)] }))).toHaveLength(0);
    expect(issuesOf(world({ entities: [crate(1, -MAX_COORDINATE_MM - 1)] }))).not.toHaveLength(0);
  });

  it('rejects NaN and ±Infinity anywhere', () => {
    expect(issuesOf(world({ tick: Number.NaN }))).not.toHaveLength(0);
    expect(issuesOf(world({ entities: [crate(1, Number.POSITIVE_INFINITY)] }))).not.toHaveLength(0);
    expect(issuesOf(world({ extensions: { gain: Number.NEGATIVE_INFINITY } }))).not.toHaveLength(0);
  });

  it('normalises -0 everywhere', () => {
    const raw = world({ seed: -0, entities: [crate(1, -0)], extensions: { k: [-0] } });
    const parsed = WorldV1.parse(raw);
    assertNoNegativeZero(parsed);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(raw));
  });

  it('keeps orientation angles in [0, 360000) millidegrees', () => {
    const rotated = (yaw: number) => {
      const entity = crate(1);
      entity.transform.orientationMdeg.yaw = yaw;
      return world({ entities: [entity], nextEntityId: 2 });
    };
    expect(issuesOf(rotated(359_999))).toHaveLength(0);
    expect(issuesOf(rotated(360_000))).not.toHaveLength(0);
    expect(issuesOf(rotated(-90_000))).not.toHaveLength(0);
    expect(issuesOf(rotated(90_000.5))).not.toHaveLength(0);
  });

  it('requires entity ids sorted, unique and below nextEntityId', () => {
    expect(issuesOf(world({ entities: [crate(2), crate(1)] }))).toContain(
      'Entity ids must be unique and sorted in ascending order',
    );
    expect(issuesOf(world({ entities: [crate(1), crate(1)] }))).toContain(
      'Entity ids must be unique and sorted in ascending order',
    );
    expect(issuesOf(world({ nextEntityId: 2 }))).toContain('Entity id must be below nextEntityId');
    expect(issuesOf(world({ entities: [crate(0)] }))).not.toHaveLength(0);
  });

  it('requires fixture ids sorted, unique, well-formed and outside the entity- prefix', () => {
    const fixture = (id: string) => ({ ...crate(1), id });
    expect(issuesOf(world({ fixtures: [fixture('backplate'), fixture('din-rail-1')] }))).toHaveLength(0);
    expect(issuesOf(world({ fixtures: [fixture('din-rail-1'), fixture('backplate')] }))).toContain(
      'Fixture ids must be unique and sorted in ascending order',
    );
    expect(issuesOf(world({ fixtures: [fixture('bench'), fixture('bench')] }))).toContain(
      'Fixture ids must be unique and sorted in ascending order',
    );
    // Code-unit order: '-' (U+002D) sorts before digits and letters.
    expect(issuesOf(world({ fixtures: [fixture('din-rail'), fixture('din-rail-1'), fixture('dinrail')] }))).toEqual([]);
    for (const bad of ['Bench', 'bench--1', '-bench', 'bench-', 'a'.repeat(65), 'stud wall', '']) {
      expect(issuesOf(world({ fixtures: [fixture(bad)] })), bad).not.toHaveLength(0);
    }
    expect(issuesOf(world({ fixtures: [fixture('entity-1')] }))).toContain(
      'Fixture ids may not start with "entity-" (reserved for entity view ids)',
    );
    const extra = { ...fixture('bench'), colour: 'red' };
    expect(issuesOf(world({ fixtures: [extra] }))).not.toHaveLength(0);
  });

  it('seeds are unsigned 32-bit integers', () => {
    expect(issuesOf(world({ seed: 0xffff_ffff }))).toHaveLength(0);
    expect(issuesOf(world({ seed: 2 ** 32 }))).not.toHaveLength(0);
    expect(issuesOf(world({ seed: -1 }))).not.toHaveLength(0);
  });

  it('has no optional fields: every field is required', () => {
    for (const key of Object.keys(world())) {
      const partial: Record<string, unknown> = world();
      delete partial[key];
      expect(issuesOf(partial), key).not.toHaveLength(0);
    }
    const entity: Record<string, unknown> = crate(1);
    delete entity['extensions'];
    expect(issuesOf(world({ entities: [entity], nextEntityId: 2 }))).not.toHaveLength(0);
  });

  it('rejects unknown keys instead of silently dropping them (unknown data belongs in extensions)', () => {
    expect(issuesOf(world({ cheats: true }))).not.toHaveLength(0);
    const entity = { ...crate(1), colour: 'red' };
    expect(issuesOf(world({ entities: [entity], nextEntityId: 2 }))).not.toHaveLength(0);
    expect(issuesOf(world({ regionId: 'iec' }))).not.toHaveLength(0);
    expect(issuesOf(world({ difficulty: 'easy' }))).not.toHaveLength(0);
  });

  it('round-trips any valid world losslessly through JSON (property)', () => {
    fc.assert(
      fc.property(rawWorldV1Arb, (raw) => {
        const w = WorldV1.parse(raw);
        assertNoNegativeZero(w);
        const text = JSON.stringify(w);
        const again = WorldV1.parse(JSON.parse(text));
        expect(again).toStrictEqual(w);
        expect(JSON.stringify(again)).toBe(text);
        // Parsing is idempotent: a valid document is a fixed point.
        expect(WorldV1.parse(w)).toStrictEqual(w);
        // The loader agrees with the schema, and migrates the world to the current version.
        const loaded = migrateWorld(JSON.parse(text));
        expect(loaded).toStrictEqual({ ok: true, value: worldV1ToV2(w), fromVersion: 1 });
      }),
    );
  });
});
