import fc from 'fast-check';
import { deepFreeze, rawManifestV1Arb, rawReplayLogV1Arb, rawWorldV1Arb } from '../../testing/arbitraries';
import { manifestMigrator, replayLogMigrator, worldMigrator } from '../documents';
import { ManifestV1 } from '../v1/manifest';
import { ReplayLogV1 } from '../v1/replay-log';
import { WorldV1 } from '../v1/world';
import { manifestV1ToV2, replayLogV1ToV2, worldV1ToV2 } from './from-v1';
import { ManifestV2 } from './manifest';
import { ReplayLogV2 } from './replay-log';
import { WorldV2 } from './world';

/*
 * The v1 → v2 step (ADR 0013): total (every valid v1 document gives a valid v2 one), pure (same
 * input, same output; the input is never mutated) and lossless for everything v1 had.
 */

const steps = [
  { name: 'world', arb: rawWorldV1Arb, v1: WorldV1, v2: WorldV2, up: worldV1ToV2 },
  { name: 'manifest', arb: rawManifestV1Arb, v1: ManifestV1, v2: ManifestV2, up: manifestV1ToV2 },
  { name: 'replay log', arb: rawReplayLogV1Arb, v1: ReplayLogV1, v2: ReplayLogV2, up: replayLogV1ToV2 },
] as const;

describe('v1 → v2 migration', () => {
  it.each(steps.map((s) => [s.name, s] as const))('%s: total and pure (property)', (_name, step) => {
    fc.assert(
      fc.property(step.arb, (raw) => {
        const input = deepFreeze(step.v1.parse(raw));
        const snapshot = JSON.stringify(input);
        const up = step.up as (value: unknown) => unknown;
        const first = up(input);
        expect(step.v2.safeParse(first).success).toBe(true);
        expect(up(input)).toStrictEqual(first);
        expect(JSON.stringify(input)).toBe(snapshot);
      }),
      { numRuns: 50 },
    );
  });

  it('a world keeps every v1 field and gains empty bags, no connections and no solution', () => {
    fc.assert(
      fc.property(rawWorldV1Arb, (raw) => {
        const v1 = WorldV1.parse(raw);
        const v2 = worldV1ToV2(v1);
        expect(v2).toMatchObject({ schemaVersion: 2, nextConnectionId: 1, connections: [], sim: null });
        expect(v2.entities.map(({ state, sim, ...rest }) => ({ rest, state, sim }))).toStrictEqual(
          v1.entities.map((rest) => ({ rest, state: {}, sim: {} })),
        );
        const { schemaVersion: _a, entities: _b, ...kept } = v1;
        expect(v2).toMatchObject(kept);
      }),
    );
  });

  it('a replay log starts at seq 0 and ends at its last entry’s tick (or its initial world’s)', () => {
    fc.assert(
      fc.property(rawReplayLogV1Arb, (raw) => {
        const v1 = ReplayLogV1.parse(raw);
        const v2 = replayLogV1ToV2(v1);
        expect(v2.firstSeq).toBe(0);
        expect(v2.entries).toStrictEqual(v1.entries);
        expect(v2.initialWorld).toStrictEqual(worldV1ToV2(v1.initialWorld));
        expect(v2.endTick).toBe(Math.max(v1.initialWorld.tick, v1.entries.at(-1)?.tick ?? 0));
      }),
    );
  });

  it('a manifest keeps its catalogVersion and gets simEngineVersion 0 (written before the engine)', () => {
    fc.assert(
      fc.property(rawManifestV1Arb, (raw) => {
        const v1 = ManifestV1.parse(raw);
        expect(manifestV1ToV2(v1)).toStrictEqual({ ...v1, schemaVersion: 2, simEngineVersion: 0 });
      }),
    );
  });

  it('the chains reach v2 from v1 through the migrators', () => {
    for (const migrator of [worldMigrator, manifestMigrator, replayLogMigrator]) {
      expect(migrator.currentVersion).toBe(2);
      expect(migrator.schemaFor(1)).toBeDefined();
      expect(migrator.schemaFor(2)).toBeDefined();
      expect(migrator.schemaFor(3)).toBeUndefined();
    }
  });
});
