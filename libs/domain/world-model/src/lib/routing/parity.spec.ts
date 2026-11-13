import { BUILTIN_CATALOG } from '@controls/catalog';
import { migrateWorld } from '@controls/save-format';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routingPanelBus } from '../../testing/routing-panel';
import { routingDigests, routingDigestsOfDocument } from './parity';

/**
 * F3.2 part 1: the routing goldens under Node. `apps/game-e2e/src/routing-parity.spec.ts` loads the same
 * two files and asserts the bundled game computes the same digests in Chromium. Regenerate both with
 * `pnpm nx test world-model -u` (a routing or bake change), never the e2e alone.
 */
const GOLDENS = join(__dirname, '../../../goldens/routing');

describe('routing parity goldens (ADR 0017)', () => {
  const world = routingPanelBus(true).state;

  it('the routing panel world, as the e2e loads it', async () => {
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
