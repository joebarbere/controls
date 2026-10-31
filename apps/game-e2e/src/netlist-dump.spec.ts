import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startSandbox } from './support/sandbox';

/**
 * F2.6: `netlist.dump` gives the same text in the game as headless. Each bench scenario runs through
 * the in-game console's `run` (the engine in the sim worker); the dump, from the worker's export
 * materialised and dumped on the page's main thread in Chromium, must equal byte for byte the golden
 * `apps/sim-cli/src/netlist-dump.spec.ts` pins under Node (`apps/sim-cli/src/goldens/netlist-dump/`).
 * Change them together: re-pin with `pnpm nx test sim-cli -u`, never here alone.
 */

const SCENARIOS = [
  { name: 'bench-leads', commands: 11 },
  { name: 'sim-step', commands: 7 },
  { name: 'sources', commands: 10 },
  { name: 'mains', commands: 4 },
  { name: 'bench-lamp', commands: 10 },
] as const;

const golden = (name: string) =>
  readFileSync(join(__dirname, '../../sim-cli/src/goldens/netlist-dump', `${name}.txt`), 'utf8');

type Hooks = { __controlsSession?: { netlistDump(): Promise<string>; entries(): readonly unknown[] } };
const loggedEntries = (page: Page) =>
  page.evaluate(() => (window as unknown as Hooks).__controlsSession?.entries().length ?? -1);

async function runScenario(page: Page, name: string, commands: number): Promise<void> {
  await page.goto('/?e2e=1&renderer=webgl2');
  await startSandbox(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  await page.keyboard.press('Backquote');
  await expect(page.getByRole('textbox', { name: 'Console input' })).toBeFocused();
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.type('run');
  await page.keyboard.press('Enter');
  const text = readFileSync(join(__dirname, '../../sim-cli/scenarios', `${name}.console`));
  await (await chooser).setFiles({ name: `${name}.console`, mimeType: 'text/plain', buffer: text });
  await expect(page.getByTestId('console-output').locator('.entry').last()).toHaveText(
    `Ran ${commands} command${commands === 1 ? '' : 's'} from ${name}.console.`,
  );
}

for (const { name, commands } of SCENARIOS) {
  test(`netlist.dump after ${name} matches sim-cli's golden byte for byte (F2.6)`, async ({ page }) => {
    await runScenario(page, name, commands);
    const dump = await page.evaluate(() => {
      const session = (window as unknown as Hooks).__controlsSession;
      if (!session) throw new Error('session hook missing');
      return session.netlistDump();
    });
    expect(dump).toBe(golden(name));
  });
}

test('typing netlist.dump prints the golden one line per entry, and logs nothing (F2.6)', async ({ page }) => {
  await runScenario(page, 'sim-step', 7);
  const output = page.getByTestId('console-output').locator('.entry');
  const before = await output.count();
  const logged = await loggedEntries(page);
  await page.keyboard.type('netlist.dump');
  await page.keyboard.press('Enter');
  const lines = golden('sim-step').trimEnd().split('\n');
  await expect(output.last()).toHaveText(lines.at(-1) as string);
  const shown = (await output.allTextContents()).slice(before).map((t) => t.trim());
  expect(shown).toEqual(['> netlist.dump', ...lines]);
  expect(await loggedEntries(page)).toBe(logged);
});
