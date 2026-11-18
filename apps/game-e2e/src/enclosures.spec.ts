import { expect, test, type Locator, type Page } from '@playwright/test';
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
 * The panel and the breaker go on the belt the way a player puts them there: Settings → Tool belt,
 * slots 4 and 5 (the picker offers placeable catalogue devices since F3.5). Forced WebGL2, the backend
 * CI exercises; the mouse is aimed with the `?e2e=1` hook's `projectMm`.
 */
const DIN_PANEL_BREAKER_HASH = 'a2e7b4ef67142be2f7229161016f73b70f18c2016122ab3d687e578ca97d7822';

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

test('mouse and keyboard place a DIN panel and snap the breaker onto its rail, to the pinned hash', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?e2e=1&renderer=webgl2');
  // Settings → Tool belt: the panel in slot 4, the breaker in slot 5.
  await page.getByRole('navigation', { name: 'Controls' }).getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const belt = settings.getByRole('group', { name: 'Tool belt' });
  await belt.getByRole('combobox', { name: 'Slot 4' }).selectOption(`${PANEL.id}@${PANEL.version}`);
  await belt.getByRole('combobox', { name: 'Slot 5' }).selectOption(`${BREAKER.id}@${BREAKER.version}`);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
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

test('the mouse snaps a conduit connector into an open knockout: entity.place logs its inEntry and the panel is occupied', async ({
  page,
}) => {
  // ADR 0015 F3.4 part 2 note 4: which entry a connector is in is stored, so a mouse-placed connector
  // must log it (the cursor and positions are the raceway-panel scenario's: the panel lands at
  // (-200, -200, 0), ko-bottom-1 is at (-100, -200, 100), the connector at (-117, -200, 83)).
  const CONNECTOR = { id: 'connector.stavenor-emt-075', version: 1 };
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?e2e=1&renderer=webgl2');
  await page.getByRole('navigation', { name: 'Controls' }).getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const belt = settings.getByRole('group', { name: 'Tool belt' });
  await belt.getByRole('combobox', { name: 'Slot 4' }).selectOption(`${PANEL.id}@${PANEL.version}`);
  await belt.getByRole('combobox', { name: 'Slot 5' }).selectOption(`${CONNECTOR.id}@${CONNECTOR.version}`);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await startSandbox(page);
  const viewport = page.locator('ctl-viewport');
  const canvas = page.locator('ctl-viewport canvas');
  await expect(viewport).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });

  await page.keyboard.press('Digit4');
  const plate = await screen(page, canvas, 0, 50, 0);
  await page.mouse.move(plate.x, plate.y);
  await expect(viewport).toHaveAttribute('data-placement-valid', 'true');
  await page.mouse.click(plate.x, plate.y);
  await expect.poll(() => logged(page)).toEqual(['toolbelt.select', 'entity.place']);
  const opened = await page.evaluate(
    () =>
      (
        window as unknown as { __controlsSession: { exec(id: string, args?: unknown): { ok: boolean } } }
      ).__controlsSession.exec('enclosure.openEntry', {
        id: 1,
        entry: 'ko-bottom-1',
        tool: { id: 'tool.veltmark-sd-2', version: 1 },
      }).ok,
  );
  expect(opened).toBe(true);

  await page.keyboard.press('Digit5');
  await expect(viewport).toHaveAttribute('data-placement-ref', CONNECTOR.id);
  const knockout = await screen(page, canvas, -95, -205, 100);
  await page.mouse.move(knockout.x, knockout.y);
  await expect(viewport).toHaveAttribute('data-placement-target', 'entity-1:ko-bottom-1');
  await expect(viewport).toHaveAttribute('data-placement-valid', 'true');
  await page.mouse.click(knockout.x, knockout.y);
  const places = async () => (await entries(page)).filter((e) => e.id === 'entity.place');
  await expect.poll(async () => (await places()).length).toBe(2);
  expect((await places()).at(-1)?.args).toMatchObject({
    ref: CONNECTOR,
    positionMm: { x: -117, y: -200, z: 83 },
    mountedOn: null,
    inEntry: { entity: 1, entry: 'ko-bottom-1' },
  });

  // The panel is occupied now: moving or deleting it is refused, and nothing is logged.
  const before = (await logged(page)).length;
  const refusals = await page.evaluate(() => {
    const session = (
      window as unknown as {
        __controlsSession: { exec(id: string, args?: unknown): { ok: boolean; error?: { code: string } } };
      }
    ).__controlsSession;
    return [
      session.exec('entity.move', { id: 1, positionMm: { x: -200, y: -200, z: 50 } }),
      session.exec('entity.delete', { id: 1 }),
    ].map((r) => (r.ok ? 'ok' : (r.error?.code ?? 'refused')));
  });
  expect(refusals).toEqual(['occupied', 'occupied']);
  expect(await logged(page)).toHaveLength(before);
});
