import type { ManifestV1 } from '../v1/manifest';
import type { ReplayLogV1 } from '../v1/replay-log';
import type { WorldV1 } from '../v1/world';
import type { ManifestV2 } from './manifest';
import type { ReplayLogV2 } from './replay-log';
import type { WorldV2 } from './world';

/*
 * The v1 → v2 migration steps (ADR 0013). Pure: each returns a new document and never mutates its
 * argument (the tests deep-freeze it). Kept forever, even after later versions exist.
 *
 * A v1 world never had a circuit: its entities get empty bags, it has no connections and no
 * solution. A v1 replay log starts at `seq` 0 and ends where its last entry (or its initial world)
 * is, because no time passed in P1. A v1 manifest keeps its `catalogVersion` (0 in every P1 save)
 * and gets `simEngineVersion` 0, "written before the sim engine".
 */

export function worldV1ToV2(world: WorldV1): WorldV2 {
  return {
    ...world,
    schemaVersion: 2,
    nextConnectionId: 1,
    entities: world.entities.map((entity) => ({ ...entity, state: {}, sim: {} })),
    connections: [],
    sim: null,
  };
}

export function manifestV1ToV2(manifest: ManifestV1): ManifestV2 {
  return { ...manifest, schemaVersion: 2, simEngineVersion: 0 };
}

export function replayLogV1ToV2(log: ReplayLogV1): ReplayLogV2 {
  const lastTick = log.entries.at(-1)?.tick ?? log.initialWorld.tick;
  return {
    ...log,
    schemaVersion: 2,
    initialWorld: worldV1ToV2(log.initialWorld),
    firstSeq: 0,
    endTick: Math.max(log.initialWorld.tick, lastTick),
  };
}
