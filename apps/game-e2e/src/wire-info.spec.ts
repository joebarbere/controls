import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startSandbox } from './support/sandbox';

/**
 * F3.6 part 3 (protocol 7, plan D16): `wire.info <id>` and the netlist inspector's connection rows on
 * the real sim worker. The bad-termination scenario (the P3 acceptance's lamp circuit with a 20 %-torque
 * breaker screw on its 14 AWG THHN jumper, plus the 1500 W heater: 600 s at about 12.84 A) runs through
 * the in-game console's `run`. Then:
 *
 * - `wire.info 1` (the jumper) and `wire.info 2` (cable 1's black), from the worker's export materialised and formatted on the page's
 *   main thread in Chromium, equal byte for byte the golden `apps/sim-cli/src/bad-termination.spec.ts`
 *   pins under Node (`apps/sim-cli/src/goldens/wire-info/bad-termination.txt`), through the session
 *   hook and typed into the console (one output line per text line, nothing logged);
 * - the inspector's branch rows for the loose conductor and the cable conductor show its record's drops and temperatures, read
 *   from the worker's snapshot (`NetlistReadout`), the golden's values to three figures.
 *
 * Change the golden in sim-cli (`pnpm nx test sim-cli -u`), never here alone.
 */

const GOLDEN = readFileSync(join(__dirname, '../../sim-cli/src/goldens/wire-info/bad-termination.txt'), 'utf8');

type Hooks = {
  __controlsSession?: { wireInfo(id: number): Promise<string>; entries(): readonly unknown[] };
};
const loggedEntries = (page: Page) =>
  page.evaluate(() => (window as unknown as Hooks).__controlsSession?.entries().length ?? -1);

test('wire.info and the inspector show the bad termination as sim-cli does (F3.6 part 3)', async ({ page }) => {
  test.slow(); // 600 s of sim time in the worker, then software WebGL2 key round trips
  await page.goto('/?e2e=1&renderer=webgl2');
  await startSandbox(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
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

  // Through the session hook: the worker's export, formatted on the main thread.
  const hooked = await page.evaluate(async () => {
    const session = (window as unknown as Hooks).__controlsSession;
    if (!session) throw new Error('session hook missing');
    return `${await session.wireInfo(1)}${await session.wireInfo(2)}`;
  });
  expect(hooked).toBe(GOLDEN);

  // Typed: one output entry per line, and nothing logged.
  const logged = await loggedEntries(page);
  const before = await output.count();
  await expect(input).toBeFocused();
  await page.keyboard.insertText('wire.info 1');
  await page.keyboard.press('Enter');
  const lines = GOLDEN.split('wire.info 2')[0].trimEnd().split('\n');
  await expect(output.last()).toHaveText(lines.at(-1) as string);
  const shown = (await output.allTextContents()).slice(before).map((t) => t.trim());
  expect(shown).toEqual(['> wire.info 1', ...lines]);
  expect(await loggedEntries(page)).toBe(logged);

  // The inspector's row for the loose conductor's branch: the record's drops and temperatures.
  await page.keyboard.insertText('view.netlistInspector');
  await page.keyboard.press('Enter');
  const tree = page.getByRole('region', { name: 'Inspector' }).getByRole('tree', { name: 'Netlist' });
  await expect(tree.getByRole('treeitem').first()).toBeFocused();
  const wire = tree.locator('[role="treeitem"][data-key="b:c1"]');
  // The golden's 0.0174541 V, 304.613 K; end a 0.319754 V, 409.285 K; end b 0.00402135 V, 297.839 K;
  // its insulation damaged (the loose end passed 403.15 K).
  await expect(wire.getByTestId('connection-detail')).toHaveText(
    'drop 17.5 mV, 305 K, end a 320 mV, 409 K, end b 4.02 mV, 298 K, insulation damaged',
  );
  // Cable 1's black: 0.25603 V, 304.613 K; end a 0.00392223 V, 297.804 K; end b 0.00667298 V, 303.192 K.
  const cable = tree.locator('[role="treeitem"][data-key="b:c2"]');
  await expect(cable.getByTestId('connection-detail')).toHaveText(
    'drop 256 mV, 305 K, end a 3.92 mV, 298 K, end b 6.67 mV, 303 K',
  );
});
