import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * F1.7: place, move and delete with the mouse gives the same `world.hash` as the equivalent console
 * lines. `apps/sim-cli/scenarios/mouse-place-move-delete.console` is those lines, and
 * `apps/sim-cli/src/mouse-place-move-delete.spec.ts` asserts `sim run` on it prints MOUSE_HASH. This
 * test does the same with real mouse and keyboard input on the canvas and must end at the same
 * literal (e2e projects can't import workspace code: change both or neither).
 *
 * The mouse is aimed at integer-mm world points through the `?e2e=1` hook's `projectMm` (view
 * state only); snapping turns each into the console file's exact positions. Forced WebGL2, the
 * backend CI exercises on GPU-less runners. Pointer lock is never asserted (flaky headless).
 */
const MOUSE_HASH = 'ea1ca89916bce0e211d21ee7a7a39c1d67997bfce884071307e4d1bbe7b1a84c';

interface Hooks {
  __controlsViewport?: {
    projectMm(p: { x: number; y: number; z: number }): { x: number; y: number } | undefined;
    selectables(): ReadonlyArray<{ id: string }>;
    select(id: string | null): boolean;
    stats(): { geometries: number; entities: number; recipes: number; bvhs: number };
  };
  __controlsSession?: {
    hash(): string;
    entries(): ReadonlyArray<{ id: string; args: unknown }>;
  };
}

const viewportHook = <T>(
  page: Page,
  fn: (h: NonNullable<Hooks['__controlsViewport']>, arg: unknown) => T,
  arg?: unknown,
) =>
  page.evaluate(
    ({ src, arg }) => {
      const h = (window as unknown as Hooks).__controlsViewport;
      if (!h) throw new Error('viewport hook missing');
      return new Function('h', 'arg', `return (${src})(h, arg)`)(h, arg) as T;
    },
    { src: fn.toString(), arg },
  );
const logged = (page: Page) =>
  page.evaluate(() => ((window as unknown as Hooks).__controlsSession?.entries() ?? []).map((e) => e.id));
const hash = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__controlsSession?.hash() ?? '');
const stats = (page: Page) => viewportHook(page, (h) => h.stats());

/** Page coordinates of an integer-mm world point on the canvas. */
async function screen(page: Page, canvas: Locator, x: number, y: number, z: number) {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas');
  const p = await viewportHook(page, (h, a) => h.projectMm(a as { x: number; y: number; z: number }), { x, y, z });
  if (!p) throw new Error('viewport not started');
  return { x: box.x + p.x, y: box.y + p.y };
}

async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?e2e=1&renderer=webgl2');
  await page.getByRole('button', { name: 'New sandbox' }).click();
  const viewport = page.locator('ctl-viewport');
  await expect(viewport).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(viewport).toHaveAttribute('data-backend', 'webgl2');
  await expect(page.locator('ctl-viewport canvas')).toBeFocused();
  return { viewport, canvas: page.locator('ctl-viewport canvas') };
}

test('mouse place, move and delete gives the same world.hash as the console lines', async ({ page }) => {
  const { viewport, canvas } = await open(page);

  // Place a box: key 1 picks it from the tool belt, the ghost snaps under the pointer, a click commits.
  await page.keyboard.press('Digit1');
  await expect(viewport).toHaveAttribute('data-placing', 'place');
  await expect(viewport).toHaveAttribute('data-placement-ref', 'prop.box');
  const a = await screen(page, canvas, -150, 300, 0);
  await page.mouse.move(a.x, a.y);
  await expect(viewport).toHaveAttribute('data-placement-target', 'backplate');
  await expect(viewport).toHaveAttribute('data-placement-valid', 'true');
  expect(await logged(page)).toEqual(['toolbelt.select']); // aiming the ghost logs nothing
  await page.mouse.click(a.x, a.y);
  await expect.poll(() => logged(page)).toEqual(['toolbelt.select', 'entity.place']);

  // Place a crate.
  await page.keyboard.press('Digit2');
  await expect(viewport).toHaveAttribute('data-placement-ref', 'prop.crate');
  const b = await screen(page, canvas, 100, -200, 0);
  await page.mouse.move(b.x, b.y);
  await expect(viewport).toHaveAttribute('data-placement-valid', 'true');
  await page.mouse.click(b.x, b.y);
  await expect.poll(() => stats(page)).toMatchObject({ entities: 2, recipes: 2 });

  // Escape puts the tool away without a command.
  await page.keyboard.press('Escape');
  await expect(viewport).not.toHaveAttribute('data-placing', /.*/);
  await expect(page.getByRole('navigation', { name: 'Controls' })).toBeHidden(); // the menu stayed shut

  // Drag the box onto DIN rail 1: many pointer moves, one entity.move on release.
  const grab = await screen(page, canvas, -150, 300, 60);
  const drop = await screen(page, canvas, -10, 150, 7);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(drop.x, drop.y, { steps: 12 });
  await expect(viewport).toHaveAttribute('data-placing', 'move');
  await expect(viewport).toHaveAttribute('data-placement-target', 'din-rail-1');
  expect(await logged(page)).toEqual(['toolbelt.select', 'entity.place', 'toolbelt.select', 'entity.place']);
  await page.mouse.up();
  await expect.poll(() => logged(page)).toHaveLength(5);

  // Click the crate to select it, then Delete.
  const crate = await screen(page, canvas, 100, -200, 200);
  await page.mouse.click(crate.x, crate.y);
  await expect(viewport).toHaveAttribute('data-selected', 'entity-2');
  await page.keyboard.press('Delete');
  await expect.poll(() => logged(page)).toHaveLength(6);

  expect(await logged(page)).toEqual([
    'toolbelt.select',
    'entity.place',
    'toolbelt.select',
    'entity.place',
    'entity.move',
    'entity.delete',
  ]);
  expect(await hash(page)).toBe(MOUSE_HASH);
  await expect.poll(() => stats(page)).toMatchObject({ entities: 1, recipes: 1 });
});

test('keyboard only: pick a prop, Enter places it at the reticle, M and Enter move it', async ({ page }) => {
  const { viewport, canvas } = await open(page);
  await page.mouse.move(0, 0); // keep the pointer off the canvas: the reticle aims
  await page.keyboard.press('Digit3');
  await expect(viewport).toHaveAttribute('data-placement-ref', 'prop.spool');
  await expect(viewport).toHaveAttribute('data-placement-valid', 'true');
  await expect(page.locator('ctl-viewport .crosshair')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(() => logged(page)).toEqual(['toolbelt.select', 'entity.place']);
  await page.keyboard.press('Escape');
  await expect(viewport).not.toHaveAttribute('data-placing', /.*/);

  // Cycle to the spool and pick it up; focus the rail first so the reticle lands on it.
  await expect.poll(() => viewportHook(page, (h) => h.selectables().map((s) => s.id))).toContain('entity-1');
  await page.keyboard.press('BracketRight');
  await page.keyboard.press('BracketRight');
  await expect(viewport).toHaveAttribute('data-selected', 'din-rail-1');
  await page.keyboard.press('KeyF');
  await expect(viewport).toHaveAttribute('data-focus', 'din-rail-1');
  for (let i = 0; i < 2; i++) await page.keyboard.press('BracketRight');
  await expect(viewport).toHaveAttribute('data-selected', 'entity-1');
  await page.keyboard.press('KeyM');
  await expect(viewport).toHaveAttribute('data-placing', 'move');
  await expect(viewport).toHaveAttribute('data-placement-target', 'din-rail-1');
  await page.keyboard.press('Enter');
  await expect.poll(() => logged(page)).toEqual(['toolbelt.select', 'entity.place', 'view.focus', 'entity.move']);
  await canvas.focus();
  await page.keyboard.press('Delete');
  await expect.poll(() => logged(page)).toHaveLength(5);
  await expect.poll(() => stats(page)).toMatchObject({ entities: 0, recipes: 0 });
});

test('placing and deleting returns GPU geometry and BVHs to baseline', async ({ page }) => {
  const { canvas } = await open(page);
  // Let the hover and selection outlines exist first, so the baseline includes them.
  const plate = await screen(page, canvas, 0, 0, 0);
  await page.mouse.move(plate.x, plate.y);
  await viewportHook(page, (h) => h.select('backplate'));
  await page.waitForTimeout(300);
  await viewportHook(page, (h) => h.select(null));
  const viewport = page.locator('ctl-viewport');
  await page.keyboard.press('Digit1');
  await expect(viewport).toHaveAttribute('data-placement-valid', 'true');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape'); // the ghost gives its geometry back
  await expect(viewport).not.toHaveAttribute('data-placing', /.*/);
  await page.waitForTimeout(300);
  const baseline = await stats(page);

  await page.keyboard.press('Digit1');
  await expect(viewport).toHaveAttribute('data-placement-valid', 'true');
  await page.mouse.click(plate.x, plate.y);
  await expect.poll(() => logged(page)).toEqual(['toolbelt.select', 'toolbelt.select', 'entity.place']);
  await page.keyboard.press('Digit2');
  await expect(viewport).toHaveAttribute('data-placement-ref', 'prop.crate');
  const low = await screen(page, canvas, 100, -200, 0);
  await page.mouse.move(low.x, low.y);
  await expect(viewport).toHaveAttribute('data-placement-valid', 'true');
  await page.mouse.click(low.x, low.y);
  await expect.poll(() => logged(page)).toHaveLength(5);
  await page.keyboard.press('Escape');
  await expect.poll(() => stats(page)).toMatchObject({ entities: 2, recipes: 2, bvhs: baseline.bvhs + 2 });
  for (const id of ['entity-1', 'entity-2']) {
    await viewportHook(page, (h, target) => h.select(target as string), id);
    await canvas.focus();
    await page.keyboard.press('Delete');
  }
  await expect.poll(() => stats(page)).toMatchObject({ entities: 0, recipes: 0, bvhs: baseline.bvhs });
  await page.waitForTimeout(300);
  expect((await stats(page)).geometries).toBe(baseline.geometries);
});
