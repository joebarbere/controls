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
  };
};

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
  await page.goto('/?e2e=1&renderer=webgl2');
  await startSandbox(page);
  await expect(page.locator('ctl-viewport')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(page.locator('ctl-dev-console [data-editor="ready"]')).toBeAttached();
  await page.keyboard.press('Backquote');
  await expect(page.getByRole('textbox', { name: 'Console input' })).toBeFocused();

  // Nothing wired yet: no wire group in the scene.
  expect(await wireGraph(page)).toMatchObject({ inScene: false, routes: [] });

  const lines = setupLines();
  for (const [seq, line] of lines.entries()) await runLogged(page, line, seq);
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
  // It still draws (both backends; CI runs this one on WebGL2).
  await page.evaluate(() => (window as unknown as Hooks).__controlsViewport?.afterFrames(2));
});
