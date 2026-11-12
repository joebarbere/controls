import fc from 'fast-check';
import { deepFreeze, rawManifestV2Arb, rawReplayLogV2Arb, rawWorldV2Arb } from '../../testing/arbitraries';
import { manifestMigrator, replayLogMigrator, worldMigrator } from '../documents';
import { ManifestV2 } from '../v2/manifest';
import { ReplayLogV2 } from '../v2/replay-log';
import { WorldV2 } from '../v2/world';
import { LEAD_SIM_BAG_V3, manifestV2ToV3, replayEntryV2ToV3, replayLogV2ToV3, worldV2ToV3 } from './from-v2';
import { ManifestV3 } from './manifest';
import { ReplayLogV3 } from './replay-log';
import { WorldV3 } from './world';

/*
 * The v2 → v3 step (ADR 0015): total (every valid v2 document gives a valid v3 one), pure (same input,
 * same output; the input is never mutated) and lossless for everything v2 had.
 */

const steps = [
  { name: 'world', arb: rawWorldV2Arb, v2: WorldV2, v3: WorldV3, up: worldV2ToV3 },
  { name: 'manifest', arb: rawManifestV2Arb, v2: ManifestV2, v3: ManifestV3, up: manifestV2ToV3 },
  { name: 'replay log', arb: rawReplayLogV2Arb, v2: ReplayLogV2, v3: ReplayLogV3, up: replayLogV2ToV3 },
] as const;

describe('v2 → v3 migration', () => {
  it.each(steps.map((s) => [s.name, s] as const))('%s: total and pure (property)', (_name, step) => {
    fc.assert(
      fc.property(step.arb, (raw) => {
        const input = deepFreeze(step.v2.parse(raw));
        const snapshot = JSON.stringify(input);
        const up = step.up as (value: unknown) => unknown;
        const first = up(input);
        const parsed = step.v3.safeParse(first);
        expect(parsed.success).toBe(true);
        // The step's output is already canonical: validating it changes nothing.
        expect(parsed.data).toStrictEqual(first);
        expect(up(input)).toStrictEqual(first);
        expect(JSON.stringify(input)).toBe(snapshot);
      }),
      { numRuns: 50 },
    );
  });

  it('a world keeps every v2 field; entities are unmounted and unlabelled; leads become lead-shaped', () => {
    fc.assert(
      fc.property(rawWorldV2Arb, (raw) => {
        const v2 = WorldV2.parse(raw);
        const v3 = worldV2ToV3(v2);
        expect(v3).toMatchObject({ schemaVersion: 3, nextCableId: 1, nextTerminationId: 1, cables: [] });
        expect(v3.entities).toStrictEqual(v2.entities.map((e) => ({ ...e, mountedOn: null, label: null })));
        expect(v3.connections).toStrictEqual(
          v2.connections.map((c) => ({
            id: c.id,
            ref: c.ref,
            a: { ...c.a, termination: null },
            b: { ...c.b, termination: null },
            cable: null,
            route: null,
            lengthMm: null,
            colour: null,
            label: null,
            state: {},
            sim: LEAD_SIM_BAG_V3,
            extensions: c.extensions,
          })),
        );
        const kept = Object.fromEntries(
          Object.entries(v2).filter(([key]) => !['schemaVersion', 'entities', 'connections'].includes(key)),
        );
        expect(v3).toMatchObject(kept);
      }),
    );
  });

  it('each migrated lead gets its own copy of the lead kind’s initial sim bag (frozen literal)', () => {
    expect(Object.isFrozen(LEAD_SIM_BAG_V3)).toBe(true);
    expect(Object.keys(LEAD_SIM_BAG_V3)).toHaveLength(10);
    const lead = {
      id: 1,
      ref: { id: 'lead.quillfern-test-1m', version: 1 },
      a: { entity: 1, terminal: 'pos' },
      b: { entity: 1, terminal: 'neg' },
      extensions: {},
    };
    const v2 = WorldV2.parse({
      schemaVersion: 2,
      seed: 1,
      tick: 0,
      nextEntityId: 2,
      nextConnectionId: 3,
      regionId: 'nec',
      difficulty: 'apprentice',
      assisted: false,
      fixtures: [],
      entities: [
        {
          id: 1,
          ref: { id: 'battery.ferrovane-12v-7ah', version: 1 },
          transform: { positionMm: { x: 0, y: 0, z: 0 }, orientationMdeg: { yaw: 0, pitch: 0, roll: 0 } },
          state: {},
          sim: { stateOfCharge: 1 },
          extensions: {},
        },
      ],
      connections: [lead, { ...lead, id: 2 }],
      sim: null,
      extensions: {},
    });
    const [first, second] = worldV2ToV3(v2).connections;
    expect(first.sim).toStrictEqual(LEAD_SIM_BAG_V3);
    expect(first.sim).not.toBe(second.sim);
    expect(first.sim).not.toBe(LEAD_SIM_BAG_V3);
  });

  it('a replay log migrates its initial world and gives entity.place entries mountedOn: null, nothing else', () => {
    fc.assert(
      fc.property(rawReplayLogV2Arb, (raw) => {
        const v2 = ReplayLogV2.parse(raw);
        const v3 = replayLogV2ToV3(v2);
        expect(v3).toMatchObject({ schemaVersion: 3, firstSeq: v2.firstSeq, endTick: v2.endTick });
        expect(v3.initialWorld).toStrictEqual(worldV2ToV3(v2.initialWorld));
        expect(v3.entries).toStrictEqual(v2.entries.map(replayEntryV2ToV3));
      }),
    );
    const place = { seq: 0, tick: 0, id: 'entity.place', args: { ref: { id: 'prop.crate', version: 1 } } };
    expect(replayEntryV2ToV3(place)).toStrictEqual({ ...place, args: { ...place.args, mountedOn: null } });
    // An entry that already says mountedOn, or isn't entity.place, is copied as it is (the same object).
    const already = { ...place, args: { ...place.args, mountedOn: { entity: 4, mount: 'rail' } } };
    expect(replayEntryV2ToV3(already)).toBe(already);
    for (const id of ['lead.connect', 'lead.disconnect', 'entity.move', 'entity.placed', 'view.resetLayout']) {
      const entry = { ...place, id };
      expect(replayEntryV2ToV3(entry)).toBe(entry);
    }
    // An odd entity.place (args a v2 bus would never log) is migrated without throwing; replay refuses it later.
    const odd = { ...place, args: { mountedOn: undefined } as unknown as Record<string, never> };
    expect(() => replayEntryV2ToV3(odd)).not.toThrow();
  });

  it('a manifest keeps its catalogue and engine versions', () => {
    fc.assert(
      fc.property(rawManifestV2Arb, (raw) => {
        const v2 = ManifestV2.parse(raw);
        expect(manifestV2ToV3(v2)).toStrictEqual({ ...v2, schemaVersion: 3 });
      }),
    );
  });

  it('the chains reach v3 through the migrators', () => {
    for (const migrator of [worldMigrator, manifestMigrator, replayLogMigrator]) {
      expect(migrator.currentVersion).toBe(3);
      expect(migrator.schemaFor(3)).toBeDefined();
      expect(migrator.schemaFor(4)).toBeUndefined();
    }
    expect(worldMigrator.schemaFor(3)).toBe(WorldV3);
    expect(manifestMigrator.schemaFor(3)).toBe(ManifestV3);
    expect(replayLogMigrator.schemaFor(3)).toBe(ReplayLogV3);
  });
});
