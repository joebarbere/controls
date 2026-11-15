import { BUILTIN_CATALOG } from '@controls/catalog';
import { migrateWorld } from '@controls/save-format';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PARITY_BORE_TOOL, routingParityWorld } from '../../testing/routing-panel';
import { checkWorldReferences } from '../devices';
import { bakeWorldRoutes } from './bake';
import { routingDigests, routingDigestsOfDocument } from './parity';
import { racewayPaths } from './raceways';
import { snapWaypoint } from './snap';

/**
 * F3.2 part 1: the routing goldens under Node. `apps/game-e2e/src/routing-parity.spec.ts` loads the same
 * two files and asserts the bundled game computes the same digests in Chromium. Regenerate both with
 * `pnpm nx test world-model -u` (a routing or bake change), never the e2e alone.
 */
const GOLDENS = join(__dirname, '../../../goldens/routing');

describe('routing parity goldens (ADR 0017)', () => {
  const world = routingParityWorld();

  it('the parity world is a valid world that exercises every part of the bake and the snapper', () => {
    expect(checkWorldReferences(world, BUILTIN_CATALOG)).toStrictEqual([]);
    const baked = bakeWorldRoutes(world, BUILTIN_CATALOG);
    // Lanes in three ducts, sag samples, a coil on the long cut, the pulled conductor's elbow arc.
    expect(baked.routes.filter((r) => r.coil !== null).map((r) => r.owner)).toStrictEqual(['c9']);
    const pulled = baked.routes.find((r) => r.owner === 'c10');
    const elbow = racewayPaths(world, BUILTIN_CATALOG).find((p) => p.entity === 25);
    const arc = (elbow?.centreline ?? []).slice(1, -1).map((c) => [c.x, c.y, c.z].map((v) => Math.round(v * 10) + 0));
    const points = pulled?.points ?? [];
    const has = (p: number[]) =>
      points.some((_, i) => i % 3 === 0 && points[i] === p[0] && points[i + 1] === p[1] && points[i + 2] === p[2]);
    expect(arc).toHaveLength(7);
    for (const p of arc) expect(has(p)).toBe(true);
    // Staple and bore snaps on the stud wall, and a conduit snap at the elbow's port.
    const stud = snapWaypoint(world, BUILTIN_CATALOG, { x: -2970, y: 1200, z: -1030 }, { kinds: ['staple'] });
    expect(stud.kind).toBe('staple');
    const bore = snapWaypoint(
      world,
      BUILTIN_CATALOG,
      { x: -2981, y: 1200, z: -1040 },
      { kinds: ['bore'], boreTool: PARITY_BORE_TOOL },
    );
    expect(bore.kind).toBe('bore');
    expect(snapWaypoint(world, BUILTIN_CATALOG, elbow?.b ?? { x: 0, y: 0, z: 0 })).toMatchObject({
      kind: 'conduit',
      entity: 25,
    });
  });

  it('the parity world, as the e2e loads it', async () => {
    await expect(`${JSON.stringify(world, null, 2)}\n`).toMatchFileSnapshot(join(GOLDENS, 'routing-panel.world.json'));
  });

  it('its centreline and proposal digests', async () => {
    const digests = routingDigests(world, BUILTIN_CATALOG);
    await expect(`${JSON.stringify(digests, null, 2)}\n`).toMatchFileSnapshot(
      join(GOLDENS, 'routing-panel.digests.json'),
    );
  });

  it('the committed world file loads and gives the committed digests', () => {
    const loaded = migrateWorld(JSON.parse(readFileSync(join(GOLDENS, 'routing-panel.world.json'), 'utf8')));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const digests = JSON.parse(readFileSync(join(GOLDENS, 'routing-panel.digests.json'), 'utf8'));
    expect(routingDigests(loaded.value, BUILTIN_CATALOG)).toStrictEqual(digests);
    // What the e2e hook calls: the document migrated and checked first; `null` when it doesn't load.
    expect(routingDigestsOfDocument(JSON.parse(JSON.stringify(world)))).toStrictEqual(digests);
    expect(routingDigestsOfDocument({ schemaVersion: 3 })).toBeNull();
  });
});
