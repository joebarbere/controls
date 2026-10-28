import { expect, test, type Page } from '@playwright/test';
import { startSandbox } from './support/sandbox';

/**
 * F1.9: the workshop level's pixel baseline. One image, because the scene-graph JSON snapshot in
 * `libs/rendering/renderer` already pins the structure; this one catches what only pixels show
 * (recipes drawing at all, materials, lights, the backend). Kept stable by fixing everything that
 * varies:
 *
 * - **Seed and world:** New sandbox with seed 0, then the same six props placed through the
 *   session hook (positions are `placeOnTargets` results, so they sit exactly on the backplate,
 *   DIN rail, stud wall and bench top).
 * - **Backend and rasteriser:** `?renderer=webgl2` and Chromium's SwiftShader (`--use-angle=swiftshader`),
 *   so a developer's GPU and a GPU-less CI runner rasterise the same way. Linux only: the baseline
 *   is `workshop-chromium-linux.png`; other OSes skip (their ANGLE/SwiftShader builds differ).
 * - **Size and DPR:** a 1280 × 720 viewport at device scale factor 1.
 * - **Camera:** `view.focus --target stud-wall` (an overview of the whole back wall), with the
 *   pointer off the canvas so no hover outline is drawn and nothing is selected.
 * - **HUD, text and focus ring:** hidden by a screenshot-only stylesheet (the shell HUD, the dev
 *   frame-time HUD, which only dev builds show, and the canvas focus outline), so the dev server and
 *   CI's production build capture the same pixels. Only the canvas is captured.
 * - **Tolerance:** per-pixel colour threshold 0.2 and at most 1 % of pixels different, for
 *   rasteriser rounding; Playwright also waits for two identical frames first.
 *
 * Updating the baseline (owner: `test-engineer`): after an intended visual change, run
 *   pnpm nx run game-e2e:e2e -- workshop.spec.ts --update-snapshots
 * on Linux, look at the new PNG, and commit it with the change. See docs/caveats/rendering.md.
 */

test.skip(process.platform !== 'linux', 'The workshop baseline is rendered with SwiftShader on Linux only');
test.use({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
});

interface Hooks {
  __controlsSession?: { exec(id: string, args?: unknown): { ok: boolean }; hash(): string };
  __controlsViewport?: { focus(id: string): boolean; select(id: string | null): boolean };
}

/** Screenshot-only stylesheet: no HUDs, crosshair or focus ring over the canvas. */
const HIDE_OVERLAYS =
  'ctl-hud, [data-testid="dev-hud"], .crosshair { visibility: hidden !important; } ' +
  'canvas { outline: none !important; }';

const PROPS: ReadonlyArray<readonly [string, { x: number; y: number; z: number }, number]> = [
  ['prop.box', { x: -210, y: 260, z: 0 }, 0], // backplate grid
  ['prop.box', { x: -75, y: -90, z: 0 }, 0], // DIN rail 2
  ['prop.box', { x: -2055, y: -40, z: -21 }, 0], // stud wall, against a stud
  ['prop.box', { x: -1242, y: 260, z: -21 }, 0],
  ['prop.crate', { x: 1150, y: -300, z: 600 }, 270_000], // bench top: stood up (pitch -90°)
  ['prop.spool', { x: 1930, y: -300, z: 470 }, 270_000],
];

async function placeProps(page: Page) {
  const results = await page.evaluate((props) => {
    const session = (window as unknown as Hooks).__controlsSession;
    if (!session) throw new Error('session hook missing');
    return props.map(([id, positionMm, pitch]) =>
      session.exec('entity.place', {
        ref: { id, version: 1 },
        positionMm,
        orientationMdeg: { yaw: 0, pitch, roll: 0 },
      }),
    );
  }, PROPS);
  expect(results.every((r) => r.ok)).toBe(true);
}

test('the workshop level matches its screenshot baseline (seed 0, WebGL2, DPR 1)', async ({ page }) => {
  await page.goto('/?e2e=1&renderer=webgl2');
  await startSandbox(page, 0);
  const viewport = page.locator('ctl-viewport');
  await expect(viewport).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(viewport).toHaveAttribute('data-backend', 'webgl2');
  await placeProps(page);
  await page.mouse.move(0, 0); // off the canvas: no hover outline
  const focused = await page.evaluate(() => {
    const view = (window as unknown as Hooks).__controlsViewport;
    view?.select(null);
    return view?.focus('stud-wall') ?? false;
  });
  expect(focused).toBe(true);
  await expect(viewport).toHaveAttribute('data-focus', 'stud-wall');
  await expect(viewport).not.toHaveAttribute('data-hovered', /.*/);

  // Overlays drawn over the canvas vary by build (the dev HUD) and by frame (its numbers): hide them.
  await page.addStyleTag({ content: HIDE_OVERLAYS });
  await expect(page.locator('ctl-viewport canvas')).toHaveScreenshot('workshop.png', {
    threshold: 0.2,
    maxDiffPixelRatio: 0.01,
    animations: 'disabled',
    caret: 'hide',
    timeout: 30_000,
  });
});
