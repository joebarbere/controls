import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectDrawn } from './support/console';
import { startSandbox } from './support/sandbox';

/**
 * F3.5 part 1: a DIN panel placed on the backplate with the mouse, the 15 A breaker snapped onto the
 * panel's rail 1 with the keyboard reticle and then with the mouse (each `entity.place` carrying
 * `mountedOn`), a full slot shown as such, and Delete on the occupied panel refused with a toast. It
 * ends at the same `world.hash` as `apps/sim-cli/scenarios/din-panel-breaker.console`, which
 * `apps/sim-cli/src/din-panel-breaker.spec.ts` pins (e2e projects can't import workspace code: change
 * both or neither).
 *
 * The tool belt has no in-game editor yet (F3.4 part 1 reworks it), and settings v2 is frozen, so the
 * test seeds the stored settings with slots 4 and 5 holding the panel and the breaker. Forced WebGL2,
 * the backend CI exercises; the mouse is aimed with the `?e2e=1` hook's `projectMm`.
 */
const DIN_PANEL_BREAKER_HASH = '7901fbdffe8ca1ee86a6a4259af12d356e79b3fa51a157f8c3ad719d0687ac15';

const PANEL = { id: 'panel.pellmoor-din-400x500', version: 1 };
const BREAKER = { id: 'breaker.saltmere-1p-15a', version: 1 };

interface Hooks {
  __controlsViewport?: {
    projectMm(p: { x: number; y: number; z: number }): { x: number; y: number } | undefined;
  };
  __controlsSession?: {
    hash(): Promise<string>;
    entries(): ReadonlyArray<{ id: string; args: Record<string, unknown> }>;
  };
}

const logged = (page: Page) =>
  page.evaluate(() => ((window as unknown as Hooks).__controlsSession?.entries() ?? []).map((e) => e.id));
const entries = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__controlsSession?.entries() ?? []);
const hash = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__controlsSession?.hash() ?? '');

/** Page coordinates of an integer-mm world point on the canvas. */
async function screen(page: Page, canvas: Locator, x: number, y: number, z: number) {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas');
  const p = await page.evaluate((a) => (window as unknown as Hooks).__controlsViewport?.projectMm(a), { x, y, z });
  if (!p) throw new Error('viewport not started');
  return { x: box.x + p.x, y: box.y + p.y };
}

/** The default settings with the panel in tool-belt slot 4 and the breaker in slot 5. */
function seededSettings(): string {
  const defaults = JSON.parse(
    readFileSync(join(__dirname, '../../../libs/domain/save-format/fixtures/settings/v2/defaults.json'), 'utf8'),
  ) as { toolBelt: { slots: unknown[] } };
  defaults.toolBelt.slots[3] = PANEL;
  defaults.toolBelt.slots[4] = BREAKER;
  return JSON.stringify(defaults);
}

test('mouse and keyboard place a DIN panel and snap the breaker onto its rail, to the pinned hash', async ({
  page,
}) => {
  await page.addInitScript(
    ({ key, value }) => {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem(key, value);
        sessionStorage.setItem('seeded', '1');
      }
    },
    { key: 'controls.settings', value: seededSettings() },
  );
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?e2e=1&renderer=webgl2');
  await startSandbox(page);
  const viewport = page.locator('ctl-viewport');
  const canvas = page.locator('ctl-viewport canvas');
  await expect(viewport).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(viewport).toHaveAttribute('data-backend', 'webgl2');
  await expect(canvas).toBeFocused();

  // Mouse: key 4 picks the panel, a click on the backplate at (0, 50) places it.
  await page.keyboard.press('Digit4');
  await expect(viewport).toHaveAttribute('data-placement-ref', PANEL.id);
  const plate = await screen(page, canvas, 0, 50, 0);
  await page.mouse.move(plate.x, plate.y);
  await expect(viewport).toHaveAttribute('data-placement-target', 'backplate');
  await expect(viewport).toHaveAttribute('data-placement-valid', 'true');
  await page.mouse.click(plate.x, plate.y);
  await expect.poll(() => logged(page)).toEqual(['toolbelt.select', 'entity.place']);
  await expectDrawn(page, ['entity-1']);

  // Keyboard: Escape puts the tool away; select and focus DIN rail 1 with ] and F (cycling order:
  // backboard, backplate, bench, din-rail-1, …), so the reticle is on the panel's rail 1; key 5, Enter.
  await page.keyboard.press('Escape');
  await expect(viewport).not.toHaveAttribute('data-placing', /.*/);
  await page.mouse.move(0, 0); // the pointer off the canvas: the reticle aims
  for (let i = 0; i < 4; i++) await page.keyboard.press('BracketRight');
  await expect(viewport).toHaveAttribute('data-selected', 'din-rail-1');
  await page.keyboard.press('KeyF');
  await expect(viewport).toHaveAttribute('data-focus', 'din-rail-1');
  await page.keyboard.press('Digit5');
  await expect(viewport).toHaveAttribute('data-placement-ref', BREAKER.id);
  await expect(viewport).toHaveAttribute('data-placement-target', 'entity-1:rail-1');
  await expect(viewport).toHaveAttribute('data-placement-valid', 'true');
  await page.keyboard.press('Enter');
  await expect
    .poll(() => logged(page))
    .toEqual(['toolbelt.select', 'entity.place', 'view.focus', 'toolbelt.select', 'entity.place']);
  await expectDrawn(page, ['entity-2']);
  // The same slot again is full: the ghost says why and Enter commits nothing.
  await expect(viewport).toHaveAttribute('data-placement-reason', 'mount-full');
  await expect(page.getByTestId('placement-hint')).toHaveText('That spot on the mount is taken.');
  await page.keyboard.press('Enter');

  // Mouse: a click further left on the same rail places a second breaker.
  const rail = await screen(page, canvas, -100, 150, 22);
  await page.mouse.move(rail.x, rail.y);
  await expect(viewport).toHaveAttribute('data-placement-target', 'entity-1:rail-1');
  await expect(viewport).toHaveAttribute('data-placement-valid', 'true');
  await page.mouse.click(rail.x, rail.y);
  await expect.poll(() => logged(page)).toHaveLength(6);
  const places = (await entries(page)).filter((e) => e.id === 'entity.place').map((e) => e.args['mountedOn']);
  expect(places).toEqual([null, { entity: 1, mount: 'rail-1' }, { entity: 1, mount: 'rail-1' }]);

  // Delete on the occupied panel is refused, and the toast says why; nothing is logged.
  await page.keyboard.press('Escape');
  await page.mouse.move(0, 0);
  await canvas.focus();
  for (let i = 0; i < 2; i++) await page.keyboard.press('BracketRight');
  await expect(viewport).toHaveAttribute('data-selected', 'entity-1');
  await page.keyboard.press('Delete');
  await expect(page.getByRole('alert')).toContainText('Delete object: Entity 1 holds a mounted device');
  expect(await logged(page)).toHaveLength(6);

  expect(await hash(page)).toBe(DIN_PANEL_BREAKER_HASH);
});
