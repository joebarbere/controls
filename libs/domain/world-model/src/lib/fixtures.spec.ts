import { createWorld, migrateWorld } from '@controls/save-format';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FIXTURE_SPECS,
  fixtureFocusNormal,
  fixtureSnapTarget,
  fixtureSpec,
  quarterTurns,
  worldSnapTargets,
  yawVec,
} from './fixtures';
import { worldHash } from './hash';
import { loadLevel, newGameWorld } from './level';
import { builtinProp } from './props';
import { placeOnTargets } from './snap/placement';
import type { Fixture } from './types';

const workshopJson = (): unknown =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../content/levels/workshop.json'), 'utf8'));

const fixture = (id: string, ref: string, x = 0, y = 0, z = 0, yaw = 0): Fixture => ({
  id,
  ref: { id: ref, version: 1 },
  transform: { positionMm: { x, y, z }, orientationMdeg: { yaw, pitch: 0, roll: 0 } },
  extensions: {},
});

describe('built-in fixtures', () => {
  it('are sorted by id, integer-sized and sourced as game-design', () => {
    const ids = FIXTURE_SPECS.map((s) => s.id);
    expect(ids).toEqual([...ids].sort());
    for (const spec of FIXTURE_SPECS) {
      expect(spec.id.startsWith('prop.')).toBe(true);
      expect(spec.source).toMatch(/game-design/);
      for (const [key, value] of Object.entries(spec)) {
        if (key.endsWith('Mm'))
          expect(Number.isInteger(value) && (value as number) > 0, `${spec.id}.${key}`).toBe(true);
      }
    }
  });

  it('resolves refs at version 1 only; the bench matches the placeable prop.bench', () => {
    expect(fixtureSpec({ id: 'prop.stud-wall', version: 1 })?.kind).toBe('stud-wall');
    expect(fixtureSpec({ id: 'prop.stud-wall', version: 2 })).toBeUndefined();
    expect(fixtureSpec({ id: 'prop.nope', version: 1 })).toBeUndefined();
    const bench = fixtureSpec({ id: 'prop.bench', version: 1 });
    expect(bench).toMatchObject({ kind: 'bench', ...builtinProp({ id: 'prop.bench', version: 1 })?.sizeMm });
  });

  it('turns quarter-yaws exactly, and refuses anything else', () => {
    expect(quarterTurns({ yaw: 270_000, pitch: 0, roll: 0 })).toBe(3);
    expect(quarterTurns({ yaw: 45_000, pitch: 0, roll: 0 })).toBeNull();
    expect(quarterTurns({ yaw: 0, pitch: 90_000, roll: 0 })).toBeNull();
    expect(quarterTurns({ yaw: 0, pitch: 0, roll: 90_000 })).toBeNull();
    expect(yawVec({ x: 0, y: 5, z: 1 }, 1)).toEqual({ x: 1, y: 5, z: 0 }); // +z turns to +x (ADR 0007)
    expect(yawVec({ x: 1, y: 0, z: 0 }, 2)).toEqual({ x: -1, y: 0, z: 0 });
    expect(Object.is(yawVec({ x: 0, y: 0, z: 0 }, 1).z, -0)).toBe(false);
  });

  it('place snap targets in world space, named by the fixture', () => {
    expect(fixtureSnapTarget(fixture('rail', 'prop.din-rail', -250, 150, 0))).toEqual({
      kind: 'din-rail',
      id: 'rail',
      frame: { origin: { x: -250, y: 150, z: 0 }, normal: '+z' },
      lengthMm: 500,
    });
    // A side wall facing +x: yaw 90°, so u runs along -z.
    expect(fixtureSnapTarget(fixture('side', 'prop.stud-wall', -2500, -1200, 3000, 90_000))).toMatchObject({
      kind: 'wall-studs',
      frame: { origin: { x: -2500, y: -1200, z: 3000 }, normal: '+x' },
    });
    // A bench turned half round: its top's front-left corner is on the far side, right runs along -x.
    expect(fixtureSnapTarget(fixture('b', 'prop.bench', 0, 0, 0, 180_000))).toMatchObject({
      kind: 'bench-top',
      frame: { origin: { x: 0, y: 900, z: -750 }, normal: '+y', right: '-x' },
    });
    expect(fixtureSnapTarget(fixture('board', 'prop.plywood-backboard'))).toBeNull();
    expect(fixtureSnapTarget(fixture('floor', 'prop.workshop-floor'))).toBeNull();
    expect(fixtureSnapTarget(fixture('x', 'prop.nope'))).toBeNull();
    expect(fixtureSnapTarget(fixture('tilted', 'prop.backplate', 0, 0, 0, 1))).toBeNull();
  });

  it('give focus normals for everything but floors', () => {
    expect(fixtureFocusNormal(fixture('w', 'prop.stud-wall', 0, 0, 0, 270_000))).toBe('-x');
    expect(fixtureFocusNormal(fixture('b', 'prop.bench'))).toBe('+z');
    expect(fixtureFocusNormal(fixture('board', 'prop.plywood-backboard'))).toBe('+z');
    expect(fixtureFocusNormal(fixture('floor', 'prop.workshop-floor'))).toBeNull();
    expect(fixtureFocusNormal(fixture('x', 'prop.nope'))).toBeNull();
    expect(fixtureFocusNormal(fixture('tilted', 'prop.bench', 0, 0, 0, 1))).toBeNull();
  });

  it('a turned bench still takes props flat on its top', () => {
    const world = { fixtures: [fixture('b', 'prop.bench', 0, 0, 0, 90_000)] };
    const placed = placeOnTargets({ id: 'prop.box', version: 1 }, { x: 375, y: 900, z: -900 }, worldSnapTargets(world));
    expect(placed).toMatchObject({
      ok: true,
      targetId: 'b',
      orientationMdeg: { yaw: 90_000, pitch: 270_000, roll: 0 },
    });
  });
});

describe('levels', () => {
  it('the workshop loads through the normal migrate/validate path', () => {
    const loaded = loadLevel(workshopJson());
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.level.fixtures.map((f) => f.id)).toEqual([
      'backboard',
      'backplate',
      'bench',
      'din-rail-1',
      'din-rail-2',
      'floor',
      'stud-wall',
    ]);
    // Every fixture resolves to a built-in recipe and sits on a quarter-turn (no silent placeholder).
    for (const f of loaded.level.fixtures) {
      expect(fixtureSpec(f.ref), f.id).toBeDefined();
      expect(quarterTurns(f.transform.orientationMdeg), f.id).not.toBeNull();
    }
    expect(loaded.level.entities).toEqual([]);
    expect(loadLevel({ schemaVersion: 99 })).toMatchObject({ ok: false, error: { kind: 'newer-than-build' } });
  });

  it('a new game copies the level with its own seed, tick 0, not assisted', () => {
    const loaded = migrateWorld(workshopJson());
    if (!loaded.ok) throw new Error('workshop should load');
    const level = { ...loaded.value, tick: 7, assisted: true };
    const game = newGameWorld(level, { seed: 4_294_967_295, difficulty: 'realistic' });
    expect(game).toEqual({ ...loaded.value, seed: 4_294_967_295, difficulty: 'realistic' });
    expect(newGameWorld(loaded.value, { seed: 0 })).toEqual(loaded.value);
    expect(worldHash(newGameWorld(loaded.value, { seed: 1 }))).not.toBe(worldHash(loaded.value));
    expect(() => newGameWorld(loaded.value, { seed: 2 ** 32 })).toThrow();
    expect(() => newGameWorld(loaded.value, { seed: -1 })).toThrow();
  });

  it('an empty world has no snap targets', () => {
    expect(worldSnapTargets(createWorld({ seed: 0 }))).toEqual([]);
  });
});
