import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startSandbox } from './support/sandbox';

/**
 * F3.6 part 3 (protocol 7, plan D16): `wire.info <id>` and the netlist inspector's connection rows on
 * the real sim worker. The bad-termination scenario (a 20 %-torque breaker screw on 14 AWG THHN, 600 s
 * at about 11.8 A) runs through the in-game console's `run`. Then:
 *
 * - `wire.info 2` and `wire.info 3`, from the worker's export materialised and formatted on the page's
 *   main thread in Chromium, equal byte for byte the golden `apps/sim-cli/src/bad-termination.spec.ts`
 *   pins under Node (`apps/sim-cli/src/goldens/wire-info/bad-termination.txt`), through the session
 *   hook and typed into the console (one output line per text line, nothing logged);
 * - the inspector's branch row for the loose conductor shows its record's drops and temperatures, read
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
  await expect(output.last()).toHaveText('Ran 10 commands from bad-termination.console.', { timeout: 60_000 });

  // Through the session hook: the worker's export, formatted on the main thread.
  const hooked = await page.evaluate(async () => {
    const session = (window as unknown as Hooks).__controlsSession;
    if (!session) throw new Error('session hook missing');
    return `${await session.wireInfo(2)}${await session.wireInfo(3)}`;
  });
  expect(hooked).toBe(GOLDEN);

  // Typed: one output entry per line, and nothing logged.
  const logged = await loggedEntries(page);
  const before = await output.count();
  await expect(input).toBeFocused();
  await page.keyboard.insertText('wire.info 2');
  await page.keyboard.press('Enter');
  const lines = GOLDEN.split('wire.info 3')[0].trimEnd().split('\n');
  await expect(output.last()).toHaveText(lines.at(-1) as string);
  const shown = (await output.allTextContents()).slice(before).map((t) => t.trim());
  expect(shown).toEqual(['> wire.info 2', ...lines]);
  expect(await loggedEntries(page)).toBe(logged);

  // The inspector's row for the loose conductor's branch: the record's drops and temperatures.
  await page.keyboard.insertText('view.netlistInspector');
  await page.keyboard.press('Enter');
  const tree = page.getByRole('region', { name: 'Inspector' }).getByRole('tree', { name: 'Netlist' });
  await expect(tree.getByRole('treeitem').first()).toBeFocused();
  const wire = tree.locator('[role="treeitem"][data-key="b:c2"]');
  // The golden's 0.2011 V, 303.033 K; end a 0.300478 V, 393.822 K; end b 0.00610151 V, 301.709 K.
  await expect(wire.getByTestId('connection-detail')).toHaveText(
    'drop 201 mV, 303 K, end a 300 mV, 394 K, end b 6.10 mV, 302 K',
  );
  const lead = tree.locator('[role="treeitem"][data-key="b:c3"]');
  await expect(lead.getByTestId('connection-detail')).toHaveText('drop 507 mV, 317 K'); // a lead's ends: none
});
