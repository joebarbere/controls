import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startSandbox } from './support/sandbox';

/**
 * F2.6 netlist inspector, on the real sim worker: the bench-lamp scenario (F2.5) up to its first
 * `sim.step 1500` (the switch closed, the lamp lit) runs through the console's `run`, then
 * `view.netlistInspector` opens the inspector from the console. Its lamp-branch current must equal
 * the value derived from `game.probe` (I = P / V across the lamp) that `apps/sim-cli/src/bench-lamp.spec.ts`
 * pins under Node in `goldens/inspector/bench-lamp-lit.json`, within the display's rounding (three
 * significant figures). Selecting a node from the keyboard highlights its terminals in 3D. Waits are
 * on the page's state (rows, values, the overlay graph), never on time.
 */

const golden = JSON.parse(
  readFileSync(join(__dirname, '../../sim-cli/src/goldens/inspector/bench-lamp-lit.json'), 'utf8'),
) as { tick: number; lampCurrentA: number };

type Hooks = {
  __controlsViewport?: {
    overlayGraph(): { terminals: { entity: number; terminal: string; highlighted: boolean }[] } | undefined;
  };
};
const highlighted = (page: Page) =>
  page.evaluate(() =>
    ((window as unknown as Hooks).__controlsViewport?.overlayGraph()?.terminals ?? [])
      .filter((t) => t.highlighted)
      .map((t) => `${t.entity}:${t.terminal}`),
  );

const PREFIX: Record<string, number> = { '': 1, m: 1e-3, µ: 1e-6, n: 1e-9, p: 1e-12, k: 1e3, M: 1e6 };
/** `432 mA, a -> b` → 0.432. */
function amps(text: string): number {
  const match = /^([0-9.]+) ([kMmµnp]?)A\b/.exec(text);
  if (!match) throw new Error(`not a current: ${text}`);
  return Number(match[1]) * PREFIX[match[2]];
}

test("the inspector's lamp-branch current equals the game.probe derivation; a node highlights its terminals (F2.6)", async ({
  page,
}) => {
  test.slow(); // software WebGL2 makes each key round trip slow on CI runners
  await page.goto('/?e2e=1&renderer=webgl2');
  await startSandbox(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  await page.keyboard.press('Backquote');
  const input = page.getByRole('textbox', { name: 'Console input' });
  await expect(input).toBeFocused();

  const lines = readFileSync(join(__dirname, '../../sim-cli/scenarios/bench-lamp.console'), 'utf8').split('\n');
  const lit = lines.slice(0, lines.findIndex((l) => l.startsWith('sim.step')) + 1).join('\n');
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.type('run');
  await page.keyboard.press('Enter');
  await (await chooser).setFiles({ name: 'lit.console', mimeType: 'text/plain', buffer: Buffer.from(lit) });
  const output = page.getByTestId('console-output').locator('.entry');
  await expect(output.last()).toHaveText('Ran 8 commands from lit.console.');

  await expect(input).toBeFocused();
  await page.keyboard.insertText('view.netlistInspector');
  await expect(input).toHaveText('view.netlistInspector');
  await page.keyboard.press('Enter');

  const inspector = page.getByRole('region', { name: 'Inspector' });
  const tree = inspector.getByRole('tree', { name: 'Netlist' });
  await expect(tree.getByRole('treeitem').first()).toBeFocused(); // the command focuses the tree
  await expect(inspector.getByTestId('netlist-tick')).toHaveText(`Tick ${golden.tick}`);
  const island = tree.locator('[role="treeitem"][data-kind="island"]').first();
  await expect(island.locator('.value')).toHaveText(/^solved · band dc12$/);

  const lampBranch = tree.locator('[role="treeitem"][data-key="b:e3.filament"]');
  await expect(lampBranch.locator('.value')).toHaveText(/^[0-9.]+ [kMmµnp]?A, (a -> b|b -> a)$/);
  const shown = amps((await lampBranch.locator('.value').textContent()) ?? '');
  // Three significant figures: half a unit in the last place of the derived value.
  const halfUlp = 0.5 * 10 ** (Math.floor(Math.log10(golden.lampCurrentA)) - 2);
  expect(Math.abs(shown - golden.lampCurrentA)).toBeLessThanOrEqual(halfUlp * (1 + 1e-9));

  // Keyboard selection: from the island, Down to Nodes, then the fourth node (1:neg, 1:pos, the
  // closed switch's 2:a 2:b, then 3:a).
  const node = tree.locator('[role="treeitem"][data-key="n:3:a"]');
  await page.keyboard.press('ArrowDown');
  await expect(tree.locator('[role="treeitem"][data-kind="nodes"]').first()).toBeFocused();
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  await expect(node).toBeFocused();
  await expect(node).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => highlighted(page)).toEqual(['3:a']);

  // Run the command again with focus in the inspector: it closes, and the highlight goes with it.
  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  const search = palette.getByRole('combobox', { name: 'Search commands' });
  await expect(search).toBeFocused();
  await page.keyboard.type('Toggle netlist inspector');
  await expect(palette.getByRole('option').first()).toHaveAttribute('data-command', 'view.netlistInspector');
  await page.keyboard.press('Enter');
  await expect(tree).toBeHidden();
  await expect.poll(() => highlighted(page)).toEqual([]);
});
