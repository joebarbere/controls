import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLogged } from './support/console';
import { startSandbox } from './support/sandbox';

/**
 * F3.2 part 2: the wire renderer draws what is wired. The bad-termination scenario's split-phase
 * stand-in, breaker and wire nut, and its two 14 AWG THHN conductors (typed into the in-game console,
 * the same lines `apps/sim-cli/scenarios/bad-termination.console` runs), are drawn from the domain
 * bake as instanced segments; `wire.label` puts sleeve markers on one and `wire.delete` takes the
 * other away. Read through the renderer's `?e2e=1` hook (`wireGraph`, `sceneGraph`), never pixels.
 */

type Route = { owner: string; look: string; colour: string; segments: number; label: string | null };
type WireGraph = { inScene: boolean; routes: Route[]; sleeves: number; looks: { look: string; instances: number }[] };
type SceneNode = { name: string; wires?: { instances: number; look?: string }; children?: SceneNode[] };
type Hooks = {
  __controlsViewport?: {
    wireGraph(): WireGraph | undefined;
    sceneGraph(): SceneNode | undefined;
    afterFrames(n: number): Promise<void>;
    stats(): { drawCalls: number };
    memory(): { geometries: number; attributes: number; attributesSize: number } | undefined;
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

/** Draws two frames, then reads the renderer's GPU memory counters. */
const memoryAfterFrames = (page: Page) =>
  page.evaluate(async () => {
    const hook = (window as unknown as Hooks).__controlsViewport;
    await hook?.afterFrames(2);
    return hook?.memory();
  });

/** Opens a sandbox on WebGL2 (what CI runs) with the console focused. */
async function openSandboxConsole(page: Page): Promise<void> {
  await page.goto('/?e2e=1&renderer=webgl2');
  await startSandbox(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  await page.keyboard.press('Backquote');
  await expect(page.getByRole('textbox', { name: 'Console input' })).toBeFocused();
}

const wireGraph = (page: Page) =>
  page.evaluate(() => (window as unknown as Hooks).__controlsViewport?.wireGraph() ?? null);

/** The scenario's lines up to and including its second `wire.add`, comments stripped. */
function setupLines(): string[] {
  const file = readFileSync(join(__dirname, '../../sim-cli/scenarios/bad-termination.console'), 'utf8');
  const lines = file
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
  const wires = lines.flatMap((line, i) => (line.startsWith('wire.add') ? [i] : []));
  return lines.slice(0, wires[1] + 1);
}

test('routed conductors are drawn from the bake, labelled with sleeves, and removed with the wire (F3.2 part 2)', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openSandboxConsole(page);
  const drawCalls = async () => {
    await page.evaluate(() => (window as unknown as Hooks).__controlsViewport?.afterFrames(2));
    return page.evaluate(() => (window as unknown as Hooks).__controlsViewport?.stats().drawCalls ?? 0);
  };

  // Nothing wired yet: no wire group in the scene.
  expect(await wireGraph(page)).toMatchObject({ inScene: false, routes: [] });

  const lines = setupLines();
  const places = lines.findIndex((line) => line.startsWith('wire.add'));
  for (const [seq, line] of lines.slice(0, places).entries()) await runLogged(page, line, seq);
  const unwiredDraws = await drawCalls();
  for (const [seq, line] of lines.entries()) if (seq >= places) await runLogged(page, line, seq);
  await expect
    .poll(async () => (await wireGraph(page))?.routes.map((r) => [r.owner, r.look, r.colour]))
    .toStrictEqual([
      ['c1', 'thhnThwn2', '#1c1c1c'],
      ['c2', 'thhnThwn2', '#1c1c1c'],
    ]);
  const graph = (await wireGraph(page)) as WireGraph;
  expect(graph.inScene).toBe(true);
  // One instanced mesh for both wires: draws follow looks, not wires.
  expect(graph.looks.map((l) => [l.look, l.instances])).toStrictEqual([
    ['thhnThwn2', graph.routes[0].segments + graph.routes[1].segments],
  ]);
  const scene = await page.evaluate(() => (window as unknown as Hooks).__controlsViewport?.sceneGraph());
  const wiresNode = scene?.children?.find((n) => n.name === 'wires');
  expect(wiresNode?.children?.map((c) => [c.name, c.wires?.look])).toStrictEqual([['wires:thhnThwn2', 'thhnThwn2']]);

  // A printed sleeve marker on wire 2: two sleeves, the text as data.
  let seq = lines.length;
  await runLogged(page, 'wire.label 2 --text K1-13 --tool.id tool.penmarrow-lp-12 --tool.version 1', seq++);
  await expect.poll(async () => (await wireGraph(page))?.sleeves).toBe(2);
  expect((await wireGraph(page))?.routes.map((r) => r.label)).toStrictEqual([null, 'K1-13']);

  // Deleting wire 1 takes its segments away; the label stays with wire 2.
  await runLogged(page, 'wire.delete 1', seq++);
  await expect.poll(async () => (await wireGraph(page))?.routes.map((r) => r.owner)).toStrictEqual(['c2']);
  expect((await wireGraph(page))?.sleeves).toBe(2);
  // It still draws (CI runs this on WebGL2): one more draw for the wires, at least, and nothing went wrong.
  expect(await drawCalls()).toBeGreaterThanOrEqual(unwiredDraws + 1);
  expect(errors).toStrictEqual([]);
});

/**
 * Disposal on the GPU (test-engineer review). Two long zigzag wires: the first grows the THHN pool past
 * 1 024 instances, where three r186 draws instances from interleaved vertex attributes (above the
 * uniform-buffer limit), and is drawn; the second makes the pool rebuild (double) again, replacing that
 * drawn mesh. Those attributes are freed only when the replaced mesh's own geometry is disposed (a
 * geometry shared between successive meshes leaked them). Then both wires are deleted, and the
 * renderer's attribute count and bytes must be back at the baseline. Twice, so a leak per cycle shows.
 */
test('a pool’s instance buffers are freed on rebuild and delete: GPU attributes back to baseline, twice (F3.2 part 2)', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openSandboxConsole(page);
  const lines = setupLines();
  const wireLines = lines.filter((line) => line.startsWith('wire.add'));
  const places = lines.slice(0, lines.indexOf(wireLines[0]));
  for (const [seq, line] of places.entries()) await runLogged(page, line, seq);
  // Forty free waypoints zigzagging 600 mm across: 41 sagging spans of up to 32 segments each.
  const zigzag = (y0: number) =>
    Array.from({ length: 40 }, (_, i) => ({
      kind: 'free',
      positionMm: { x: i % 2 === 0 ? 200 : 800, y: y0 + 20 * i, z: 0 },
      entity: null,
      fixture: null,
      tool: null,
    }));
  const long = (line: string, y0: number) => {
    const out = line.replace(/--route \[.*?\] --lengthMm/, `--route ${JSON.stringify(zigzag(y0))} --lengthMm`);
    expect(out).not.toBe(line);
    return out;
  };
  const baseline = await memoryAfterFrames(page);
  expect(baseline?.attributes).toBeGreaterThan(0);
  const instances = async () => (await wireGraph(page))?.looks[0]?.instances ?? 0;
  let seq = places.length;
  let id = 1;
  for (let cycle = 1; cycle <= 2; cycle++) {
    await runLogged(page, long(wireLines[0], 800), seq++);
    await expect.poll(instances).toBeGreaterThan(1024);
    const one = await memoryAfterFrames(page); // the large mesh is drawn
    await runLogged(page, long(wireLines[1], 2000), seq++);
    await expect.poll(instances).toBeGreaterThan(2048); // the pool doubled: the drawn mesh was replaced
    const two = await memoryAfterFrames(page);
    expect(two?.attributesSize).toBeGreaterThan(one?.attributesSize ?? 0);
    await runLogged(page, `wire.delete ${id++}`, seq++);
    await runLogged(page, `wire.delete ${id++}`, seq++);
    await expect.poll(async () => (await wireGraph(page))?.routes.length).toBe(0);
    await expect.poll(() => memoryAfterFrames(page)).toStrictEqual(baseline);
  }
  expect(errors).toStrictEqual([]);
});
