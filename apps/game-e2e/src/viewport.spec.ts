import { expect, test, type Page } from '@playwright/test';
import { startSandbox } from './support/sandbox';

/**
 * F1.7 cameras, picking and selection. Drives the renderer through the `?e2e=1` test hook and
 * real keyboard/mouse input on the canvas, and asserts on view state (host data attributes).
 * Pointer lock is never asserted: it is flaky in headless CI (plan F1.7 risks).
 * Forced WebGL2, the backend CI exercises on GPU-less runners.
 */

/** The slice of `ViewportRenderer` the hook exposes (e2e projects may not import workspace libs). */
interface ViewportHook {
  setMode(mode: 'walk' | 'work'): void;
  focus(id: string): boolean;
  select(id: string | null): boolean;
  selectNext(): { id: string } | null;
  selectables(): ReadonlyArray<{ id: string; kind: string }>;
  pickAt(x: number, y: number): { id: string } | null;
  cameraPositionMm(): { x: number; y: number; z: number } | undefined;
  stats(): { geometries: number; bvhs: number; avgMs: number; frames: number };
}

declare global {
  interface Window {
    __controlsViewport?: ViewportHook;
  }
}

const hook = <T>(page: Page, fn: (h: ViewportHook) => T) =>
  page.evaluate((src) => {
    const h = window.__controlsViewport;
    if (!h) throw new Error('viewport hook missing');
    return new Function('h', `return (${src})(h)`)(h) as T;
  }, fn.toString());

/** The session's replay log as `id args` strings (view commands are logged; input actions never are). */
const logged = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __controlsSession: { entries(): Array<{ id: string; args: unknown }> } }).__controlsSession
      .entries()
      .map((e) => `${e.id} ${JSON.stringify(e.args)}`),
  );

async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?e2e=1&renderer=webgl2');
  // The game boots to the main menu over an inert viewport; start a sandbox to interact with it.
  await startSandbox(page);
  const viewport = page.locator('ctl-viewport');
  await expect(viewport).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(viewport).toHaveAttribute('data-backend', 'webgl2');
  return viewport;
}

test('starts in work mode focused on the backplate', async ({ page }) => {
  const viewport = await open(page);
  await expect(viewport).toHaveAttribute('data-mode', 'work');
  await expect(viewport).toHaveAttribute('data-focus', 'backplate');
  // The workshop's fixtures (F1.9), in id order; the floor is not selectable.
  expect(await hook(page, (h) => h.selectables().map((s) => `${s.kind}:${s.id}`))).toEqual([
    'board:backboard',
    'backplate:backplate',
    'bench:bench',
    'din-rail:din-rail-1',
    'din-rail:din-rail-2',
    'wall:stud-wall',
  ]);
});

test('mode switching and focus through the renderer API', async ({ page }) => {
  const viewport = await open(page);
  await hook(page, (h) => h.setMode('walk'));
  await expect(viewport).toHaveAttribute('data-mode', 'walk');
  await expect(page.getByTestId('viewport-status')).toContainText('Walk');
  expect(await hook(page, (h) => h.focus('din-rail-1'))).toBe(true);
  await expect(viewport).toHaveAttribute('data-mode', 'work');
  await expect(viewport).toHaveAttribute('data-focus', 'din-rail-1');
  expect(await hook(page, (h) => h.focus('no-such-thing'))).toBe(false);
});

test('keyboard: cycle selection, focus it (view.focus), toggle walk mode (view.mode) and walk', async ({ page }) => {
  const viewport = await open(page);
  await page.locator('ctl-viewport canvas').focus();
  await page.keyboard.press('BracketRight');
  await expect(viewport).toHaveAttribute('data-selected', 'backboard');
  await page.keyboard.press('BracketRight');
  await expect(viewport).toHaveAttribute('data-selected', 'backplate');
  await expect(viewport).toHaveAttribute('data-selection-kind', 'backplate');
  await page.keyboard.press('BracketRight');
  await expect(viewport).toHaveAttribute('data-selection-kind', 'bench');
  await page.keyboard.press('BracketRight');
  await expect(viewport).toHaveAttribute('data-selected', 'din-rail-1');
  await expect(page.getByTestId('viewport-status')).toContainText('DIN rail 1');
  await page.keyboard.press('KeyF');
  await expect(viewport).toHaveAttribute('data-focus', 'din-rail-1');
  expect(await logged(page)).toEqual(['view.focus {"target":"din-rail-1"}']);
  await page.keyboard.press('Escape');
  await expect(viewport).not.toHaveAttribute('data-selected', /.*/);

  await page.keyboard.press('KeyV');
  await expect(viewport).toHaveAttribute('data-mode', 'walk');
  expect(await logged(page)).toEqual(['view.focus {"target":"din-rail-1"}', 'view.mode {"mode":"walk"}']);
  const before = await hook(page, (h) => h.cameraPositionMm());
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(400);
  await page.keyboard.up('KeyW');
  const after = await hook(page, (h) => h.cameraPositionMm());
  expect(after?.z).toBeLessThan(before?.z ?? 0);
  expect(after?.z).toBeGreaterThanOrEqual(140); // the workshop floor starts at z = -110, plus the 250 mm body radius
  expect(after?.y).toBe(400); // floor −1200 mm + 1600 mm eye height
});

test('mouse: BVH hover and click-to-select on the panel', async ({ page }) => {
  const viewport = await open(page);
  const box = await page.locator('ctl-viewport canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(viewport).toHaveAttribute('data-hovered', 'backplate');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(viewport).toHaveAttribute('data-selected', 'backplate');
  // Round the panel is the open stud wall the backboard is fixed to (F1.9).
  await page.mouse.click(box.x + 4, box.y + 4);
  await expect(viewport).toHaveAttribute('data-selected', 'stud-wall');
  await expect(viewport).toHaveAttribute('data-selection-kind', 'wall');
  await page.keyboard.press('Escape');
  await expect(viewport).not.toHaveAttribute('data-selected', /.*/);
});

test('hover and selection churn allocates no GPU geometry', async ({ page }) => {
  await open(page);
  // Let the first selection create its outline, then measure.
  await hook(page, (h) => h.select('backplate'));
  await page.waitForTimeout(300);
  const baseline = await hook(page, (h) => h.stats());
  await hook(page, (h) => {
    for (let i = 0; i < 60; i++) h.selectNext();
  });
  await page.waitForTimeout(300);
  const after = await hook(page, (h) => h.stats());
  expect(after.geometries).toBe(baseline.geometries);
  // One BVH per fixture geometry: board, plate, bench (top, frame, shelf), the rails' shared one,
  // and the stud wall's framing and snap plane.
  expect(after.bvhs).toBe(8);
  expect(after.frames).toBeGreaterThan(baseline.frames);
});
