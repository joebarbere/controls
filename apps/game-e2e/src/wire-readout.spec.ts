import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectOnCanvas } from './support/aim';
import { startSandbox } from './support/sandbox';

/**
 * F3.6 part 3 renderer half: the wire readout on the real sim worker (Chromium, WebGL2, 1280 × 720:
 * the mouse aims at projected pixels). The bad-termination scenario (a 20 %-torque breaker screw on
 * 14 AWG THHN, 600 s at about 11.8 A; the `wire.info` golden has its loose end a at 393.8 K on a
 * 303.0 K conductor) runs through the in-game console's `run`, and `view.focus entity-2` frames the
 * breaker. Then:
 *
 * - the mouse rests on wire 2 (a pixel the wire BVH picks, checked to be on the canvas): the readout
 *   shows end a's temperature separately from the conductor's, never covers the pointer, and the
 *   live region stays quiet (hovers aren't announced);
 * - keyboard only, with the pointer off the canvas: N selects wire 1, N again wire 2, and the readout
 *   follows the selection; the selection is announced once, with the same temperatures.
 *
 * Nothing logs a page or console error. Waits are on the page's own state, never on time.
 */

type Vec = { x: number; y: number; z: number };
type Hooks = {
  __controlsViewport?: {
    whenIdle(): Promise<void>;
    projectMm(p: Vec): { x: number; y: number } | undefined;
    pickWireAt(ndcX: number, ndcY: number): { kind: string; id: number } | null;
    pickAt(ndcX: number, ndcY: number): { kind: string } | null;
    wireGraph(): { routes: { owner: string; fromMm: [number, number, number] }[] } | undefined;
  };
};

/** Page errors and console errors, collected from the start of a test (none are expected). */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/**
 * Canvas pixels (CSS px) on connection `id`'s wire by the wire BVH with no device under them, nearest
 * its end a first, 25 to 320 px out, on a 4 px grid.
 */
async function pixelsOnWire(page: Page, id: number): Promise<{ x: number; y: number }[]> {
  return page.evaluate(async (wire) => {
    const hook = (window as unknown as Hooks).__controlsViewport;
    if (!hook) throw new Error('viewport hook missing');
    await hook.whenIdle();
    const route = hook.wireGraph()?.routes.find((r) => r.owner === `c${wire}`);
    if (!route) throw new Error(`wire ${wire} not drawn`);
    const [x, y, z] = route.fromMm;
    const end = hook.projectMm({ x, y, z });
    const canvas = document.querySelector('ctl-viewport canvas') as HTMLCanvasElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!end) throw new Error('no projection');
    const hits: { x: number; y: number; d: number }[] = [];
    for (let dy = -320; dy <= 320; dy += 4) {
      for (let dx = -320; dx <= 320; dx += 4) {
        const d = Math.sqrt(dx * dx + dy * dy);
        const px = end.x + dx;
        const py = end.y + dy;
        if (d < 25 || d > 320 || px < 0 || py < 0 || px >= w || py >= h) continue;
        const nx = (2 * px) / w - 1;
        const ny = 1 - (2 * py) / h;
        const hit = hook.pickWireAt(nx, ny);
        // Only where no device is under the ray: the wire then beats whatever is behind it.
        if (hit?.kind === 'connection' && hit.id === wire && hook.pickAt(nx, ny)?.kind !== 'device') {
          hits.push({ x: px, y: py, d });
        }
      }
    }
    return hits.sort((a, b) => a.d - b.d).map(({ x: hx, y: hy }) => ({ x: hx, y: hy }));
  }, id);
}

/**
 * Moves the mouse to the first of `candidates` (canvas px) that is on the canvas (no overlay over it)
 * and hovers wire `owner` there (the wire beats the device behind it), and returns that page point.
 */
async function hoverWire(
  page: Page,
  box: { x: number; y: number },
  candidates: readonly { x: number; y: number }[],
  owner: string,
): Promise<{ x: number; y: number }> {
  for (const p of candidates.slice(0, 12)) {
    const point = { x: box.x + p.x, y: box.y + p.y };
    const onCanvas = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', point);
    if (!onCanvas) continue;
    await page.mouse.move(point.x, point.y);
    try {
      await page.waitForSelector(`ctl-viewport[data-wire-hovered="${owner}"]`, { timeout: 3_000 });
      return point;
    } catch {
      // the device in front won at this pixel: try the next one
    }
  }
  const state = await page.evaluate(() => {
    const v = document.querySelector('ctl-viewport');
    return `hovered ${v?.getAttribute('data-hovered')} wire ${v?.getAttribute('data-wire-hovered')}`;
  });
  throw new Error(`no pixel on ${owner} hovers it (${JSON.stringify(candidates.slice(0, 12))}; ${state})`);
}

/** The temperature in kelvin at the start of `text` (`394 K (121 °C)`). */
const kelvin = (text: string | null) => Number(/(\d+) K/.exec(text ?? '')?.[1] ?? NaN);

test('the wire readout shows the bad termination’s hot end apart from its conductor, by mouse and keyboard (F3.6 part 3)', async ({
  page,
}) => {
  test.slow(); // 600 s of sim time in the worker, then software WebGL2 at 1280 × 720
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 }); // the mouse aims at projected pixels
  await page.goto('/?e2e=1&renderer=webgl2');
  await startSandbox(page);
  const viewport = page.locator('ctl-viewport');
  await expect(viewport).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  await page.keyboard.press('Backquote');
  const input = page.getByRole('textbox', { name: 'Console input' });
  await expect(input).toBeFocused();
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.type('run');
  await page.keyboard.press('Enter');
  const text = readFileSync(join(__dirname, '../../sim-cli/scenarios/bad-termination.console'));
  await (await chooser).setFiles({ name: 'bad-termination.console', mimeType: 'text/plain', buffer: text });
  const output = page.getByTestId('console-output').locator('.entry');
  await expect(output.last()).toHaveText('Ran 10 commands from bad-termination.console.', { timeout: 60_000 });
  await expect(input).toBeFocused();
  await page.keyboard.insertText('view.focus entity-2');
  await page.keyboard.press('Enter');
  await expect(output.last()).toHaveText(/view\.focus: ok/);
  await page.keyboard.press('Backquote'); // close the console
  await expect(viewport).toHaveAttribute('data-mode', 'work');

  // Mouse: rest on wire 2, at the first pixel the wire wins over the breaker behind it.
  const box = await page.locator('ctl-viewport canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  const candidates = await pixelsOnWire(page, 2);
  expect(candidates.length, 'wire 2 has pickable pixels near the breaker').toBeGreaterThan(0);
  const at = await hoverWire(page, box, candidates, 'c2');
  const readout = page.getByRole('region', { name: 'Wire readout: Wire 2' });
  await expect(readout).toBeVisible();
  await expect(readout).toHaveAttribute('data-source', 'hover');
  await expect(readout.getByTestId('wire-readout-current')).toHaveText(/^Current 11\.\d A$/);
  const conductor = readout.getByRole('row', { name: /^Conductor / });
  const endA = readout.getByRole('row', { name: /^End a / });
  const endB = readout.getByRole('row', { name: /^End b / });
  // The loose end a near 394 K, its conductor near 303 K and end b near 302 K: shown apart.
  await expect.poll(async () => kelvin(await endA.locator('td').nth(1).textContent())).toBeGreaterThanOrEqual(390);
  expect(kelvin(await conductor.locator('td').nth(1).textContent())).toBeLessThan(320);
  expect(kelvin(await endB.locator('td').nth(1).textContent())).toBeLessThan(320);
  await expect(endA.locator('td').nth(0)).toHaveText(/^\d+(\.\d+)? mV$/);
  await expect(readout.getByTestId('wire-readout-state')).toHaveText('State: overheating at end a');
  // It never covers the pick target: the pointer is still over the canvas, outside the panel.
  await expectOnCanvas(page, at, 'the hovered wire');
  const panel = await readout.boundingBox();
  if (!panel) throw new Error('no panel box');
  const inside = at.x >= panel.x && at.x <= panel.x + panel.width && at.y >= panel.y && at.y <= panel.y + panel.height;
  expect(inside, 'the readout sits away from the pointer').toBe(false);
  const status = page.getByTestId('wire-status');
  await expect(status).toHaveText(''); // a hover isn't announced

  // Keyboard: the pointer leaves the canvas, then N, N select wire 1 and wire 2.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 40);
  await expect(viewport).not.toHaveAttribute('data-wire-hovered');
  await expect(readout).toHaveCount(0);
  await page.locator('ctl-viewport canvas').focus();
  await expect(page.locator('ctl-viewport canvas')).toBeFocused();
  await page.keyboard.press('N');
  await expect(viewport).toHaveAttribute('data-wire-selected', 'c1');
  await expect(status).toContainText('Wire 1 selected.');
  await page.keyboard.press('N');
  await expect(viewport).toHaveAttribute('data-wire-selected', 'c2');
  await expect(readout).toHaveAttribute('data-source', 'selection');
  await expect(readout.getByTestId('wire-readout-state')).toHaveText('State: overheating at end a');
  await expect(status).toContainText('Wire 2 selected. Current 11.');
  const said = (await status.textContent()) ?? '';
  expect(kelvin(/End a ([^,]+)/.exec(said)?.[1] ?? null)).toBeGreaterThanOrEqual(390);
  expect(kelvin(/Conductor ([^,]+)/.exec(said)?.[1] ?? null)).toBeLessThan(320);
  // Shift+N goes back; Escape clears the wire and the readout goes.
  await page.keyboard.press('Shift+N');
  await expect(viewport).toHaveAttribute('data-wire-selected', 'c1');
  await page.keyboard.press('Escape');
  await expect(viewport).not.toHaveAttribute('data-wire-selected');
  await expect(page.getByTestId('wire-readout')).toHaveCount(0);
  expect(errors).toStrictEqual([]);
});
