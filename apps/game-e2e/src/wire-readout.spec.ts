import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectOnCanvas } from './support/aim';
import { startSandbox } from './support/sandbox';

/**
 * F3.6 part 3 renderer half: the wire readout on the real sim worker (Chromium, WebGL2, 1280 × 720:
 * the mouse aims at projected pixels). The bad-termination scenario (the P3 acceptance's lamp circuit
 * with a 20 %-torque breaker screw on its 14 AWG THHN jumper, plus the 1500 W heater: 600 s at about
 * 12.84 A; the `wire.info` golden has its loose end a at 409.3 K on a 304.6 K conductor) runs through
 * the in-game console's `run`, and `view.focus entity-3` frames the breaker. Then:
 *
 * - the mouse rests on wire 1, the jumper (a pixel the hover rule gives to the wire, chosen in the page): the
 *   readout shows end a's temperature separately from the conductor's, with the state that
 *   temperature implies, never covers the pointer or takes it, and the live region stays quiet;
 * - a wire pixel under the panel's top-right corner moves the panel to the bottom left;
 * - keyboard only, with the pointer off the canvas: N selects wire 1 and the readout follows the
 *   selection, announced once with the same temperatures; N again selects wire 8 (routed wires by id),
 *   Shift+N goes back.
 *
 * Nothing logs a page or console error. Waits are on the page's own state, never on time.
 */

type Vec = { x: number; y: number; z: number };
type Hooks = {
  __controlsViewport?: {
    whenIdle(): Promise<void>;
    projectMm(p: Vec): { x: number; y: number } | undefined;
    hoverTargetAt(ndcX: number, ndcY: number): { entity: number | null; wire: { kind: string; id: number } | null };
    wireGraph(): { routes: { owner: string; fromMm: [number, number, number] }[] } | undefined;
  };
};

interface WirePixel {
  /** Page px. */
  readonly x: number;
  readonly y: number;
  /** The wire the hover rule gives the pixel to (`c2`, `k1`). */
  readonly owner: string;
  /** Distance (canvas px) from the `near` wire's end a. */
  readonly d: number;
}

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
 * Page pixels on a 4 px grid that the hover rule gives to a wire (the renderer's own rule through the
 * `?e2e=1` hook's `hoverTargetAt`, the `pickTarget` a pointer move uses: a device wins unless the wire
 * is more than 2 mm nearer, and near a terminal it isn't), where the canvas, not an overlay, is under
 * the point (the readout ignores the pointer, so it doesn't count). Sorted by distance from connection
 * `near`'s end a.
 */
async function wirePixels(page: Page, near: number): Promise<WirePixel[]> {
  return page.evaluate(async (wire) => {
    const hook = (window as unknown as Hooks).__controlsViewport;
    if (!hook) throw new Error('viewport hook missing');
    await hook.whenIdle();
    const route = hook.wireGraph()?.routes.find((r) => r.owner === `c${wire}`);
    if (!route) throw new Error(`wire ${wire} not drawn`);
    const [x, y, z] = route.fromMm;
    const end = hook.projectMm({ x, y, z });
    if (!end) throw new Error('no projection');
    const canvas = document.querySelector('ctl-viewport canvas') as HTMLCanvasElement;
    const box = canvas.getBoundingClientRect();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const hits: WirePixel[] = [];
    for (let py = 2; py < h; py += 4) {
      for (let px = 2; px < w; px += 4) {
        const nx = (2 * px) / w - 1;
        const ny = 1 - (2 * py) / h;
        const hit = hook.hoverTargetAt(nx, ny).wire;
        if (hit === null) continue;
        const at = { x: box.left + px, y: box.top + py };
        if (document.elementFromPoint(at.x, at.y)?.tagName !== 'CANVAS') continue;
        const owner = `${hit.kind === 'cable' ? 'k' : 'c'}${hit.id}`;
        hits.push({ ...at, owner, d: Math.sqrt((px - end.x) ** 2 + (py - end.y) ** 2) });
      }
    }
    return hits.sort((a, b) => a.d - b.d);
  }, near);
}

/** Whether page point `p` is inside `box`. */
const insideBox = (p: { x: number; y: number }, box: { x: number; y: number; width: number; height: number } | null) =>
  box !== null && p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;

/**
 * The state line for a loose end a showing `k` kelvin (whole, as displayed) on an otherwise normal
 * wire: overheating from ambient + 100 K (393.15 K, so a displayed 393 may be either way), degrading
 * above the oxidation onset (422.15 K, so a displayed 422 may be either way); `insulation damaged`
 * added once the hot spot has reached the rating + 40 K (403.15 K: sticky, so any later reading).
 */
function stateFor(k: number): RegExp {
  const damaged = k >= 404 ? ', insulation damaged' : k === 403 ? '(, insulation damaged)?' : '';
  if (k >= 423) return new RegExp(`^State: degrading at end a \\(above the oxidation onset\\)${damaged}$`);
  if (k === 422)
    return new RegExp(`^State: (degrading at end a \\(above the oxidation onset\\)|overheating at end a)${damaged}$`);
  if (k >= 394) return new RegExp(`^State: overheating at end a${damaged}$`);
  if (k === 393) return /^State: (overheating at end a|normal)$/;
  return /^State: normal$/;
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
  await expect(output.last()).toHaveText('Ran 43 commands from bad-termination.console.', { timeout: 60_000 });
  await expect(input).toBeFocused();
  await page.keyboard.insertText('view.focus entity-3');
  await page.keyboard.press('Enter');
  await expect(output.last()).toHaveText(/view\.focus: ok/);
  await page.keyboard.press('Backquote'); // close the console
  await expect(viewport).toHaveAttribute('data-mode', 'work');

  // Mouse: rest on wire 1, at the pixel nearest its loose end a that the hover rule gives to the wire.
  const box = await page.locator('ctl-viewport canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  const pixels = await wirePixels(page, 1);
  const at = pixels.find((p) => p.owner === 'c1');
  if (!at) throw new Error('no pixel of wire 1 that the hover rule picks');
  await page.mouse.move(at.x, at.y);
  await expect(viewport).toHaveAttribute('data-wire-hovered', 'c1');
  const readout = page.getByRole('region', { name: 'Wire readout: Wire 1' });
  await expect(readout).toBeVisible();
  await expect(readout).toHaveAttribute('data-source', 'hover');
  await expect(readout.getByTestId('wire-readout-current')).toHaveText(/^Current 12\.\d A$/);
  const conductor = readout.getByRole('row', { name: /^Conductor / });
  const endA = readout.getByRole('row', { name: /^End a / });
  const endB = readout.getByRole('row', { name: /^End b / });
  // The loose end a near 409 K, its conductor near 305 K and end b near 298 K: shown apart.
  await expect.poll(async () => kelvin(await endA.locator('td').nth(1).textContent())).toBeGreaterThanOrEqual(400);
  expect(kelvin(await conductor.locator('td').nth(1).textContent())).toBeLessThan(320);
  expect(kelvin(await endB.locator('td').nth(1).textContent())).toBeLessThan(320);
  await expect(endA.locator('td').nth(0)).toHaveText(/^\d+(\.\d+)? mV$/);
  const endAK = kelvin(await endA.locator('td').nth(1).textContent());
  await expect(readout.getByTestId('wire-readout-state')).toHaveText(stateFor(endAK));
  // It never covers the pick target, nor takes the pointer.
  await expectOnCanvas(page, at, 'the hovered wire');
  expect(insideBox(at, await readout.boundingBox()), 'the readout sits away from the pointer').toBe(false);
  const panel = page.locator('ctl-wire-readout');
  expect(await panel.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
  const status = page.getByTestId('wire-status');
  await expect(status).toHaveText(''); // a hover isn't announced

  // A wire under the panel's top-right corner: hovering it moves the panel to the bottom left.
  await expect(panel).toHaveAttribute('data-corner', 'top-right');
  const topRight = await readout.boundingBox();
  const under = pixels.find((p) => insideBox(p, topRight));
  if (!under) throw new Error('no wire pixel under the panel: the framing changed');
  await page.mouse.move(under.x, under.y);
  await expect(viewport).toHaveAttribute('data-wire-hovered', under.owner);
  await expect(panel).toHaveAttribute('data-corner', 'bottom-left');
  expect(insideBox(under, await page.getByTestId('wire-readout').boundingBox())).toBe(false);

  // Keyboard: the pointer leaves the canvas, then N selects wire 1 (routed wires first, by id).
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 40);
  await expect(viewport).not.toHaveAttribute('data-wire-hovered');
  await expect(page.getByTestId('wire-readout')).toHaveCount(0);
  await page.locator('ctl-viewport canvas').focus();
  await expect(page.locator('ctl-viewport canvas')).toBeFocused();
  await page.keyboard.press('N');
  await expect(viewport).toHaveAttribute('data-wire-selected', 'c1');
  await expect(readout).toHaveAttribute('data-source', 'selection');
  await expect(readout.getByTestId('wire-readout-state')).toHaveText(
    stateFor(kelvin(await endA.locator('td').nth(1).textContent())),
  );
  await expect(status).toContainText('Wire 1 selected. Current 12.');
  const said = (await status.textContent()) ?? '';
  expect(kelvin(/End a ([^,]+)/.exec(said)?.[1] ?? null)).toBeGreaterThanOrEqual(400);
  expect(kelvin(/Conductor ([^,]+)/.exec(said)?.[1] ?? null)).toBeLessThan(320);
  // N again: the next routed wire, the supply's L1 (wire 8). Skipping wires 2–7 is by design: they are
  // cable conductors, and N's order (`wireCycleOrder`, workspace) is routed single conductors by id,
  // then whole cables (k1, k2), never a cable's conductors one by one. Shift+N goes back; Escape clears
  // the wire and the readout goes.
  await page.keyboard.press('N');
  await expect(viewport).toHaveAttribute('data-wire-selected', 'c8');
  await expect(status).toContainText('Wire 8 selected.');
  await page.keyboard.press('Shift+N');
  await expect(viewport).toHaveAttribute('data-wire-selected', 'c1');
  await page.keyboard.press('Escape');
  await expect(viewport).not.toHaveAttribute('data-wire-selected');
  await expect(page.getByTestId('wire-readout')).toHaveCount(0);
  expect(errors).toStrictEqual([]);
});
