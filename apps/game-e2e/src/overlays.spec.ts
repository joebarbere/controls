import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startSandbox } from './support/sandbox';

/**
 * F2.6 debug overlays with the real sim worker: `apps/sim-cli/scenarios/sim-step.console` builds the
 * bench (a battery shorted by a closed switch through two test leads, and an unwired lamp) and steps
 * 1.234 s. Then `view.overlay` from the console and from the palette switches the voltage and
 * current overlays. Every island is in band 0 until sources choose a nominal band, so the voltage
 * overlay shows "no scale" on the battery loop, never a 0 V colour; the lamp's island is not solved
 * yet, so its terminals show no reading. The current overlay shows the short's current on both
 * leads, with its direction (DC). Waits are on the page's own state (`data-overlays`, the overlay
 * graph from the `?e2e=1` hook, the legend), never on time.
 */

type Volts = number | 'noScale' | 'unknown';
interface Graph {
  voltage: boolean;
  current: boolean;
  reducedMotion: boolean;
  inScene: boolean;
  terminals: { entity: number; terminal: string; volts: Volts }[];
  leads: { connection: number; volts: [Volts, Volts]; amps: number | 'unknown'; direction: string; arrows: number }[];
}
type Hooks = {
  __controlsViewport?: { overlayGraph(): Graph | undefined };
  __controlsSession?: {
    waitForTick(tick: number): Promise<void>;
    entries(): ReadonlyArray<{ id: string; args: unknown }>;
  };
};

/**
 * What the overlays draw: their CPU-side state, read straight away. Not after `whenIdle()`, which
 * never resolves while current arrows animate (a running sim): poll this instead.
 */
const graph = (page: Page) =>
  page.evaluate(() => (window as unknown as Hooks).__controlsViewport?.overlayGraph() ?? null);

/** Types one line into the focused console input and waits for its own `ok`. */
async function runConsoleLine(page: Page, line: string): Promise<void> {
  const input = page.getByRole('textbox', { name: 'Console input' });
  await expect(input).toBeFocused();
  await page.keyboard.insertText(line);
  await expect(input).toHaveText(line);
  await page.keyboard.press('Enter');
  await expect(input).toHaveText('');
  await expect(page.getByTestId('console-output').locator('.entry').last()).toHaveText(/view\.overlay: ok/);
}

test('voltage and current overlays from the console and the palette, on the real sim worker', async ({ page }) => {
  test.slow(); // software WebGL2 makes each key round trip slow on CI runners
  await page.goto('/?e2e=1&renderer=webgl2');
  await startSandbox(page);
  const viewport = page.locator('ctl-viewport');
  await expect(viewport).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  await expect(viewport).not.toHaveAttribute('data-overlays');

  // Build the bench in the worker.
  await page.keyboard.press('Backquote');
  await expect(page.getByRole('textbox', { name: 'Console input' })).toBeFocused();
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.type('run');
  await page.keyboard.press('Enter');
  const text = readFileSync(join(__dirname, '../../sim-cli/scenarios/sim-step.console'));
  await (await chooser).setFiles({ name: 'sim-step.console', mimeType: 'text/plain', buffer: text });
  await expect(page.getByTestId('console-output').locator('.entry').last()).toHaveText(
    'Ran 7 commands from sim-step.console.',
  );
  await page.evaluate(() => (window as unknown as Hooks).__controlsSession?.waitForTick(1234));

  // Console: both overlays on (positional words: name, then on).
  await runConsoleLine(page, 'view.overlay voltage true');
  await runConsoleLine(page, 'view.overlay --name current --on true');
  await expect(viewport).toHaveAttribute('data-overlays', 'current voltage');

  await expect
    .poll(async () =>
      (await graph(page))?.leads.map((l) => l.amps !== 'unknown' && l.amps > 0 && l.direction !== 'none'),
    )
    .toEqual([true, true]);
  const g = (await graph(page)) as Graph;
  expect(g).toMatchObject({ voltage: true, current: true, inScene: true });
  // Band 0: the battery loop has no voltage scale. Never 0 V, never bin 0.
  expect(g.terminals.filter((t) => t.entity !== 3).map((t) => t.volts)).toEqual(Array(4).fill('noScale'));
  expect(g.leads.flatMap((l) => l.volts)).toEqual(Array(4).fill('noScale'));
  // The unwired lamp is not solved: no reading.
  expect(g.terminals.filter((t) => t.entity === 3).map((t) => t.volts)).toEqual(['unknown', 'unknown']);
  // The short runs from the battery's + through lead 1 (pos → switch a) and back through lead 2 (switch b → neg).
  expect(g.leads.map((l) => l.direction)).toEqual(['a→b', 'a→b']);

  const legend = page.getByTestId('overlay-legend');
  await expect(legend).toBeVisible();
  await expect(legend.getByRole('heading', { name: 'Voltage overlay' })).toBeVisible();
  await expect(legend.getByTestId('legend-no-scale')).toHaveText(/No nominal band: no voltage scale/);
  await expect(legend.getByTestId('legend-unknown')).toHaveText(/No reading/);
  await expect(legend.getByTestId('legend-current-scale')).toContainText('100 mA');
  await expect(legend.getByTestId('legend-current-motion')).toContainText('Arrows travel with DC current');

  // prefers-reduced-motion: the arrows stand still, and the legend says so.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(async () => (await graph(page))?.reducedMotion).toBe(true);
  await expect(legend.getByTestId('legend-current-motion')).toContainText('stand still (reduced motion)');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // Palette: the generated form switches the current overlay off (Show unchecked).
  await page.keyboard.press('Escape'); // close the console; focus returns to the canvas
  await expect(page.locator('ctl-viewport canvas')).toBeFocused();
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  const search = palette.getByRole('combobox', { name: 'Search commands' });
  // Type only once the search field has focus: keys pressed while the palette opens go elsewhere.
  await page.keyboard.press('Control+K');
  await expect(search).toBeFocused();
  await page.keyboard.type('debug overlay');
  await expect(palette.getByRole('option').first()).toHaveAttribute('data-command', 'view.overlay');
  await page.keyboard.press('Enter');
  const form = palette.getByRole('form', { name: 'Arguments for Show or hide a debug overlay' });
  await expect(form).toBeVisible();
  await form.getByRole('combobox', { name: 'Overlay' }).selectOption({ label: 'current' });
  await expect(form.getByRole('checkbox', { name: 'Show' })).not.toBeChecked();
  await form.getByRole('button', { name: 'Run' }).click();
  await expect(palette).toBeHidden();
  await expect(viewport).toHaveAttribute('data-overlays', 'voltage');
  await expect(legend.getByRole('heading', { name: 'Current overlay' })).toBeHidden();
  expect((await graph(page))?.leads.every((l) => l.arrows === 0)).toBe(true);

  // And the voltage overlay off: no overlay, no legend, nothing of the overlays left in the scene.
  await page.keyboard.press('Control+K');
  await expect(search).toBeFocused();
  await page.keyboard.type('debug overlay');
  await expect(palette.getByRole('option').first()).toHaveAttribute('data-command', 'view.overlay');
  await page.keyboard.press('Enter');
  await expect(form).toBeVisible();
  await form.getByRole('combobox', { name: 'Overlay' }).selectOption({ label: 'voltage' });
  await form.getByRole('button', { name: 'Run' }).click();
  await expect(palette).toBeHidden();
  await expect(viewport).not.toHaveAttribute('data-overlays');
  await expect(legend).toBeHidden();
  expect((await graph(page))?.inScene).toBe(false);

  // Every switch was a logged view command, with its arguments.
  const overlays = await page.evaluate(() =>
    ((window as unknown as Hooks).__controlsSession?.entries() ?? [])
      .filter((e) => e.id === 'view.overlay')
      .map((e) => e.args),
  );
  expect(overlays).toEqual([
    { name: 'voltage', on: true },
    { name: 'current', on: true },
    { name: 'current', on: false },
    { name: 'voltage', on: false },
  ]);
});
