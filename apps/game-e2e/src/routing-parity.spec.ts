import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * F3.2 part 1 (ADR 0017): the routing maths gives the same answers in Chromium as in Node. The routing
 * parity world (two ducts and a riser, twenty screw blocks, eight auto-routed wires, a wire cut long
 * enough to coil, a conductor pulled through an EMT stick and elbow, and a stud wall) and its two digests
 * are the files `libs/domain/world-model/src/lib/routing/parity.spec.ts` pins under Node:
 *
 * - `centreline`: the hash of the analytic bake (lanes, lead-outs, sag, elbows, the 0.1 mm quantum);
 * - `proposals`: the hash of what `autoRoute` and `snapWaypoint` (duct, conduit, elbow port, staple and
 *   bore, from fractional cursors) propose on that world.
 *
 * Here the bundled game computes both through the `?e2e=1` session hook. Regenerate the files with
 * `pnpm nx test world-model -u`, never here alone.
 */

const GOLDENS = join(__dirname, '../../../libs/domain/world-model/goldens/routing');
const WORLD = JSON.parse(readFileSync(join(GOLDENS, 'routing-panel.world.json'), 'utf8')) as unknown;
const DIGESTS = JSON.parse(readFileSync(join(GOLDENS, 'routing-panel.digests.json'), 'utf8')) as unknown;

type Hook = { routingDigests(json: unknown): { centreline: string; proposals: string } | null };

test('the baked centreline and the router’s proposals match the Node goldens (F3.2 part 1)', async ({ page }) => {
  await page.goto('/?e2e=1');
  await expect
    .poll(() => page.evaluate(() => typeof (window as unknown as { __controlsSession?: Hook }).__controlsSession))
    .toBe('object');
  const digests = await page.evaluate((world) => {
    const hook = (window as unknown as { __controlsSession?: Hook }).__controlsSession;
    if (!hook) throw new Error('session hook missing');
    return hook.routingDigests(world);
  }, WORLD);
  expect(digests).toStrictEqual(DIGESTS);
});
