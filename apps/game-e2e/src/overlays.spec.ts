import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startSandbox } from './support/sandbox';

/**
 * F2.6 debug overlays with the real sim worker: `apps/sim-cli/scenarios/sim-step.console` builds the
 * bench (a battery shorted by a closed switch through two test leads, and an unwired lamp) and steps
 * 1.234 s. Then `view.overlay` from the console and from the palette switches the voltage and
 * current overlays. Since protocol 5 each island's sources choose a nominal band: the battery loop
 * is `dc12` (16 V full scale, 0.5 V a bin), so the voltage overlay colours it from real volts, while
 * the unwired lamp's island has no source and shows "no scale", never a 0 V colour. A second battery
 * tied to a utility service is a mixed island, which isn't solved, so it shows no reading. Then a
 * third battery lights the lamp: its 12 V terminal sits near bin 25 of the 12 V DC scale. The current overlay shows the short's current on both
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

/** Types one command line into the focused console input and waits for its own `ok`. */
async function runConsoleLine(page: Page, line: string): Promise<void> {
  const input = page.getByRole('textbox', { name: 'Console input' });
  await expect(input).toBeFocused();
  await page.keyboard.insertText(line);
  await expect(input).toHaveText(line);
  await page.keyboard.press('Enter');
  await expect(input).toHaveText('');
  const id = line.split(' ')[0].replace('.', '\\.');
  await expect(page.getByTestId('console-output').locator('.entry').last()).toHaveText(new RegExp(`${id}: ok`));
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
  // A circuit the engine can't solve: a second battery tied to a utility service by one lead is a
  // mixed DC and AC island (P2 has no converters), so it has no reading.
  await runConsoleLine(
    page,
    'entity.place --ref.id battery.ferrovane-12v-7ah --ref.version 1 --positionMm.x 900 --positionMm.y -300 --positionMm.z 500',
  );
  await runConsoleLine(
    page,
    'entity.place --ref.id utility.larkmoor-split-phase-25kva --ref.version 1 --positionMm.x 1200 --positionMm.y -300 --positionMm.z 500',
  );
  await runConsoleLine(
    page,
    'lead.connect --ref.id lead.quillfern-test-1m --ref.version 1 --a.entity 4 --a.terminal neg --b.entity 5 --b.terminal n',
  );

  // Console: both overlays on (positional words: name, then on).
  await runConsoleLine(page, 'view.overlay voltage true');
  await runConsoleLine(page, 'view.overlay --name current --on true');
  await expect(viewport).toHaveAttribute('data-overlays', 'current voltage');

  await expect
    .poll(async () =>
      (await graph(page))?.leads.map((l) => l.amps !== 'unknown' && l.amps > 0 && l.direction !== 'none'),
    )
    .toEqual([true, true, false]);
  const g = (await graph(page)) as Graph;
  expect(g).toMatchObject({ voltage: true, current: true, inScene: true });
  // dc12 (16 V full scale, 32 bins of 0.5 V): the shorted battery loop gets real colours. Its − terminal
  // is the island reference (0 V, bin 0); its + terminal is the EMF less the internal drop, 9–11 V
  // (bins 18–22: the leads carry about 123 A against 23 mΩ inside); the switch, between two equal
  // leads, sits near half of that.
  const bin = (entity: number, terminal: string) =>
    g.terminals.find((t) => t.entity === entity && t.terminal === terminal)?.volts;
  expect(bin(1, 'neg')).toBe(0);
  expect(bin(1, 'pos')).toEqual(expect.any(Number));
  expect(bin(1, 'pos') as number).toBeGreaterThanOrEqual(18);
  expect(bin(1, 'pos') as number).toBeLessThanOrEqual(22);
  expect(bin(2, 'a')).toEqual(expect.any(Number));
  expect(Math.abs((bin(2, 'a') as number) - (bin(1, 'pos') as number) / 2)).toBeLessThanOrEqual(1);
  expect(
    g.leads
      .slice(0, 2)
      .flatMap((l) => l.volts)
      .every((v) => typeof v === 'number'),
  ).toBe(true);
  // The unwired lamp's island has no source: no scale, never 0 V.
  expect(g.terminals.filter((t) => t.entity === 3).map((t) => t.volts)).toEqual(['noScale', 'noScale']);
  // The mixed island is not solved: no reading on its terminals or its lead, never 0 V or 0 A.
  expect(g.terminals.filter((t) => t.entity >= 4).every((t) => t.volts === 'unknown')).toBe(true);
  expect(g.leads[2]).toMatchObject({
    connection: 3,
    volts: ['unknown', 'unknown'],
    amps: 'unknown',
    direction: 'none',
  });
  // The short runs from the battery's + through lead 1 (pos → switch a) and back through lead 2 (switch b → neg).
  expect(g.leads.slice(0, 2).map((l) => l.direction)).toEqual(['a→b', 'a→b']);

  const legend = page.getByTestId('overlay-legend');
  await expect(legend).toBeVisible();
  await expect(legend.getByRole('heading', { name: 'Voltage overlay' })).toBeVisible();
  await expect(legend.getByTestId('legend-voltage-scale')).toHaveCount(1);
  await expect(legend.getByTestId('legend-voltage-scale')).toContainText('12 V DC');
  await expect(legend.getByTestId('legend-no-scale')).toHaveText(/No nominal band: no voltage scale/);
  await expect(legend.getByTestId('legend-unknown')).toHaveText(/No reading/);
  await expect(legend.getByTestId('legend-current-scale')).toContainText('100 mA');
  await expect(legend.getByTestId('legend-current-motion')).toContainText('Arrows travel with DC current');

  // A third battery (entity 6) lights the lamp: the lamp's island is now dc12 too. The lamp's + end sits
  // at the EMF (12.9 V full) less the drop in the leads and inside at about 0.4 A, so about 12.85 V:
  // coordinate 25.7 on the 16 V scale, bin 25 (24–26 with the half-bin hysteresis and the battery
  // discharging). Nothing drawn is without a scale any more, so the legend drops its no-scale line.
  // The console is still open and focused (the legend checks above don't move focus).
  await runConsoleLine(
    page,
    'entity.place --ref.id battery.ferrovane-12v-7ah --ref.version 1 --positionMm.x 1300 --positionMm.y -300 --positionMm.z 500',
  );
  await runConsoleLine(
    page,
    'lead.connect --ref.id lead.quillfern-test-1m --ref.version 1 --a.entity 6 --a.terminal pos --b.entity 3 --b.terminal a',
  );
  await runConsoleLine(
    page,
    'lead.connect --ref.id lead.quillfern-test-1m --ref.version 1 --a.entity 3 --a.terminal b --b.entity 6 --b.terminal neg',
  );
  await expect
    .poll(async () => (await graph(page))?.terminals.find((t) => t.entity === 3 && t.terminal === 'a')?.volts)
    .toEqual(expect.any(Number));
  const lit = (await graph(page)) as Graph;
  const lampPos = lit.terminals.find((t) => t.entity === 3 && t.terminal === 'a')?.volts as number;
  expect(lampPos).toBeGreaterThanOrEqual(24);
  expect(lampPos).toBeLessThanOrEqual(26);
  expect(lit.terminals.find((t) => t.entity === 6 && t.terminal === 'neg')?.volts).toBe(0);
  await expect(legend.getByTestId('legend-voltage-scale')).toContainText('12 V DC');
  await expect(legend.getByTestId('legend-no-scale')).toBeHidden();

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
