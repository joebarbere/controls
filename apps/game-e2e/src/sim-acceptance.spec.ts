import { expect, type Locator, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startSandbox } from './support/sandbox';

/**
 * The phase 2 acceptance's in-game demo (plan `phase-2-circuit-engine.md`, "Phase acceptance"), on
 * the real sim worker, with the console and the keyboard only: the bench lamp's devices and leads
 * typed into the console, its current traced from the netlist inspector (T on the lamp's branch),
 * the switch closed with E on the selected switch, time stepped from the console.
 *
 * - **Lit:** the lamp is drawn bright (its drawn level follows the solved `lightOutputRel`), and the
 *   trace the UI received shows the cold-filament inrush: its peak, at the switch's own tick, is
 *   10–15× the settled current (the band the lamp's `inrush-band` source gives).
 * - **Out:** E again opens the switch; the lamp is drawn dark and its traced current is 0 A.
 * - **The same world:** every action is one logged command, the ones
 *   `apps/sim-cli/scenarios/bench-lamp.console` runs, so `world.hash` and the snapshot hash reach the
 *   literals `apps/sim-cli/src/bench-lamp.spec.ts` pins under Node (and `bench-lamp.spec.ts` here).
 *   Tracing and the inspector are view state: nothing about them is logged or hashed.
 *
 * Both transports. Every wait is on the page's state (entries, the trace's ticks, the drawn lamp).
 */
test.use({ viewport: { width: 1280, height: 720 } });

const BENCH_LAMP_LIT_HASH = 'ed42d957348f2c2f79aad6ed892228a20e59bb543ba3e348399595c37d7b3fbc';
const BENCH_LAMP_LIT_SNAPSHOT_HASH = '52010da7436ce267029b58a73aadc43c6e3ddb4ca0db17f1c3a3bf695b9fd517';
const BENCH_LAMP_HASH = '0b533c942486866c3d8757b94dfdb6c2d891f66ae0401f97a96aac4d1ea6cb28';
const BENCH_LAMP_SNAPSHOT_HASH = 'd5bbbaaf731e59d67fd7a1e459504f9198a7d5d563d0ef0f1a52cb7e010ac11f';
/** The lamp's `inrush-band` source: the inrush is 10 to 15 times the settled current. */
const INRUSH_BAND = { min: 10, max: 15 };
/** The last cadence solve before tick 1500 (SOLVE_INTERVAL_TICKS = 10), and before 2000. */
const LIT_LAST_SOLVE = 1490;
const OUT_LAST_SOLVE = 1990;

type Trace = { target: unknown; samples: number[] };
type SceneNode = { name: string; lamp?: { level: number; status: string }; children?: SceneNode[] };
type Hooks = {
  __controlsSession?: {
    hash(): Promise<string>;
    snapshotHash(): Promise<string>;
    waitForTick(tick: number): Promise<void>;
    simStats(): { misses: number; transport: string | null };
    entries(): ReadonlyArray<{ id: string; tick: number; args: unknown }>;
    traces(): Trace[];
  };
  __controlsViewport?: { select(id: string | null): boolean; sceneGraph(): SceneNode | undefined };
};

const entries = (page: Page) =>
  page.evaluate(() => (window as unknown as Hooks).__controlsSession?.entries().map((e) => ({ ...e })) ?? []);
const traces = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__controlsSession?.traces() ?? []);
const lampLevel = (page: Page) =>
  page.evaluate(() => {
    const find = (node: SceneNode | undefined): SceneNode | undefined =>
      node === undefined
        ? undefined
        : node.name === 'entity-3'
          ? node
          : (node.children ?? []).map(find).find((n) => n !== undefined);
    return find((window as unknown as Hooks).__controlsViewport?.sceneGraph())?.lamp ?? null;
  });

/** The lamp trace's (tick, value) pairs, once the UI has received samples up to `tick`. */
async function lampTrace(page: Page, tick: number): Promise<[number, number][]> {
  await expect
    .poll(async () => {
      const [trace] = await traces(page);
      return trace === undefined ? -1 : Math.max(-1, ...trace.samples.filter((_, i) => i % 2 === 0));
    })
    .toBeGreaterThanOrEqual(tick);
  const [trace] = await traces(page);
  const pairs: [number, number][] = [];
  // NaN (no reading) crosses page.evaluate as null.
  for (let i = 0; i < trace.samples.length; i += 2) pairs.push([trace.samples[i], trace.samples[i + 1] ?? Number.NaN]);
  return pairs;
}

const lastOutput = (page: Page) => page.getByTestId('console-output').locator('.entry').last();

async function typeLine(page: Page, line: string): Promise<void> {
  await page.keyboard.insertText(line);
  await page.keyboard.press('Enter');
}

async function openConsole(page: Page): Promise<void> {
  await page.keyboard.press('Backquote');
  await expect(page.getByRole('textbox', { name: 'Console input' })).toBeFocused();
}

/** The scenario's setup lines: everything before its first `device.operate`. */
function setupLines(): string[] {
  const lines = readFileSync(join(__dirname, '../../sim-cli/scenarios/bench-lamp.console'), 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
  return lines.slice(
    0,
    lines.findIndex((line) => line.startsWith('device.operate')),
  );
}

async function pressE(page: Page, canvas: Locator, tick: number, value: boolean): Promise<void> {
  await expect(canvas).toBeFocused();
  const before = (await entries(page)).length;
  await page.keyboard.press('KeyE');
  await expect.poll(async () => (await entries(page)).length).toBe(before + 1);
  expect((await entries(page)).at(-1)).toMatchObject({
    id: 'device.operate',
    tick,
    args: { id: 2, control: 'closed', value },
  });
}

for (const { transport, query } of [
  { transport: 'sab', query: '' },
  { transport: 'message', query: '&sab=0' },
] as const) {
  test(`phase 2 acceptance (${transport}): the bench lamp lights with its inrush on the trace and goes out, at the sim-cli hashes`, async ({
    page,
  }) => {
    test.slow(); // software WebGL2 makes each key round trip slow on CI runners
    await page.goto(`/?e2e=1&renderer=webgl2${query}`);
    await startSandbox(page);
    const viewport = page.locator('ctl-viewport');
    const canvas = page.locator('ctl-viewport canvas');
    await expect(viewport).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
    await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();

    // The console: three devices and three leads, then the netlist inspector.
    await openConsole(page);
    const setup = setupLines();
    expect(setup).toHaveLength(6);
    for (const line of setup) {
      await typeLine(page, line);
      await expect(lastOutput(page)).toHaveText(/: ok/);
    }
    await typeLine(page, 'view.netlistInspector');
    const inspector = page.getByRole('region', { name: 'Inspector' });
    const tree = inspector.getByRole('tree', { name: 'Netlist' });
    await expect(tree.getByRole('treeitem').first()).toBeFocused();

    // T on the lamp's branch traces its current (view state: nothing logged).
    const logged = (await entries(page)).length;
    const lampBranch = tree.locator('[role="treeitem"][data-key="b:e3.filament"]');
    await lampBranch.focus();
    await page.keyboard.press('KeyT');
    await expect(lampBranch).toHaveAttribute('data-traced', '');
    await expect(inspector.getByTestId('trace-plot')).toBeVisible();
    expect(await traces(page)).toMatchObject([
      { target: { kind: 'branch', element: { kind: 'entity', entity: 3, part: 'filament' } } },
    ]);

    // E on the selected switch closes it.
    await page.keyboard.press('Backquote'); // the console closes
    await canvas.focus();
    expect(await page.evaluate(() => (window as unknown as Hooks).__controlsViewport?.select('entity-2'))).toBe(true);
    await expect(viewport).toHaveAttribute('data-selected', 'entity-2');
    await pressE(page, canvas, 0, true);
    expect((await entries(page)).length).toBe(logged + 1);

    await openConsole(page);
    await typeLine(page, 'sim.step 1500');
    await typeLine(page, 'world.hash');
    await expect(lastOutput(page)).toHaveText(BENCH_LAMP_LIT_HASH);
    expect(await page.evaluate(() => (window as unknown as Hooks).__controlsSession?.snapshotHash())).toBe(
      BENCH_LAMP_LIT_SNAPSHOT_HASH,
    );
    await page.evaluate(() => (window as unknown as Hooks).__controlsSession?.waitForTick(1500));

    // Lit: drawn above the rated level (light ≈ 1.25 of rated; 204 of 255 is rated).
    await expect.poll(async () => (await lampLevel(page))?.level ?? 0).toBeGreaterThan(204);
    expect(await lampLevel(page)).toMatchObject({ status: 'solved' });

    // The trace the UI received: the inrush peak at the switch's tick, 10–15× the settled current.
    const lit = (await lampTrace(page, LIT_LAST_SOLVE)).filter(([, v]) => Number.isFinite(v));
    const peak = Math.max(...lit.map(([, v]) => v));
    const [peakTick] = lit.find(([, v]) => v === peak) as [number, number];
    const settled = lit[lit.length - 1][1];
    expect(peakTick).toBe(0);
    expect(peak / settled).toBeGreaterThanOrEqual(INRUSH_BAND.min);
    expect(peak / settled).toBeLessThanOrEqual(INRUSH_BAND.max);
    // Settled: the last 100 ms move by under 0.1 %.
    const tail = lit.filter(([t]) => t >= 1400).map(([, v]) => v);
    expect((Math.max(...tail) - Math.min(...tail)) / settled).toBeLessThan(1e-3);
    // And the plot says so.
    await expect(inspector.getByTestId('trace-summary')).toHaveText(
      /^Peak [0-9.]+ A at 0\.000 s; last solve at [0-9.]+ s: [0-9.]+ mA\.$/,
    );

    // E again opens it: the lamp goes out.
    await page.keyboard.press('Backquote');
    await expect(canvas).toBeFocused();
    await pressE(page, canvas, 1500, false);
    await openConsole(page);
    await typeLine(page, 'sim.step 500');
    await typeLine(page, 'world.hash');
    await expect(lastOutput(page)).toHaveText(BENCH_LAMP_HASH);
    expect(await page.evaluate(() => (window as unknown as Hooks).__controlsSession?.hash())).toBe(BENCH_LAMP_HASH);
    expect(await page.evaluate(() => (window as unknown as Hooks).__controlsSession?.snapshotHash())).toBe(
      BENCH_LAMP_SNAPSHOT_HASH,
    );
    await page.evaluate(() => (window as unknown as Hooks).__controlsSession?.waitForTick(2000));
    await expect.poll(() => lampLevel(page)).toMatchObject({ status: 'solved', level: 0 });
    const out = (await lampTrace(page, OUT_LAST_SOLVE)).filter(([t]) => t >= 1500);
    expect(out[0]).toEqual([1500, 0]); // the switch's own solve: no current at once
    expect(out.every(([, v]) => v === 0)).toBe(true);

    // The log is the scenario's: the inspector and the trace logged nothing.
    expect((await entries(page)).map((e) => `${e.id}@${e.tick}`)).toEqual([
      'entity.place@0',
      'entity.place@0',
      'entity.place@0',
      'lead.connect@0',
      'lead.connect@0',
      'lead.connect@0',
      'device.operate@0',
      'sim.step@0',
      'device.operate@1500',
      'sim.step@1500',
    ]);
    expect(await page.evaluate(() => (window as unknown as Hooks).__controlsSession?.simStats())).toMatchObject({
      misses: 0,
      transport,
    });
  });
}
