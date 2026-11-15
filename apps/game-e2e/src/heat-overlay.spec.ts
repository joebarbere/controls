import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startSandbox } from './support/sandbox';

/**
 * F3.6 part 3 renderer half: the heat overlay on the real sim worker (Chromium, WebGL2). The
 * bad-termination scenario (a 20 %-torque breaker screw on 14 AWG THHN, 600 s at about 11.8 A; the
 * `wire.info` golden has its loose end a at 393.8 K on a 303.0 K conductor) runs through the in-game
 * console's `run`; then `view.overlay heat true` from the console. The overlay graph (the `?e2e=1`
 * hook) shows the loose wire's end-a half hot (the overheat point, bin 16 of the heat scale) and its
 * other half cool; the good wire both cool; the two leads their conductors. The legend names the
 * scale's sourced points in text, and nothing logs a page or console error. Waits are on the page's
 * own state, never on time.
 */

type Heat = [number | 'unknown', number | 'unknown'];
interface Graph {
  heat: boolean;
  conductors: { connection: number; heat: Heat }[];
  leads: { connection: number; heat: Heat }[];
}
type Hooks = {
  __controlsViewport?: {
    overlayGraph(): Graph | undefined;
    wireGraph(): { routes: { owner: string; tint: [string, string] | null }[] } | undefined;
  };
};
const graph = (page: Page) =>
  page.evaluate(() => (window as unknown as Hooks).__controlsViewport?.overlayGraph() ?? null);

/** Page errors and console errors, collected from the start of a test (none are expected). */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

test('the heat overlay shows the bad termination’s hot end, with a legend (F3.6 part 3)', async ({ page }) => {
  test.slow(); // 600 s of sim time in the worker, then software WebGL2 key round trips
  const errors = collectErrors(page);
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
  await page.keyboard.insertText('view.overlay heat true');
  await page.keyboard.press('Enter');
  await expect(output.last()).toHaveText(/view\.overlay: ok/);
  await expect(viewport).toHaveAttribute('data-overlays', 'heat');

  // Wire 2's loose end a (393.8 K) is at the overheat point; its other half is its 303 K conductor.
  await expect
    .poll(async () => (await graph(page))?.conductors.find((c) => c.connection === 2)?.heat)
    .toStrictEqual([16, 1]);
  const g = await graph(page);
  expect(g?.heat).toBe(true);
  // Wire 1 (both ends at their marked torque) stays in the service range's first bins.
  const good = g?.conductors.find((c) => c.connection === 1)?.heat;
  expect(good?.map((h) => typeof h === 'number' && h <= 3)).toStrictEqual([true, true]);
  // The leads (connections 3 and 4) have clip ends: both halves show their conductor, a reading.
  expect(g?.leads.map((l) => [l.connection, l.heat[0] === l.heat[1], typeof l.heat[0]])).toStrictEqual([
    [3, true, 'number'],
    [4, true, 'number'],
  ]);
  // The wire renderer draws the two halves of wire 2 in different colours.
  const tint = await page.evaluate(
    () => (window as unknown as Hooks).__controlsViewport?.wireGraph()?.routes.find((r) => r.owner === 'c2')?.tint,
  );
  expect(tint?.[0]).not.toBe(tint?.[1]);

  const legend = page.getByTestId('overlay-legend');
  await expect(legend.getByRole('heading', { name: 'Heat overlay' })).toBeVisible();
  const scale = legend.getByTestId('legend-heat-scale');
  for (const tick of [
    '293 K (20 °C) ambient',
    '363 K (90 °C) insulation rating',
    '393 K (120 °C) overheat',
    '933 K (660 °C) aluminium melts',
  ]) {
    await expect(scale.getByText(tick)).toBeVisible();
  }
  await expect(scale).toContainText('1358 K (1085 °C) and above: copper melts');
  await expect(legend.getByTestId('legend-heat-note')).toContainText('Each half shows its hottest point');

  // Off again: the legend goes, and the wires get their insulation colours back.
  await page.keyboard.insertText('view.overlay heat false');
  await page.keyboard.press('Enter');
  await expect(viewport).not.toHaveAttribute('data-overlays');
  await expect(legend).toHaveCount(0);
  expect(errors).toStrictEqual([]);
});
