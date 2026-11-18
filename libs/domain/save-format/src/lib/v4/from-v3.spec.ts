import fc from 'fast-check';
import { deepFreeze, rawManifestV3Arb, rawReplayLogV3Arb, rawWorldV3Arb } from '../../testing/arbitraries';
import { manifestMigrator, replayLogMigrator, worldMigrator } from '../documents';
import { ManifestV3 } from '../v3/manifest';
import { ReplayLogV3 } from '../v3/replay-log';
import { WorldV3 } from '../v3/world';
import { LAMP_INCANDESCENT_REFS_V3, LAMP_SIM_KEYS_V4, manifestV3ToV4, replayLogV3ToV4, worldV3ToV4 } from './from-v3';
import { ManifestV4 } from './manifest';
import { ReplayLogV4 } from './replay-log';
import { WorldV4 } from './world';

/*
 * The v3 → v4 step (ADR 0019): total (every valid v3 document gives a valid v4 one), pure (same input,
 * same output; the input is never mutated) and lossless for everything v3 had.
 */

const steps = [
  { name: 'world', arb: rawWorldV3Arb, v3: WorldV3, v4: WorldV4, up: worldV3ToV4 },
  { name: 'manifest', arb: rawManifestV3Arb, v3: ManifestV3, v4: ManifestV4, up: manifestV3ToV4 },
  { name: 'replay log', arb: rawReplayLogV3Arb, v3: ReplayLogV3, v4: ReplayLogV4, up: replayLogV3ToV4 },
] as const;

const Z = { yaw: 0, pitch: 0, roll: 0 };
const v3Entity = (id: number, ref: { id: string; version: number }, sim: Record<string, unknown>) => ({
  id,
  ref,
  transform: { positionMm: { x: id * 100, y: 0, z: 0 }, orientationMdeg: Z },
  state: {},
  sim,
  mountedOn: null,
  inEntry: null,
  label: null,
  extensions: {},
});
const v3World = (entities: unknown[]) =>
  WorldV3.parse({
    schemaVersion: 3,
    seed: 1,
    tick: 0,
    nextEntityId: entities.length + 1,
    nextConnectionId: 1,
    nextCableId: 1,
    nextTerminationId: 1,
    regionId: 'nec',
    difficulty: 'apprentice',
    assisted: false,
    fixtures: [],
    entities,
    connections: [],
    cables: [],
    sim: null,
    extensions: {},
  });

describe('v3 → v4 migration', () => {
  it.each(steps.map((s) => [s.name, s] as const))('%s: total and pure (property)', (_name, step) => {
    fc.assert(
      fc.property(step.arb, (raw) => {
        const input = deepFreeze(step.v3.parse(raw));
        const snapshot = JSON.stringify(input);
        const up = step.up as (value: unknown) => unknown;
        const first = up(input);
        const parsed = step.v4.safeParse(first);
        expect(parsed.success).toBe(true);
        // The step's output is already canonical: validating it changes nothing.
        expect(parsed.data).toStrictEqual(first);
        expect(up(input)).toStrictEqual(first);
        expect(JSON.stringify(input)).toBe(snapshot);
      }),
      { numRuns: 50 },
    );
  });

  it('a world keeps every v3 field; it has no areas, entities are unplugged and connections untaped', () => {
    fc.assert(
      fc.property(rawWorldV3Arb, (raw) => {
        const v3 = WorldV3.parse(raw);
        const v4 = worldV3ToV4(v3);
        expect(v4).toMatchObject({ schemaVersion: 4, areas: [] });
        // The arbitrary's refs are never shipped lamps, so every bag is kept as it is.
        expect(v4.entities).toStrictEqual(v3.entities.map((e) => ({ ...e, pluggedInto: null })));
        expect(v4.connections).toStrictEqual(v3.connections.map((c) => ({ ...c, marking: { a: null, b: null } })));
        const kept = Object.fromEntries(
          Object.entries(v3).filter(([key]) => !['schemaVersion', 'entities', 'connections'].includes(key)),
        );
        expect(v4).toMatchObject(kept);
      }),
    );
  });

  it('a shipped incandescent lamp gains burnedOut: false and overvoltageSinceTick: null; nothing else does', () => {
    expect(Object.isFrozen(LAMP_INCANDESCENT_REFS_V3)).toBe(true);
    expect(LAMP_INCANDESCENT_REFS_V3.every((ref) => Object.isFrozen(ref))).toBe(true);
    expect(Object.isFrozen(LAMP_SIM_KEYS_V4)).toBe(true);
    expect(LAMP_SIM_KEYS_V4).toStrictEqual({ burnedOut: false, overvoltageSinceTick: null });
    const [bench, mains] = LAMP_INCANDESCENT_REFS_V3;
    const world = v3World([
      v3Entity(1, { ...bench }, { filamentTempK: null }),
      v3Entity(2, { ...mains }, { filamentTempK: 2500.25 }),
      // A later version of a lamp id, an unknown ref and another kind are copied untouched.
      v3Entity(3, { id: mains.id, version: 2 }, { filamentTempK: 300 }),
      v3Entity(4, { id: 'lamp.fixture-unknown', version: 1 }, { filamentTempK: 300 }),
      v3Entity(5, { id: 'battery.ferrovane-12v-7ah', version: 1 }, { stateOfCharge: 1 }),
      // A bag that already holds a key keeps its value (each key is added only if absent).
      v3Entity(6, { ...mains }, { filamentTempK: 300, burnedOut: true }),
    ]);
    const v4 = worldV3ToV4(deepFreeze(world));
    expect(v4.entities.map((e) => e.sim)).toStrictEqual([
      { filamentTempK: null, burnedOut: false, overvoltageSinceTick: null },
      { filamentTempK: 2500.25, burnedOut: false, overvoltageSinceTick: null },
      { filamentTempK: 300 },
      { filamentTempK: 300 },
      { stateOfCharge: 1 },
      { filamentTempK: 300, burnedOut: true, overvoltageSinceTick: null },
    ]);
    // Each lamp gets its own bag, never the frozen literal or another lamp's.
    expect(v4.entities[0].sim).not.toBe(v4.entities[1].sim);
    expect(v4.entities[0].sim).not.toBe(LAMP_SIM_KEYS_V4);
    expect(WorldV4.parse(v4)).toStrictEqual(v4);
  });

  it('a replay log migrates its initial world and copies every entry verbatim', () => {
    fc.assert(
      fc.property(rawReplayLogV3Arb, (raw) => {
        const v3 = ReplayLogV3.parse(raw);
        const v4 = replayLogV3ToV4(v3);
        expect(v4).toMatchObject({ schemaVersion: 4, firstSeq: v3.firstSeq, endTick: v3.endTick });
        expect(v4.initialWorld).toStrictEqual(worldV3ToV4(v3.initialWorld));
        expect(v4.entries).toStrictEqual(v3.entries);
        v4.entries.forEach((entry, index) => expect(entry).toBe(v3.entries[index]));
      }),
    );
  });

  it('a manifest keeps its catalogue and engine versions', () => {
    fc.assert(
      fc.property(rawManifestV3Arb, (raw) => {
        const v3 = ManifestV3.parse(raw);
        expect(manifestV3ToV4(v3)).toStrictEqual({ ...v3, schemaVersion: 4 });
      }),
    );
  });

  it('the chains reach v4 through the migrators', () => {
    for (const migrator of [worldMigrator, manifestMigrator, replayLogMigrator]) {
      expect(migrator.currentVersion).toBe(4);
      expect(migrator.schemaFor(4)).toBeDefined();
      expect(migrator.schemaFor(5)).toBeUndefined();
    }
    expect(worldMigrator.schemaFor(4)).toBe(WorldV4);
    expect(manifestMigrator.schemaFor(4)).toBe(ManifestV4);
    expect(replayLogMigrator.schemaFor(4)).toBe(ReplayLogV4);
  });
});
